import { createHash } from "node:crypto";
import { z } from "zod";
import { id, now } from "../database";
import { AppError, safeMessage } from "../errors";
import { parseShare } from "../links";
import type { Repository } from "../repository";
import type { SecretStore } from "../secrets";
import type { AiService } from "../ai";
import type { WebsiteAccounts } from "../website-accounts";
import type {
  ResourceCopy,
  ResourceInput,
  ShareCheck,
} from "../../shared/types";
import { smzdmSourceSchema, type SmzdmResourceLink } from "../../shared/smzdm";
import {
  wechatArticleUrl,
  wechatTextInput,
  type WechatArticle,
  type WechatDetail,
  type WechatDraftPayload,
  type WechatDraftReceipt,
  type WechatImageGenerationMode,
  type WechatPort,
  type WechatRegenerateImagesInput,
  type WechatRegenerateImagesResult,
  type WechatText,
  type WechatEditionSummary,
  type WechatDeliveryRecord,
  type WechatRemote,
  wechatTargetReceipt,
} from "../../shared/wechat";
import {
  isWechatImageUrl,
  wechatArticleImages,
  wechatHtml,
  linkifyWechatMarkdown,
} from "../../shared/wechat-markup";
import {
  resolveWechatReadMore,
  type WechatReadMoreEntry,
} from "../../shared/wechat-read-more";
import type { ResourceLinks } from "../resource-links";
import { wechatTypesettingVersion } from "../../shared/wechat-typesetting";
import { wechatTemplateIds } from "../../shared/wechat-templates";
import {
  articleLinks,
  articleLinkOccurrences,
  formatArticle,
  replaceArticleLinks,
} from "../smzdm/content";
import { readContentImage, saveContentImage } from "../content-assets";
import {
  defaultWechatRewriteStyle,
  type WechatRewriteStyleId,
} from "../../shared/wechat-rewrite";
import { wechatRewriteInstruction } from "./rewrite-styles";
import {
  prepareWechatRewriteLayout,
  wechatRewriteLayout,
  formatWechatRewriteBody,
} from "./rewrite-layout";
import {
  wechatTitleIdentity,
  wechatTitleInstruction,
  wechatTitleResponse,
} from "./title-candidates";
import { RuntimeLog } from "../runtime-log";
import { wechatArticleFamilies, wechatSourceIdentity } from "./article-family";
import type { AppPorts } from "../ports";
import { WechatDiscovery } from "./discovery";
import { wechatImagePrompt } from "./image-prompts";
import {
  wechatTrafficWordsInput,
  wechatTrafficWordUsage,
} from "../../shared/wechat-traffic-words";
import {
  recordWechatTrafficWords,
  wechatTrafficWordPlan,
} from "./traffic-word-history";
import {
  checkRewriteText,
  restoreWechatRewrite,
  wechatRewriteBody,
  wechatRewriteResponse,
  unfinishedWechatRewriteIds,
} from "./rewrite-body";

interface Dependencies {
  repo: Repository;
  secrets: SecretStore;
  ai: AiService;
  accounts: WebsiteAccounts;
  port?: WechatPort;
  dataPath: string;
  readImage?(): Promise<{ name: string; bytes: Buffer } | null>;
  readRemoteImage?(url: string): Promise<{ bytes: Buffer }>;
  discoveryFetch?: AppPorts["wechatDiscoveryFetch"];
  generateImage(bytes: Buffer, prompt: string): Promise<Buffer>;
  generateThemeImage(prompt: string): Promise<Buffer>;
  saveResource(
    input: ResourceInput,
  ): Promise<{ resourceId: string; copyId: string }>;
  assertOwnCopy(copy: ResourceCopy): unknown;
  checkShare(copyId: string): Promise<ShareCheck>;
  environmentStamp(accountId: string): unknown;
  resourcePublishedUrls?(
    resourceId: string,
  ): ReturnType<ResourceLinks["publishedUrls"]>;
  changed(): void;
}
const indexKey = "wechat:articles:v1";
const articleKey = (id: string) => `wechat:article:v1:${id}`;
const draftIdentifier = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,100}$/, "微信草稿标识不正确");
/** Owns local drafts and a draft-only remote handoff; never publishes or mass sends. */
export class WechatArticles {
  private active = new Set<string>();
  private closed = false;
  private readonly logs: RuntimeLog;
  readonly discovery: WechatDiscovery;
  constructor(private d: Dependencies) {
    this.discovery = new WechatDiscovery({
      db: d.repo.db,
      secrets: d.secrets,
      request: d.discoveryFetch,
    });
    this.logs = new RuntimeLog(d.repo.db, d.dataPath, "wechat");
    for (const article of this.articles()) {
      if (
        (article.stage === "sending" || article.stage === "uncertain") &&
        article.pendingAccount &&
        article.pendingDraft &&
        this.hasSuccessfulReceipt(article)
      ) {
        this.confirmDelivery(
          article,
          article.pendingAccount,
          article.pendingDraft,
        );
        continue;
      }
      if (article.stage !== "sending") continue;
      article.stage = "uncertain";
      article.message =
        "上次保存微信草稿被中断，请先在微信后台核对，避免重复建稿。";
      this.persist(article);
    }
  }
  get isBusy() {
    return this.active.size > 0 || this.discovery.isBusy;
  }
  close() {
    this.closed = true;
    this.discovery.close();
  }
  private articles() {
    return this.d.repo.db
      .setting<string[]>(indexKey, [])
      .map((id) => this.load(id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  list() {
    const articles = this.articles();
    const metadata = new Map<
      string,
      { materialId: string; editionNumber: number }
    >();
    for (const family of wechatArticleFamilies(articles).values())
      family.forEach((article, index) =>
        metadata.set(article.id, {
          materialId: family[0].id,
          editionNumber: index + 1,
        }),
      );
    return articles.map(
      ({
        id,
        title,
        stage,
        updatedAt,
        revision,
        remote,
        rewriteStyleId,
        edition,
        source,
      }) => ({
        id,
        title,
        stage,
        updatedAt,
        revision,
        rewriteStyleId,
        edition,
        sourceTitle: source.title,
        ...metadata.get(id)!,
        sentRevision: remote?.revision ?? null,
      }),
    );
  }
  private load(id: string): WechatArticle {
    const article = this.d.repo.db.setting<WechatArticle | null>(
      articleKey(id),
      null,
    );
    if (!article)
      throw new AppError("WECHAT_NOT_FOUND", "公众号草稿不存在，请刷新列表。");
    return article;
  }
  private persist(article: WechatArticle) {
    if (this.closed)
      throw new AppError("WECHAT_CLOSED", "工作空间已关闭，未保存到其他空间。");
    article.updatedAt = now();
    this.d.repo.db.setSetting(articleKey(article.id), article);
    this.d.changed();
  }
  private editable(article: WechatArticle) {
    if (this.closed || this.active.has(article.id))
      throw new AppError("WECHAT_BUSY", "草稿正在处理，请等待当前操作完成。");
    if (article.stage === "sending" || article.stage === "uncertain")
      throw new AppError(
        "WECHAT_UNCERTAIN",
        "请先核对微信草稿保存结果，再继续编辑或发送。",
      );
  }
  private assertRevision(article: WechatArticle, revision: number) {
    if (article.revision !== revision)
      throw new AppError(
        "WECHAT_VERSION_CHANGED",
        "草稿已在其他窗口更新。请先保存待保留内容并刷新，未覆盖较新版本。",
      );
  }
  private revised(article: WechatArticle) {
    article.revision++;
    article.stage = "editing";
    article.message = article.remote
      ? "本地稿已更新，再次发送将更新原微信草稿。"
      : "本地稿已保存，可继续编辑后发送到微信草稿箱。";
  }
  private editionHistory(article: WechatArticle): WechatEditionSummary[] {
    const family = wechatArticleFamilies(this.articles()).get(
      wechatSourceIdentity(article.source.url),
    )!;
    return family
      .map((item, index) => ({
        id: item.id,
        number: index + 1,
        title: item.title,
        stage: item.stage,
        rewriteStyleId: item.rewriteStyleId,
        deliveries: item.deliveryHistory?.length
          ? item.deliveryHistory
          : item.remote
            ? [
                {
                  ...item.remote,
                  title: "",
                  accountName: this.accountName(item.remote.accountId),
                  action: "saved" as const,
                },
              ]
            : [],
      }))
      .sort((a, b) => b.number - a.number);
  }
  private accountName(accountId: string) {
    try {
      const account = this.d.accounts.get(accountId);
      return account.nickname || account.alias;
    } catch {
      return "原公众号";
    }
  }
  private recordDelivery(
    article: WechatArticle,
    action: WechatDeliveryRecord["action"],
  ) {
    const previous =
      this.editionHistory(article).find((item) => item.id === article.id)
        ?.deliveries ?? [];
    article.deliveryHistory = [
      ...previous,
      {
        ...article.remote!,
        title: article.title,
        accountName: this.accountName(article.remote!.accountId),
        rewriteStyleId: article.rewriteStyleId,
        action,
      },
    ];
  }
  markPublished(
    id: string,
    sentRevision: number,
    published: boolean,
    accountId?: string,
  ) {
    const article = this.load(id);
    this.editable(article);
    const history = this.editionHistory(article).find(
      (item) => item.id === id,
    )!.deliveries;
    if (
      !history.some(
        (record) =>
          record.revision === sentRevision &&
          (!accountId || record.accountId === accountId),
      )
    )
      throw new AppError(
        "WECHAT_DELIVERY_NOT_FOUND",
        "没有找到这次送稿记录，请刷新后重试。",
      );
    article.deliveryHistory = history.map((record) => {
      if (
        record.revision !== sentRevision ||
        (accountId && record.accountId !== accountId)
      )
        return record;
      const next = { ...record };
      if (published) next.publicationMarkedAt ??= now();
      else delete next.publicationMarkedAt;
      return next;
    });
    this.persist(article);
    return this.get(id);
  }
  newEdition(
    parentId: string,
    revision: number,
    requestId: string,
    raw?: WechatText,
  ) {
    const parent = this.load(parentId);
    this.editable(parent);
    const rootId = wechatArticleFamilies(this.articles()).get(
      wechatSourceIdentity(parent.source.url),
    )![0].id;
    const existing = this.articles().find(
      (item) => item.edition?.requestId === requestId,
    );
    if (existing) {
      if (existing.edition?.parentId !== parentId)
        throw new AppError(
          "WECHAT_EDITION_REQUEST",
          "新稿请求已用于其他稿件，请重新操作。",
        );
      return this.get(existing.id);
    }
    this.assertRevision(parent, revision);
    const text = wechatTextInput.parse(raw ?? parent);
    text.readMore ??= parent.readMore;
    text.templateId ??= parent.templateId;
    text.body = linkifyWechatMarkdown(text.body);
    const number =
      Math.max(...this.editionHistory(parent).map((item) => item.number)) + 1;
    const article: WechatArticle = {
      ...structuredClone(parent),
      ...text,
      id: id("wechat"),
      links: this.scan(text.body, parent.links),
      edition: { rootId, parentId, number, requestId },
      revision: 1,
      trafficWords: parent.trafficWords
        ? { words: [...parent.trafficWords.words], revision: 1 }
        : undefined,
      stage: "editing",
      remote: null,
      pendingAccount: null,
      pendingDraft: null,
      deliveryHistory: [],
      message: `第 ${number} 稿已创建。可直接存为新微信草稿，也可先改写或换图。`,
      createdAt: now(),
      updatedAt: now(),
    };
    this.d.repo.db.transaction(() => {
      this.persist(article);
      this.d.repo.db.setSetting(indexKey, [
        article.id,
        ...this.d.repo.db.setting<string[]>(indexKey, []),
      ]);
    });
    return this.get(article.id);
  }
  private issues(article: WechatArticle): WechatDetail["issues"] {
    const issues: WechatDetail["issues"] = [];
    const add = (text: string, severity: "error" | "warning" = "error") =>
      issues.push({ text, severity });
    const parsed = wechatTextInput.safeParse(article);
    if (!parsed.success)
      for (const issue of parsed.error.issues) add(issue.message);
    if (!article.coverUrl) add("请为文章选择封面后发送到微信草稿箱。");
    const allowed = new Set(
      article.links.map((link) => link.ownUrl).filter(Boolean),
    );
    if (
      articleLinks(article.body).some((link) => !allowed.has(link.url)) ||
      article.links.some((link) => !link.copyId || !link.ownUrl)
    )
      add("正文仍含未替换的网盘链接，请先入库、完成转存建链，再同步本人链接。");
    if (
      [...article.body.matchAll(/https?:\/\/[^\s<>"'，。；）)\]]+/gi)].some(
        ([raw]) => {
          try {
            return /(?:^|\.)(?:aliyundrive\.com|alipan\.com|115\.com|115cdn\.com|123pan\.com|123684\.com|123865\.com|cloud\.189\.cn|caiyun\.139\.com|lanzou[a-z]?\.com)$/.test(
              new URL(raw).hostname,
            );
          } catch {
            return false;
          }
        },
      )
    )
      add(
        "正文含暂未接入入库流程的网盘链接，请移除或改用资源库中已核验的本人资源。",
      );
    for (const match of article.body.matchAll(/!\[[^\]]*\]\(([^\s)]+)\)/g)) {
      try {
        if (!isWechatImageUrl(new URL(match[1]))) throw new Error();
      } catch {
        add("正文含无效配图地址，请选择本地图片或 HTTPS 图片。");
        break;
      }
    }
    if (
      /(?:TODO|待补充|\[在此填写|作为一个(?:AI|人工智能))/i.test(article.body)
    )
      add("正文包含占位内容，请补全后发送。");
    if (!article.body.includes(article.source.url))
      add("请核对转载、引用和配图授权，按需保留原文来源。", "warning");
    for (const text of article.source.warnings) add(text, "warning");
    return issues;
  }
  get(id: string): WechatDetail {
    const article = this.load(id);
    return {
      article,
      templateSupport: true,
      supportedTemplates: wechatTemplateIds,
      readMoreEntries: this.readMoreEntries(article),
      editions: this.editionHistory(article),
      trafficWordPlan: wechatTrafficWordPlan(
        this.d.repo.db,
        article.source.url,
        article.trafficWords?.words ?? [],
      ),
      issues: this.issues(article),
      resources: article.links.map((link) => {
        const candidates = this.d.repo.db
          .all<{ id: string }>(
            "SELECT c.id FROM copies c JOIN resources r ON r.id=c.resource_id WHERE r.source_url=? OR c.share_url=? ORDER BY c.created_at DESC",
            link.url,
            link.url,
          )
          .map((row) => {
            const copy = this.d.repo.getCopy(row.id),
              resource = this.d.repo.getResource(copy.resourceId),
              account = this.d.repo
                .accounts()
                .find((a) => a.id === copy.accountId);
            return {
              copyId: copy.id,
              title: resource.title,
              account: account?.alias ?? "账号已移除",
            };
          });
        let title = "未入库",
          status = "missing",
          message = "先入库，再通过现有资源录入完成文件选择、转存和建链。";
        if (link.copyId) {
          try {
            const copy = this.d.repo.getCopy(link.copyId);
            title = this.d.repo.getResource(copy.resourceId).title;
            status = copy.status;
            message =
              copy.status === "ready"
                ? "本人副本已归档，可同步链接。"
                : copy.error ||
                  "请在资源录入完成文件选择、转存与本人分享核验。";
            if (status === "ready") {
              try {
                this.d.assertOwnCopy(copy);
              } catch (error) {
                status = "needs_review";
                message = safeMessage(error);
              }
            }
          } catch {
            message = "关联副本已不存在，请重新关联。";
          }
        }
        return {
          linkId: link.id,
          copyId: link.copyId,
          title,
          status,
          message,
          candidates,
        };
      }),
    };
  }
  private readMoreEntries(article: WechatArticle): WechatReadMoreEntry[] {
    return article.links.map((link) => {
      let title = "未入库资源";
      let urls: ReturnType<ResourceLinks["publishedUrls"]> = {
        landingUrl: null,
        redirectUrl: null,
        landingIssue: "请先在网盘链接中将此资源入库。",
        redirectIssue: "请先在网盘链接中将此资源入库。",
      };
      if (link.copyId) {
        try {
          const copy = this.d.repo.getCopy(link.copyId);
          title = this.d.repo.getResource(copy.resourceId).title;
          urls = this.d.resourcePublishedUrls?.(copy.resourceId) ?? urls;
        } catch {
          urls.landingIssue = urls.redirectIssue =
            "关联资源已不存在，请重新入库或关联。";
        }
      }
      return {
        linkId: link.id,
        title,
        driveUrl: link.ownUrl || link.url,
        ...urls,
      };
    });
  }
  async importArticle(rawUrl: string) {
    const url = wechatArticleUrl.parse(rawUrl);
    if (this.closed || this.active.has("import"))
      throw new AppError("WECHAT_BUSY", "正在导入文章，请等待完成。");
    const old = this.articles().find((article) => article.source.url === url);
    if (old) return this.get(old.id);
    if (!this.d.port)
      throw new AppError(
        "WECHAT_DESKTOP",
        "请在当前源码桌面窗口导入公众号文章。",
      );
    this.active.add("import");
    try {
      const source = smzdmSourceSchema.parse(
        await this.d.port.readArticle(url),
      );
      source.url = url;
      const links = articleLinks(source.body);
      if (links.length > 100)
        throw new AppError(
          "WECHAT_LINK_LIMIT",
          "文章网盘链接超过 100 个，请拆分处理。",
        );
      const article: WechatArticle = {
        id: id("wechat"),
        source,
        title: source.title.slice(0, 64),
        body: linkifyWechatMarkdown(formatArticle(source.body)),
        author: "",
        digest: "",
        coverUrl:
          source.body.match(/!\[[^\]]*\]\((https:\/\/[^\s)]+)\)/)?.[1] ?? "",
        links,
        revision: 1,
        aiAssisted: false,
        stage: "editing",
        message:
          "原文已导入本地草稿箱。可替换资源链接、改写和更新配图，再发送到微信草稿箱。",
        remote: null,
        pendingAccount: null,
        createdAt: now(),
        updatedAt: now(),
      };
      this.d.repo.db.transaction(() => {
        this.persist(article);
        this.d.repo.db.setSetting(indexKey, [
          article.id,
          ...this.d.repo.db.setting<string[]>(indexKey, []),
        ]);
      });
      return this.get(article.id);
    } finally {
      this.active.delete("import");
    }
  }
  private scan(body: string, previous: SmzdmResourceLink[]) {
    const scanned = articleLinks(body);
    if (scanned.length > 100)
      throw new AppError(
        "WECHAT_LINK_LIMIT",
        "每篇文章最多关联 100 个网盘链接。",
      );
    return scanned
      .map(
        (link) =>
          previous.find(
            (old) => old.url === link.url || old.ownUrl === link.url,
          ) ?? link,
      )
      .filter(
        (link, i, links) =>
          links.findIndex((other) => other.id === link.id) === i,
      );
  }
  save(id: string, revision: number, raw: WechatText) {
    const article = this.load(id),
      text = wechatTextInput.parse(raw);
    // Older callers may omit the new setting; retain the saved choice.
    text.readMore ??= article.readMore;
    text.templateId ??= article.templateId;
    text.body = linkifyWechatMarkdown(text.body);
    this.editable(article);
    this.assertRevision(article, revision);
    if (
      Object.entries(text).some(
        ([key, value]) =>
          JSON.stringify(article[key as keyof WechatText]) !==
          JSON.stringify(value),
      )
    ) {
      article.links = this.scan(text.body, article.links);
      Object.assign(article, text);
      this.revised(article);
      this.persist(article);
    }
    return this.get(id);
  }
  async pickImage(id: string) {
    const article = this.load(id);
    this.editable(article);
    if (!this.d.readImage)
      throw new AppError("WECHAT_DESKTOP", "请在桌面窗口选择本地图片。");
    this.active.add(id);
    try {
      const file = await this.d.readImage();
      if (!file) return null;
      if (this.closed)
        throw new AppError("WECHAT_CLOSED", "工作空间已关闭，请重新选择图片。");
      if (file.bytes.length > 10 * 1024 * 1024)
        throw new AppError("WECHAT_IMAGE", "请选择不超过 10MB 的图片。");
      const image = await saveContentImage(
        this.d.dataPath,
        file.bytes,
        file.name,
        "content-assets",
        true,
      );
      return { url: `panxu-media://wechat/${image.file}`, name: file.name };
    } finally {
      this.active.delete(id);
    }
  }
  async image(file: string) {
    if (this.closed || !/^[a-f0-9]{64}\.(png|jpg|gif)$/.test(file))
      throw new AppError("WECHAT_IMAGE", "图片地址不正确。");
    const bytes = await readContentImage(this.d.dataPath, {
      file,
      sha256: file.split(".")[0],
      name: file,
      storage: "content-assets",
    });
    return {
      bytes,
      mime: file.endsWith(".png")
        ? "image/png"
        : file.endsWith(".gif")
          ? "image/gif"
          : "image/jpeg",
    };
  }
  private async referenceImage(raw: string) {
    const url = new URL(raw);
    if (!isWechatImageUrl(url))
      throw new AppError(
        "WECHAT_IMAGE",
        "无法使用此图片作为参考，请换一张图片。",
      );
    const image =
      url.protocol === "panxu-media:"
        ? await this.image(url.pathname.slice(1))
        : await this.d.readRemoteImage?.(url.href);
    if (!image)
      throw new AppError("WECHAT_IMAGE", "当前窗口无法读取参考图片。");
    return image.bytes;
  }
  async regenerateImages(
    input: WechatRegenerateImagesInput & {
      mode?: WechatImageGenerationMode;
      description?: string;
    },
  ): Promise<WechatRegenerateImagesResult> {
    const article = this.load(input.id);
    this.editable(article);
    this.assertRevision(article, input.revision);
    const images = wechatArticleImages(article.body);
    const positions = new Set(input.targets.map(({ position }) => position));
    if (
      positions.size !== input.targets.length ||
      input.targets.some(
        ({ position, url }) =>
          (position === "cover" ? article.coverUrl : images[position]?.url) !==
          url,
      )
    ) {
      throw new AppError(
        "WECHAT_IMAGE_CHANGED",
        "图片列表已变化，请刷新草稿后重新选择。",
      );
    }
    const theme = input.mode === "theme";
    const prompt = wechatImagePrompt({ ...input, title: article.title });
    const failed: WechatRegenerateImagesResult["failed"] = [];
    const results = new Map<
      string,
      { url: string } | { message: string; code?: string }
    >();
    const replacements = new Map<
      (typeof input.targets)[number]["position"],
      string
    >();
    let stopped = false;
    this.active.add(article.id);
    try {
      for (const { position, url } of input.targets) {
        if (this.closed)
          throw new AppError("WECHAT_CLOSED", "工作空间已关闭。");
        let result = results.get(url);
        if (!result) {
          try {
            if (stopped)
              throw new AppError(
                "WECHAT_IMAGE_SKIPPED",
                "未提交，请先处理本次生成错误。",
              );
            const bytes = theme
              ? await this.d.generateThemeImage(prompt)
              : await this.d.generateImage(
                  await this.referenceImage(url),
                  prompt,
                );
            if (this.closed)
              throw new AppError("WECHAT_CLOSED", "工作空间已关闭。");
            const saved = await saveContentImage(
              this.d.dataPath,
              bytes,
              "AI 配图.png",
            );
            result = { url: `panxu-media://wechat/${saved.file}` };
          } catch (error) {
            if (!(
              error instanceof AppError && error.code === "WECHAT_IMAGE_SKIPPED"
            ))
              this.logs.record({
                level:
                  error instanceof AppError &&
                  ["MEDIA_FACE_REJECTED", "MEDIA_POLICY_REJECTED"].includes(
                    error.code,
                  )
                    ? "warning"
                    : "error",
                event: "image.generation_failed",
                taskId: article.id,
                message: safeMessage(error),
                details: {
                  ...(error instanceof AppError ? error.details : {}),
                  code: error instanceof AppError ? error.code : "UNKNOWN",
                  position,
                  mode: theme ? "theme" : "reference",
                  ...(!theme ? { style: input.style ?? "natural" } : {}),
                },
              });
            if (
              error instanceof AppError &&
              [
                "API_KEY_REQUIRED",
                "MEDIA_MODEL_REQUIRED",
                "MEDIA_REFERENCE_MODEL",
                "AI_BUDGET_EXCEEDED",
                "MEDIA_REJECTED",
                "MEDIA_POLICY_REJECTED",
                "MEDIA_ACCESS_DENIED",
                "MEDIA_REMOTE_ERROR",
                "MEDIA_UNCERTAIN",
              ].includes(error.code)
            )
              stopped = true;
            result = {
              message: safeMessage(error),
              code: error instanceof AppError ? error.code : undefined,
            };
          }
          results.set(url, result);
        }
        if ("url" in result) replacements.set(position, result.url);
        else failed.push({ position, ...result });
      }
      if (replacements.size) {
        const cover = replacements.get("cover");
        if (cover) article.coverUrl = cover;
        else {
          const coverPosition = images.findIndex(
            (image, position) =>
              image.url === article.coverUrl && replacements.has(position),
          );
          if (coverPosition >= 0)
            article.coverUrl = replacements.get(coverPosition)!;
        }
        for (let position = images.length - 1; position >= 0; position--) {
          const url = replacements.get(position);
          if (!url) continue;
          const image = images[position];
          article.body =
            article.body.slice(0, image.index) +
            `![${image.alt}](${url})` +
            article.body.slice(image.index + image.markup.length);
        }
        article.aiAssisted = true;
        this.revised(article);
        this.persist(article);
      }
      return {
        detail: this.get(article.id),
        replaced: replacements.size,
        failed,
      };
    } finally {
      this.active.delete(article.id);
    }
  }
  async resource(id: string, linkId: string, accountId: string) {
    const article = this.load(id);
    this.editable(article);
    const link = article.links.find((link) => link.id === linkId);
    if (!link)
      throw new AppError("WECHAT_LINK", "文章链接已变化，请刷新草稿。");
    if (link.copyId && link.resourceId) {
      try {
        this.d.repo.getCopy(link.copyId);
        return { copyId: link.copyId, resourceId: link.resourceId };
      } catch {
        link.copyId = null;
        link.resourceId = null;
        link.ownUrl = null;
      }
    }
    this.active.add(id);
    try {
      const result = await this.d.saveResource({
        title:
          `${article.source.title} · 资料${article.links.indexOf(link) + 1}`.slice(
            0,
            200,
          ),
        sourceText: link.sourceText,
        category: "学习资料",
        tags: [],
        summary: `文章：${article.source.title}\n作者：${article.source.author}\n来源：${article.source.url}`,
        accountId,
        directory: "",
        enqueue: false,
      });
      link.copyId = result.copyId;
      link.resourceId = result.resourceId;
      this.revised(article);
      this.persist(article);
      return result;
    } finally {
      this.active.delete(id);
    }
  }
  bindResource(id: string, linkId: string, copyId: string) {
    const article = this.load(id);
    this.editable(article);
    const link = article.links.find((link) => link.id === linkId),
      copy = this.d.repo.getCopy(copyId),
      resource = this.d.repo.getResource(copy.resourceId);
    if (
      !link ||
      (resource.sourceUrl !== link.url &&
        (!copy.shareUrl || parseShare(copy.shareUrl).url !== link.url))
    )
      throw new AppError(
        "WECHAT_RESOURCE_MISMATCH",
        "请选择与原文分享来源相同的资源副本。",
      );
    link.copyId = copy.id;
    link.resourceId = copy.resourceId;
    this.revised(article);
    this.persist(article);
    return this.get(id);
  }
  private async linkReplacement(link: SmzdmResourceLink, verify: boolean) {
    if (!link.copyId)
      throw new AppError(
        "WECHAT_RESOURCE_REQUIRED",
        "请先将文章网盘资源入库，并完成转存建链。",
      );
    const copy = this.d.repo.getCopy(link.copyId);
    this.d.assertOwnCopy(copy);
    if (!copy.shareUrl || !copy.shareVerifiedAt)
      throw new AppError(
        "WECHAT_SHARE_REQUIRED",
        "本人副本尚未完成建链与核验。",
      );
    if (verify) {
      const check = await this.d.checkShare(copy.id);
      if (check.status !== "valid")
        throw new AppError(
          "WECHAT_SHARE_INVALID",
          check.message || "本人分享未通过实时核验。",
        );
    }
    return {
      url: parseShare(copy.shareUrl).url,
      code: (await this.d.secrets.get(`share:${copy.id}`)) ?? "",
    };
  }
  private async replacements(article: WechatArticle, verify: boolean) {
    const replacements = new Map<string, { url: string; code: string }>();
    for (const link of article.links)
      replacements.set(link.id, await this.linkReplacement(link, verify));
    return replacements;
  }
  async syncLinks(id: string) {
    const article = this.load(id);
    this.editable(article);
    this.active.add(id);
    try {
      const replacements = new Map<string, { url: string; code: string }>();
      for (const link of article.links) {
        try {
          replacements.set(link.id, await this.linkReplacement(link, false));
        } catch (error) {
          if (
            !(error instanceof AppError) ||
            ![
              "NOT_FOUND",
              "ACCOUNT_NOT_FOUND",
              "OWNERSHIP_UNVERIFIED",
              "FOREIGN_SHARE_BLOCKED",
              "WECHAT_RESOURCE_REQUIRED",
              "WECHAT_SHARE_REQUIRED",
            ].includes(error.code)
          )
            throw error;
        }
      }
      if (!replacements.size)
        throw new AppError(
          "WECHAT_SHARE_REQUIRED",
          "当前没有可替换的链接，请先完成至少一个资源的转存、建链和核验。",
        );
      const body = linkifyWechatMarkdown(
        replaceArticleLinks(article.body, article.links, replacements),
      );
      let changed = body !== article.body;
      article.body = body;
      for (const link of article.links) {
        const own = replacements.get(link.id);
        if (!own || own.url === link.ownUrl) continue;
        link.ownUrl = own.url;
        changed = true;
      }
      if (changed) {
        this.revised(article);
        this.persist(article);
      }
      return this.get(id);
    } finally {
      this.active.delete(id);
    }
  }
  format(id: string) {
    const article = this.load(id);
    this.editable(article);
    const formatted = linkifyWechatMarkdown(
      formatWechatRewriteBody(formatArticle(article.body)),
    );
    if (
      formatted !== article.body ||
      article.typesettingVersion !== wechatTypesettingVersion
    ) {
      article.body = formatted;
      article.typesettingVersion = wechatTypesettingVersion;
      this.revised(article);
      this.persist(article);
    }
    return this.get(id);
  }
  saveTrafficWords(id: string, wordsRevision: number, raw: string[]) {
    const article = this.load(id);
    this.editable(article);
    const previous = article.trafficWords ?? { words: [], revision: 0 };
    if (previous.revision !== wordsRevision)
      throw new AppError(
        "WECHAT_WORDS_CHANGED",
        "流量词已在其他窗口更新，输入已保留，请载入最新流量词后再保存。",
      );
    const words = wechatTrafficWordsInput.parse(raw);
    if (JSON.stringify(previous.words) !== JSON.stringify(words)) {
      article.trafficWords = { words, revision: previous.revision + 1 };
      this.persist(article);
    }
    return this.get(id);
  }
  async rewrite(
    id: string,
    instruction = "",
    styleId: WechatRewriteStyleId = defaultWechatRewriteStyle,
  ) {
    const rewriteInstruction = wechatRewriteInstruction(styleId);
    const article = this.load(id);
    this.editable(article);
    this.active.add(id);
    try {
      const { sections, entries, expectedIds } = wechatRewriteBody(
        article.body,
      );
      if (!expectedIds.length)
        throw new AppError(
          "WECHAT_REWRITE",
          "没有可独立改写的正文段落，原稿已保留。请补充正文，或将正文与图片、链接分行后重试。",
        );
      const trafficWords = article.trafficWords?.words ?? [];
      const layout = wechatRewriteLayout(sections);
      const wordPlan = wechatTrafficWordPlan(
        this.d.repo.db,
        article.source.url,
        trafficWords,
      );
      let result!: z.infer<typeof wechatRewriteResponse>;
      let retryFeedback = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          result = await this.d.ai.resourceExport(
            "wechat_article_copy",
            wechatRewriteResponse,
            rewriteInstruction,
            {
              title: article.title,
              sections,
              sourceAuthor: article.source.author,
              instruction,
              trafficWords,
              priorityTrafficWords: wordPlan.priorityWords,
              trafficWordUsage: wordPlan.usage,
              trafficWordPriorityMode: wordPlan.mode,
              retryFeedback,
              layout,
              previousTitles: [
                ...new Set(
                  this.editionHistory(article).flatMap((item) => [
                    ...(item.id !== article.id ? [item.title] : []),
                    ...item.deliveries
                      .map((delivery) => delivery.title)
                      .filter(Boolean),
                  ]),
                ),
              ].slice(0, 30),
            },
            [],
            {
              retainResponse: true,
              jsonMode: this.d.ai.modelFor("copy").startsWith("qwen/"),
              plainJson:
                attempt > 0 || this.d.ai.modelFor("copy").startsWith("qwen/"),
            },
          );
        } catch (error) {
          const retryable =
            error instanceof z.ZodError ||
            (error instanceof AppError &&
              error.code === "INVALID_AI_RESPONSE" &&
              (error.details?.finishReason == null ||
                ["stop", "error"].includes(
                  String(error.details.finishReason),
                )));
          if (!retryable) throw error;
          this.logs.record({
            level: attempt ? "error" : "warning",
            event: "rewrite.response_invalid",
            message: attempt
              ? "模型连续返回无效改写结果，原稿已保留。"
              : "模型返回格式异常，正在重新生成完整改写结果。",
            taskId: article.id,
            details: {
              ...(error instanceof AppError ? error.details : {}),
              styleId,
              attempt: attempt + 1,
              code:
                error instanceof AppError ? error.code : "INVALID_AI_RESPONSE",
            },
          });
          if (attempt)
            throw new AppError(
              "WECHAT_REWRITE",
              "AI 连续两次未返回完整、有效的改写结果，原稿已保留。请稍后重试或更换文案模型。",
              false,
              {
                ...(error instanceof AppError ? error.details : {}),
                attempts: 2,
              },
            );
          retryFeedback = `上一轮返回格式异常。重新生成完整结果，只输出一个包含 title、digest、sections 的 JSON 对象。sections 必须恰好包含段落编号 ${expectedIds.join("、")}，每个元素只有整数 id 和完整正文字符串 text。不能把内容、自我纠正或 JSON 片段用作字段名，不能输出半句话或重复的 JSON；保留全部原文信息并满足 Markdown 排版要求。`;
          continue;
        }
        const actualIds = result.sections.map(({ id }) => id);
        const ids = new Set(actualIds);
        const mismatch =
          actualIds.length !== expectedIds.length ||
          expectedIds.some((id) => !ids.has(id));
        const emptyIds = result.sections
          .filter(
            ({ text }) => !formatArticle(text.replace(/<br\s*\/?>/gi, "\n")),
          )
          .map(({ id }) => id);
        const unfinishedIds = unfinishedWechatRewriteIds(result.sections);
        const formatting =
          !mismatch && !emptyIds.length && !unfinishedIds.length
            ? prepareWechatRewriteLayout(result.sections, layout)
            : null;
        if (formatting) result.sections = formatting.sections;
        if (
          !mismatch &&
          !emptyIds.length &&
          !unfinishedIds.length &&
          !formatting?.issues.length
        )
          break;
        this.logs.record({
          level: "warning",
          event: formatting?.issues.length
            ? "rewrite.layout_mismatch"
            : unfinishedIds.length
              ? "rewrite.unfinished_sections"
              : mismatch
                ? "rewrite.section_mismatch"
                : "rewrite.empty_sections",
          message: formatting?.issues.length
            ? "模型返回的正文缺少 Markdown 层次，正在自动修正。"
            : "模型返回的正文不完整，原稿已保留。",
          taskId: article.id,
          details: {
            styleId,
            attempt: attempt + 1,
            expectedIds: expectedIds.slice(0, 200),
            actualIds: actualIds.slice(0, 200),
            emptyIds: emptyIds.slice(0, 200),
            unfinishedIds: unfinishedIds.slice(0, 200),
            expectedCount: expectedIds.length,
            actualCount: actualIds.length,
            layoutIssues: formatting?.issues,
          },
        });
        if (attempt === 1)
          throw new AppError(
            "WECHAT_REWRITE",
            formatting?.issues.length
              ? "正文排版仍未达到要求，已自动修正一次，原稿已保留。请重试或更换模型。"
              : "模型连续返回不完整正文，已自动重试一次，原稿已保留。请换个风格或模型后重试。",
          );
        retryFeedback = formatting?.issues.length
          ? `上一轮正文排版不合格：${formatting.issues.join("；")}。请重新输出全部结果，保留原意和每个可编辑段落编号，不合并、不遗漏编号，不新增事实。按全文内容分配小标题和局部重点，标题必须放在可编辑段落内部。`
          : `上一轮正文不完整。请重新输出全部结果，必须包含且只包含可编辑段落编号 ${expectedIds.join("、")}，每个 text 必须有实质正文，不得为空或只有换行。不要为追求风格删空已有段落；素材不支持故事时保留平实叙述。`;
      }
      checkRewriteText(result.title);
      checkRewriteText(result.digest);
      const restored = restoreWechatRewrite(entries, result.sections);
      article.links = this.scan(restored, article.links);
      article.title = result.title;
      article.body = linkifyWechatMarkdown(restored);
      article.digest = result.digest;
      article.aiAssisted = true;
      article.typesettingVersion = wechatTypesettingVersion;
      article.rewriteStyleId = styleId;
      this.revised(article);
      article.message =
        "改写稿已保存，请对照原文核对事实、引用和配图，再发送微信草稿。";
      this.d.repo.db.transaction(() => {
        this.persist(article);
        recordWechatTrafficWords(
          this.d.repo.db,
          article.source.url,
          trafficWords,
          article.title,
          article.body,
        );
      });
      return this.get(id);
    } finally {
      this.active.delete(id);
    }
  }
  async generateTitles(id: string, revision: number, raw?: WechatText) {
    const article = this.load(id);
    this.editable(article);
    this.assertRevision(article, revision);
    const text = wechatTextInput.parse(raw ?? article);
    this.active.add(id);
    try {
      let retryFeedback = "";
      const claims = ["免费", "微信版", "小程序"];
      const stated = wechatTrafficWordUsage(claims, "", text.body).used;
      const unsupportedClaims = claims.filter(
        (claim) => !stated.includes(claim),
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await this.d.ai.resourceExport(
            "wechat_article_titles",
            wechatTitleResponse,
            wechatTitleInstruction(
              article.rewriteStyleId ?? defaultWechatRewriteStyle,
            ),
            {
              currentTitle: text.title,
              sections: wechatRewriteBody(text.body).sections,
              sourceAuthor: article.source.author,
              trafficWords: article.trafficWords?.words ?? [],
              priorityTrafficWords: wechatTrafficWordPlan(
                this.d.repo.db,
                article.source.url,
                article.trafficWords?.words ?? [],
              ).priorityWords,
              previousTitles: this.editionHistory(article)
                .map((item) => item.title)
                .slice(0, 30),
              retryFeedback,
              unsupportedClaims,
            },
            [],
            {
              retainResponse: true,
              jsonMode: this.d.ai.modelFor("copy").startsWith("qwen/"),
              plainJson: this.d.ai.modelFor("copy").startsWith("qwen/"),
            },
          );
          result.titles.forEach(checkRewriteText);
          if (
            result.titles.some((title) =>
              unsupportedClaims.some((claim) => title.includes(claim)),
            )
          )
            throw new AppError(
              "WECHAT_TITLES",
              "标题加入了正文未说明的信息，请重试。",
            );
          const keys = result.titles.map(wechatTitleIdentity);
          if (
            keys.some(
              (key) => !key || key === wechatTitleIdentity(text.title),
            ) ||
            new Set(keys).size !== 5
          )
            throw new AppError(
              "WECHAT_TITLES",
              "模型返回的标题存在重复，请重试。",
            );
          this.assertRevision(this.load(id), revision);
          if (this.closed)
            throw new AppError(
              "WECHAT_CHANGED",
              "工作空间已切换，请重新生成标题。",
            );
          return result.titles;
        } catch (error) {
          const retryable =
            error instanceof z.ZodError ||
            (error instanceof AppError &&
              [
                "WECHAT_TITLES",
                "WECHAT_REWRITE",
                "INVALID_AI_RESPONSE",
              ].includes(error.code));
          if (!retryable) throw error;
          if (attempt)
            throw new AppError(
              "WECHAT_TITLES",
              "未取得五条符合正文且不同的有效标题，原有标题已保留，请重试。",
            );
          retryFeedback = `上一轮标题校验未通过。重新生成恰好五条不同的纯文本标题，每条不超过64字，不重复当前标题，不添加链接。当前正文未说明 ${unsupportedClaims.join("、") || "额外条件"}，即使词池或旧标题出现，也不得在候选标题中加入。`;
        }
      }
      throw new AppError("WECHAT_TITLES", "标题未生成，请重试。");
    } finally {
      this.active.delete(id);
    }
  }
  private receipt(draftId: string, rawUrl: string) {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new AppError(
        "WECHAT_RECEIPT",
        "未取得可确认的微信草稿地址，请先核对微信后台。",
      );
    }
    if (
      url.origin !== "https://mp.weixin.qq.com" ||
      url.username ||
      url.password ||
      !/^\/cgi-bin\/(?:appmsg|appmsgpublish)$/.test(url.pathname)
    )
      throw new AppError(
        "WECHAT_RECEIPT",
        "微信草稿回执地址不正确，请先核对微信后台。",
      );
    const fromUrl =
      url.searchParams.get("appmsgid") ||
      url.searchParams.get("AppMsgId") ||
      url.searchParams.get("appMsgId") ||
      "";
    if (!draftId) draftId = fromUrl;
    draftIdentifier.parse(draftId);
    if (fromUrl && fromUrl !== draftId)
      throw new AppError(
        "WECHAT_RECEIPT",
        "微信草稿地址与保存的草稿标识不一致，请重新核对。",
      );
    // Never persist short-lived login tokens in draft records.
    url.searchParams.delete("token");
    url.hash = "";
    return { draftId, url: url.href };
  }
  private hasSuccessfulReceipt(article: WechatArticle) {
    const proof = article.pendingDraft,
      account = article.pendingAccount;
    if (!proof || !account) return false;
    if (proof.acknowledged) return true;
    // Old first-save checkpoints lack the new marker. Recover only when the
    // latest save-failure log proves that the adapter already accepted a
    // successful official response for this exact account and draft ID.
    // A reconstructed update proof or an older failure is not such evidence.
    if (
      article.remote ||
      article.deliveryHistory?.length ||
      proof.title !== article.title
    )
      return false;
    const failure = this.d.repo.db.get<{ message: string; created_at: string }>(
      "SELECT message,created_at FROM runtime_logs WHERE domain='wechat' AND event='draft.save_failed' AND task_id=? AND account_id=? ORDER BY id DESC LIMIT 1",
      article.id,
      account.id,
    );
    return !!(
      failure &&
      failure.created_at >= article.createdAt &&
      failure.message.startsWith(
        `微信已返回草稿编号 ${proof.draftId}，但保存后核对未通过：`,
      )
    );
  }
  private confirmDelivery(
    article: WechatArticle,
    account: { id: string; uid: string },
    receipt: WechatDraftReceipt,
  ) {
    const confirmed = this.receipt(receipt.draftId, receipt.url);
    const target = wechatTargetReceipt(article, account.id);
    if (
      (article.remote && article.remote.accountId !== account.id) ||
      (target &&
        (target.draftId !== confirmed.draftId || target.uid !== account.uid))
    )
      throw new AppError(
        "WECHAT_RECEIPT",
        "微信返回的草稿标识与当前目标公众号记录不一致。",
      );
    article.remote = {
      ...confirmed,
      accountId: account.id,
      uid: account.uid,
      revision: article.revision,
      sentAt: now(),
    };
    this.recordDelivery(article, target ? "updated" : "created");
    article.pendingAccount = null;
    article.pendingDraft = null;
    article.stage = "synced";
    article.message = "已保存到微信草稿箱。请到微信后台预览并自行发文。";
    this.persist(article);
  }
  private async payload(
    article: WechatArticle,
    uid: string,
    target?: WechatRemote,
  ): Promise<WechatDraftPayload> {
    const error = this.issues(article).find(
      (issue) => issue.severity === "error",
    );
    if (error) throw new AppError("WECHAT_CONTENT", error.text);
    const replacements = await this.replacements(article, true);
    for (const link of article.links)
      if (replacements.get(link.id)?.url !== link.ownUrl)
        throw new AppError(
          "WECHAT_LINK_CHANGED",
          "本人分享已变化，请先重新同步链接。",
        );
    const allowed = new Map(
      [...replacements.values()].map((link) => [link.url, link.code]),
    );
    for (const { share, queryCode } of articleLinkOccurrences(article.body))
      if (
        !allowed.has(share.url) ||
        share.code !== allowed.get(share.url) ||
        (queryCode && queryCode !== allowed.get(share.url))
      )
        throw new AppError(
          "WECHAT_LINK_CHANGED",
          "正文网盘链接或提取码与本人分享不一致，请先重新同步。",
        );
    const readMore = resolveWechatReadMore(
      article.body,
      this.readMoreEntries(article),
      article.readMore,
    );
    if (readMore.issue) throw new AppError("WECHAT_READ_MORE", readMore.issue);
    return {
      ...wechatTextInput.parse(article),
      key: `panxu:${article.id}:${article.revision}`,
      uid,
      html: wechatHtml(
        article.body,
        undefined,
        readMore.driveUrl,
        article.templateId,
      ),
      sourceUrl: readMore.url,
      aiAssisted: article.aiAssisted,
      ...(target ? { draftId: target.draftId } : {}),
    };
  }
  async send(id: string, revision: number, accountId: string) {
    const article = this.load(id);
    this.editable(article);
    this.assertRevision(article, revision);
    if (article.remote && article.remote.accountId !== accountId)
      throw new AppError(
        "WECHAT_ACCOUNT",
        "此稿已绑定原公众号。需要选择其他公众号时，请先点“再发一篇”创建新稿。",
      );
    const target = wechatTargetReceipt(article, accountId);
    if (target?.revision === revision) return this.get(id);
    if (!this.d.port)
      throw new AppError(
        "WECHAT_DESKTOP",
        "请在当前源码桌面窗口发送微信草稿。",
      );
    this.active.add(id);
    let receiptAccepted = false;
    try {
      await this.d.accounts.use(
        accountId,
        "wechat",
        async (verified) => {
          if (!verified.uid || (target && target.uid !== verified.uid))
            throw new AppError(
              "WECHAT_ACCOUNT",
              "当前公众号身份与原草稿不一致，请重新检查登录。",
            );
          const stamp = JSON.stringify(this.d.environmentStamp(accountId));
          const payload = await this.payload(article, verified.uid, target),
            fingerprint = createHash("sha256")
              .update(JSON.stringify(payload))
              .digest("hex");
          let started = false;
          const receipt = await this.d.port!.saveDraft(
            verified,
            payload,
            async () => {
              if (started)
                throw new AppError(
                  "WECHAT_DUPLICATE",
                  "本次微信保存已提交，未重复发送。",
                );
              if (
                this.closed ||
                this.load(id).revision !== revision ||
                stamp !== JSON.stringify(this.d.environmentStamp(accountId))
              )
                throw new AppError(
                  "WECHAT_CHANGED",
                  "文章或账号环境已变化，请重新核对。",
                );
              if (
                fingerprint !==
                createHash("sha256")
                  .update(
                    JSON.stringify(
                      await this.payload(article, verified.uid!, target),
                    ),
                  )
                  .digest("hex")
              )
                throw new AppError(
                  "WECHAT_CHANGED",
                  "发送内容已变化，请重新核对。",
                );
              article.stage = "sending";
              article.typesettingVersion = wechatTypesettingVersion;
              article.pendingAccount = { id: verified.id, uid: verified.uid! };
              article.pendingDraft = null;
              article.message = "正在保存到微信草稿箱，等待官方保存回执。";
              this.persist(article);
              started = true;
            },
            async (proof) => {
              if (!started || article.stage !== "sending")
                throw new AppError(
                  "WECHAT_RECEIPT",
                  "未记录对应微信保存操作。",
                );
              const receipt = this.receipt(proof.draftId, proof.url);
              if (target && target.draftId !== receipt.draftId)
                throw new AppError(
                  "WECHAT_RECEIPT",
                  "微信草稿编号与当前目标公众号记录不一致。",
                );
              article.pendingDraft = {
                ...receipt,
                acknowledged: true,
                title: proof.title,
                html: proof.html,
                coverUrl: proof.coverUrl,
                sourceUrl: proof.sourceUrl,
              };
              this.persist(article);
            },
          );
          if (!started)
            throw new AppError(
              "WECHAT_RECEIPT",
              "未记录微信保存操作，未将本次结果标记为成功。",
            );
          this.confirmDelivery(
            article,
            { id: verified.id, uid: verified.uid },
            receipt,
          );
          receiptAccepted = true;
        },
        "保存公众号微信草稿",
      );
    } catch (error) {
      if (
        !this.closed &&
        article.pendingAccount &&
        article.pendingDraft?.acknowledged
      ) {
        this.confirmDelivery(
          article,
          article.pendingAccount,
          article.pendingDraft,
        );
        receiptAccepted = true;
      }
      if (receiptAccepted) {
        this.logs.record({
          level: "warning",
          event: "draft.receipt_recovered",
          message: "微信已返回保存成功回执，收尾异常未改变已保存结果。",
          taskId: article.id,
          accountId,
          details: { reason: safeMessage(error) },
        });
      } else if (!this.closed) {
        if (article.stage === "sending") article.stage = "uncertain";
        article.message =
          safeMessage(error) +
          (article.stage === "uncertain" &&
          !(
            error instanceof AppError && error.code === "WECHAT_DRAFT_UNCERTAIN"
          )
            ? " 保存结果未知，请先核对微信草稿箱，不会自动重发。"
            : "");
        this.logs.record({
          level: article.stage === "uncertain" ? "warning" : "error",
          event: "draft.save_failed",
          message: article.message,
          accountId,
          taskId: article.id,
          details: {
            stage: article.stage,
            code: error instanceof AppError ? error.code : "UNKNOWN",
          },
        });
        this.persist(article);
      }
      if (article.stage !== "uncertain" && !receiptAccepted) throw error;
    } finally {
      this.active.delete(id);
    }
    return this.get(id);
  }
  async recheck(id: string) {
    const article = this.load(id);
    if (this.closed || this.active.has(id))
      throw new AppError("WECHAT_BUSY", "草稿正在处理，请稍后重试。");
    if (article.stage !== "uncertain" || !article.pendingAccount)
      return this.get(id);
    if (article.pendingDraft && this.hasSuccessfulReceipt(article)) {
      this.confirmDelivery(
        article,
        article.pendingAccount,
        article.pendingDraft,
      );
      return this.get(id);
    }
    if (!this.d.port?.verifyDraft)
      throw new AppError(
        "WECHAT_DESKTOP",
        "请加载最新源码后检查微信保存结果。",
      );
    if (!article.pendingDraft) {
      const draftId =
        article.message.match(/微信已返回草稿编号\s+(\d{1,30})(?!\d)/)?.[1] ??
        wechatTargetReceipt(article, article.pendingAccount.id)?.draftId;
      if (!draftId)
        throw new AppError(
          "WECHAT_RECEIPT",
          "微信未返回可核实的草稿编号，请先打开微信草稿箱查看，暂不重复发送。",
        );
      const readMore = resolveWechatReadMore(
        article.body,
        this.readMoreEntries(article),
        article.readMore,
      );
      if (readMore.issue)
        throw new AppError("WECHAT_READ_MORE", readMore.issue);
      article.pendingDraft = {
        draftId,
        url: `https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&type=77&appmsgid=${draftId}`,
        title: article.title,
        html: wechatHtml(
          article.body,
          article.typesettingVersion ?? 0,
          readMore.driveUrl,
          article.templateId,
        ),
        coverUrl: article.coverUrl,
        ...(article.typesettingVersion && article.typesettingVersion >= 2
          ? { sourceUrl: readMore.url }
          : {}),
      };
      this.persist(article);
    }
    const pending = article.pendingAccount,
      proof = article.pendingDraft;
    this.active.add(id);
    try {
      await this.d.accounts.use(
        pending.id,
        "wechat",
        async (account) => {
          if (account.uid !== pending.uid)
            throw new AppError(
              "WECHAT_ACCOUNT",
              "当前公众号与本次保存账号不一致。",
            );
          await this.d.port!.verifyDraft!(account, proof);
          article.remote = {
            ...this.receipt(proof.draftId, proof.url),
            accountId: pending.id,
            uid: pending.uid,
            revision: article.revision,
            sentAt: now(),
          };
          this.recordDelivery(article, "verified");
          article.stage = "synced";
          article.pendingAccount = null;
          article.pendingDraft = null;
          article.message =
            "已自动核实微信草稿保存成功，可到微信后台预览和发文。";
          this.persist(article);
        },
        "检查微信草稿保存结果",
      );
    } catch (error) {
      article.message = `微信草稿保存核验未完成：${safeMessage(error).replace(/([?&](?:token|key|tempkey)=)[^&\s]+/gi, "$1[已隐藏]")}`;
      this.logs.record({
        level: "warning",
        event: "draft.verification_failed",
        taskId: id,
        accountId: pending.id,
        message: article.message,
        details: {
          draftId: proof.draftId,
          code: error instanceof AppError ? error.code : "UNKNOWN",
        },
      });
      this.persist(article);
    } finally {
      this.active.delete(id);
    }
    return this.get(id);
  }
  resolve(
    id: string,
    result: "saved" | "not_saved",
    draftId?: string,
    url?: string,
  ) {
    const article = this.load(id);
    if (
      this.closed ||
      this.active.has(id) ||
      article.stage !== "uncertain" ||
      !article.pendingAccount
    )
      throw new AppError("WECHAT_RESOLVE", "当前草稿无需核对保存结果。");
    if (result === "saved") {
      const previous = wechatTargetReceipt(article, article.pendingAccount.id);
      const remote = this.receipt(
        draftId ?? article.pendingDraft?.draftId ?? previous?.draftId ?? "",
        url ?? article.pendingDraft?.url ?? previous?.url ?? "",
      );
      if (previous && remote.draftId !== previous.draftId)
        throw new AppError(
          "WECHAT_RESOLVE",
          "请核对原微信草稿，不能将更新任务关联到其他草稿。",
        );
      article.remote = {
        ...remote,
        accountId: article.pendingAccount.id,
        uid: article.pendingAccount.uid,
        revision: article.revision,
        sentAt: now(),
      };
      article.stage = "synced";
      this.recordDelivery(article, "verified");
      article.message =
        "已按你的核对记录微信草稿保存结果，可到微信后台自行发文。";
    } else {
      article.stage = "editing";
      article.message =
        "已记录此次未保存。可以继续编辑，再次发送时会更新原微信草稿（如有）。";
    }
    article.pendingAccount = null;
    article.pendingDraft = null;
    this.persist(article);
    return this.get(id);
  }
  async open(accountId: string, id?: string) {
    if (this.closed || !this.d.port)
      throw new AppError(
        "WECHAT_DESKTOP",
        "请在当前源码桌面窗口打开微信草稿箱。",
      );
    const article = id ? this.load(id) : null;
    if (article?.remote && article.remote.accountId !== accountId)
      throw new AppError("WECHAT_ACCOUNT", "请选择此稿已绑定的公众号。");
    const target = article
      ? wechatTargetReceipt(article, accountId)
      : undefined;
    if (article?.pendingAccount && article.pendingAccount.id !== accountId)
      throw new AppError(
        "WECHAT_ACCOUNT",
        "请选择此次保存所使用的公众号账号。",
      );
    await this.d.accounts.use(
      accountId,
      "wechat",
      (verified) => {
        if (target && target.uid !== verified.uid)
          throw new AppError(
            "WECHAT_ACCOUNT",
            "当前公众号身份与原草稿不一致。",
          );
        return this.d.port!.open(
          verified,
          target?.url ??
            (article?.pendingAccount?.id === accountId
              ? article.pendingDraft?.url
              : undefined),
        );
      },
      "打开公众号微信草稿箱",
    );
    return true;
  }
}

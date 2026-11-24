import { z } from "zod";
import { createHash } from "node:crypto";
import { id, now, type Database } from "../database";
import { AppError, safeMessage } from "../errors";
import type { Repository } from "../repository";
import type { WebsiteAccounts } from "../website-accounts";
import type { ContentImage } from "../../shared/content-sources";
import type { ResourceCopy } from "../../shared/types";
import {
  jianshuCreateSchema,
  jianshuSaveSchema,
  jianshuGenerateSchema,
  jianshuIdSchema,
  jianshuCollectSchema,
  jianshuVersionSchema,
  jianshuResultSchema,
  jianshuResolveSchema,
  jianshuDraftUrl,
  jianshuFillCheckpointSchema,
  type JianshuArticle,
  type JianshuDetail,
  type JianshuIssue,
  type JianshuPayload,
  type JianshuPort,
  type JianshuSource,
  type JianshuSummary,
  type JianshuVersion,
  type JianshuCollectInput,
  type JianshuFillCheckpoint,
} from "../../shared/jianshu";
import {
  jianshuSourceProvider,
  parseJianshuSourceReference,
  type JianshuSourceCollection,
} from "../../shared/jianshu-sources";
import {
  jianshuDelivery,
  jianshuDeliveryWithCode,
  jianshuInitialBody,
  jianshuIssues,
  jianshuSourceWritingText,
  normalizeJianshuBody,
} from "./content";
import { jianshuArticleUrl } from "./browser-state";

export interface JianshuGeneration {
  title: string;
  body: string;
  template: JianshuArticle["template"];
  instruction: string;
  resource: { title: string; summary: string; files: string[] } | null;
  sources: JianshuSource[];
}
export interface JianshuDependencies {
  repo: Pick<Repository, "db" | "getCopy" | "getResource">;
  accounts: Pick<WebsiteAccounts, "get" | "use">;
  assertOwnCopy(copy: ResourceCopy): unknown;
  assertTarget(copyId: string): unknown;
  environmentStamp(accountId: string): unknown;
  runInEnvironment?<T>(accountId: string, action: () => Promise<T>): Promise<T>;
  generateText(
    input: JianshuGeneration,
  ): Promise<{ title: string; body: string }>;
  collector?: {
    collect(input: JianshuCollectInput): Promise<JianshuSourceCollection>;
  };
  port?: JianshuPort;
  importImages?(): Promise<ContentImage[] | null>;
  validateImage?(image: ContentImage): Promise<unknown>;
  resourceCover?(copyId: string): Promise<ContentImage | null>;
  readShareCode?(copyId: string): Promise<string | null>;
  changed(): void;
}
const articleKey = (value: string) => `jianshu:article:v1:${value}`;
const sourceKey = (value: string) => `jianshu:source:v1:${value}`;
const articleIndex = "jianshu:articles:v1";
const sourceIndex = "jianshu:sources:v1";
// Stored attribution only; collecting/fetching retains the collector's stricter request rules.
const sourceReference = z
  .url()
  .max(4000)
  .refine((value) => parseJianshuSourceReference(value) !== null);
export const jianshuSourceSchema = z.object({
  id: z.string().regex(/^[\w-]{1,150}$/),
  provider: jianshuSourceProvider,
  title: z.string().max(1000),
  body: z.string().max(200000),
  summary: z.string().max(10000),
  url: sourceReference,
  sourceName: z.string().max(200),
  author: z.string().max(300),
  publishedAt: z.string().max(100).nullable(),
  collectedAt: z.string().max(100),
  images: z
    .array(z.object({ url: sourceReference, alt: z.string().max(1000) }))
    .max(100),
  externalShares: z
    .array(z.object({ url: sourceReference, code: z.string().max(100) }))
    .max(100),
  warnings: z.array(z.string().max(2000)).max(50),
});
type GenerationRecord = {
  articleId: string;
  inputHash: string;
  status: "running" | "completed" | "failed" | "interrupted";
  message?: string;
};

export class JianshuArticles {
  private active = new Set<string>();
  private generations = new Map<string, Promise<JianshuDetail>>();
  private creations = new Map<
    string,
    { fingerprint: string; promise: Promise<JianshuDetail> }
  >();
  private closed = false;
  constructor(private deps: JianshuDependencies) {
    for (const article of this.articles()) {
      if (article.stage === "preparing") {
        article.stage = "uncertain";
        article.message =
          "上次官网交接被中断，请核对原页面；应用不会自动重发。";
        this.persist(article);
      }
    }
    for (const requestId of this.db.setting<string[]>(
      "jianshu:generations:v1",
      [],
    )) {
      const key = `jianshu:generation:v1:${requestId}`;
      const record = this.db.setting<GenerationRecord | null>(key, null);
      if (record?.status === "running")
        this.db.setSetting(key, {
          ...record,
          status: "interrupted",
          message: "上次生成已中断，旧稿保留；新请求才会再次调用模型。",
        });
    }
  }
  private get db(): Database {
    return this.deps.repo.db;
  }
  get isBusy() {
    return this.active.size > 0;
  }
  close() {
    this.closed = true;
  }
  private assertOpen() {
    if (this.closed)
      throw new AppError(
        "JIANSHU_CLOSED",
        "工作空间已关闭，未写入其他工作空间。",
      );
  }
  private articles() {
    return this.db
      .setting<string[]>(articleIndex, [])
      .map((id) => this.load(id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  list(): JianshuSummary[] {
    return this.articles().map(
      ({
        id,
        title,
        stage,
        accountId,
        copyId,
        sourceIds,
        updatedAt,
        receiptUrl,
        message,
        imageReviewRequired,
      }) => ({
        id,
        title,
        stage,
        accountId,
        copyId,
        sourceIds,
        updatedAt,
        receiptUrl,
        message,
        imageReviewRequired,
      }),
    );
  }
  sources(): JianshuSource[] {
    return this.db
      .setting<string[]>(sourceIndex, [])
      .flatMap((id) => {
        const value = this.db.setting<JianshuSource | null>(
          sourceKey(id),
          null,
        );
        return value ? [value] : [];
      })
      .sort((a, b) => b.collectedAt.localeCompare(a.collectedAt));
  }
  private selectedSources(sourceIds: string[]) {
    return [...new Set(sourceIds)].map((id) => {
      const source = this.db.setting<JianshuSource | null>(sourceKey(id), null);
      if (!source)
        throw new AppError(
          "JIANSHU_SOURCE_MISSING",
          "采集素材已不存在，请刷新并重新选择。",
        );
      return source;
    });
  }
  async collect(raw: unknown): Promise<JianshuSource[]> {
    const input = jianshuCollectSchema.parse(raw);
    this.assertOpen();
    if (this.active.has("collect"))
      throw new AppError("JIANSHU_BUSY", "正在采集，请等待当前请求完成。");
    if (!this.deps.collector)
      throw new AppError(
        "JIANSHU_COLLECTOR",
        "当前后台尚未加载简书采集服务，请应用更新后再试。",
      );
    this.active.add("collect");
    try {
      const result = await this.deps.collector.collect(input);
      const items = z.array(jianshuSourceSchema).max(50).parse(result.items);
      const notices = [
        ...new Set([
          ...(result.warnings ?? []),
          ...(result.truncated
            ? ["本次采集结果已按数量上限截取，可调整条件后继续获取。"]
            : []),
        ]),
      ].slice(0, 30);
      if (!items.length && notices.length)
        throw new AppError("JIANSHU_COLLECTION_EMPTY", notices.join(" "));
      for (const item of items)
        item.warnings = [...new Set([...item.warnings, ...notices])].slice(
          0,
          50,
        );
      this.assertOpen();
      this.db.transaction(() => {
        const ids = new Set(this.db.setting<string[]>(sourceIndex, []));
        for (const item of items) {
          // Keep the evidence used by existing drafts immutable. A refreshed original becomes a new snapshot.
          const prior = this.db.setting<JianshuSource | null>(
            sourceKey(item.id),
            null,
          );
          const signature = ({
            collectedAt: _at,
            id: _id,
            ...material
          }: JianshuSource) => JSON.stringify(material);
          const snapshotId =
            prior && signature(prior) !== signature(item)
              ? `${item.id.slice(0, 120)}_${createHash("sha256").update(signature(item)).digest("hex").slice(0, 20)}`
              : item.id;
          const material = this.db.setting<JianshuSource | null>(
            sourceKey(snapshotId),
            null,
          ) ?? { ...item, id: snapshotId };
          this.db.setSetting(sourceKey(material.id), material);
          ids.add(material.id);
          item.id = material.id;
        }
        this.db.setSetting(sourceIndex, [...ids]);
      });
      this.deps.changed();
      return items.map((item) =>
        this.db.setting<JianshuSource>(sourceKey(item.id), item),
      );
    } finally {
      this.active.delete("collect");
    }
  }
  private load(value: string): JianshuArticle {
    const id = jianshuIdSchema.parse(value);
    const article = this.db.setting<JianshuArticle | null>(
      articleKey(id),
      null,
    );
    if (!article)
      throw new AppError("JIANSHU_NOT_FOUND", "简书文章不存在，请刷新列表。");
    return article;
  }
  private persist(article: JianshuArticle) {
    this.assertOpen();
    article.updatedAt = now();
    this.db.setSetting(articleKey(article.id), article);
    this.deps.changed();
  }
  private revision(article: JianshuArticle, revision: number) {
    if (article.revision !== revision)
      throw new AppError(
        "JIANSHU_REVISION",
        "文章已在其他窗口修改，请刷新后继续；当前输入未覆盖保存。 ",
      );
  }
  private editable(article: JianshuArticle) {
    this.assertOpen();
    if (this.active.has(article.id))
      throw new AppError("JIANSHU_BUSY", "文章正在处理，请等待当前操作完成。");
    if (article.stage !== "editing")
      throw new AppError(
        "JIANSHU_RESULT_PENDING",
        "文章已交接官网或已有发布结果，请先核对结果；确认未发布后可继续编辑。",
      );
  }
  private preparable(article: JianshuArticle) {
    this.assertOpen();
    if (this.active.has(article.id) || article.stage === "preparing")
      throw new AppError("JIANSHU_BUSY", "文章正在处理，请等待当前操作完成。");
    if (article.stage === "published" || article.receiptUrl)
      throw new AppError(
        "JIANSHU_PUBLISHED",
        "文章已有发布结果，请新建文章，不能重新填写。",
      );
    if (article.stage === "uncertain" && !jianshuDraftUrl(article.editorUrl))
      throw new AppError(
        "JIANSHU_RESULT_PENDING",
        "上次官网操作结果尚不确定，且未记录具体草稿；请先检查官网并确认未发布，避免重复创建。",
      );
  }
  private account(accountId: string | null) {
    if (!accountId)
      throw new AppError(
        "JIANSHU_ACCOUNT",
        "请先选择简书账号，再打开官方编辑器。",
      );
    const account = this.deps.accounts.get(accountId);
    if (account.provider !== "jianshu")
      throw new AppError("JIANSHU_ACCOUNT", "请选择简书账号。");
    return account;
  }
  private resource(copyId: string | null) {
    if (!copyId) return null;
    const copy = this.deps.repo.getCopy(copyId);
    this.deps.assertOwnCopy(copy);
    this.deps.assertTarget(copy.id);
    if (!copy.shareUrl)
      throw new AppError(
        "JIANSHU_RESOURCE",
        "本人分享尚未准备好，请完成资料核验。",
      );
    return { copy, resource: this.deps.repo.getResource(copy.resourceId) };
  }
  get(id: string): JianshuDetail {
    const article = this.load(id);
    const sources = this.selectedSources(article.sourceIds);
    const extra: JianshuIssue[] = [];
    let resource: { title: string; url: string } | null = null;
    if (article.copyId) {
      try {
        const own = this.resource(article.copyId)!;
        resource = { title: own.resource.title, url: own.copy.shareUrl! };
      } catch (cause) {
        extra.push({ severity: "error", text: safeMessage(cause) });
      }
    }
    let delivery = jianshuDelivery(article, sources, resource);
    if (article.stage !== "editing" && article.preparedDelivery) {
      if (delivery.resourceUrl !== article.preparedDelivery.resourceUrl)
        extra.push({
          severity: "warning",
          text: "当前资料分享与交接时不同，以下保留当时的交付入口；请在原简书文章核对。",
        });
      delivery = structuredClone(article.preparedDelivery);
    }
    return {
      article,
      sources,
      issues: jianshuIssues(article, delivery.resourceUrl, extra),
      delivery,
      busy: this.active.has(id),
    };
  }
  async deliveryDetail(id: string): Promise<JianshuDetail> {
    const detail = this.get(id);
    if (
      detail.article.copyId &&
      detail.delivery.resourceUrl &&
      this.deps.readShareCode
    ) {
      const code = await this.deps.readShareCode(detail.article.copyId);
      this.assertOpen();
      this.revision(this.load(id), detail.article.revision);
      if (this.get(id).delivery.resourceUrl !== detail.delivery.resourceUrl)
        throw new AppError(
          "JIANSHU_RESOURCE_CHANGED",
          "资料分享刚刚变化，请重新读取当前交付内容。 ",
        );
      if (
        detail.article.stage !== "editing" &&
        detail.article.preparedDelivery
      ) {
        const hash = createHash("sha256")
          .update(code?.trim() ?? "")
          .digest("hex");
        if (
          !detail.article.preparedShareCodeHash ||
          hash !== detail.article.preparedShareCodeHash
        ) {
          detail.issues.push({
            severity: "warning",
            text: "提取信息与交接时不同或原记录不完整，历史交付未拼入当前提取码；请在原简书文章核对提取信息。",
          });
          return detail;
        }
      }
      detail.delivery = jianshuDeliveryWithCode(
        detail.delivery,
        detail.article.title,
        code,
      );
    }
    return detail;
  }
  async createWithCover(raw: unknown): Promise<JianshuDetail> {
    const input = jianshuCreateSchema.parse(raw);
    this.assertOpen();
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const pending = this.creations.get(input.requestId);
    if (pending) {
      if (pending.fingerprint !== fingerprint)
        throw new AppError(
          "JIANSHU_REQUEST",
          "同一新建请求的内容已变化，请重新发起。",
        );
      return pending.promise;
    }
    if (this.db.setting(`jianshu:create:v1:${input.requestId}`, null))
      return this.create(input);
    const work = (async () => {
      const images: ContentImage[] = [];
      let message: string | undefined;
      if (input.copyId && this.deps.resourceCover) {
        this.resource(input.copyId);
        try {
          const cover = await this.deps.resourceCover(input.copyId);
          this.assertOpen();
          if (cover) {
            await this.deps.validateImage?.(cover);
            this.assertOpen();
            images.push(cover);
          }
        } catch (cause) {
          this.assertOpen();
          if (cause instanceof AppError && cause.code === "JIANSHU_CLOSED")
            throw cause;
          message = "草稿已保存，原封面暂不可用；可稍后添加本地配图。";
        }
      }
      return this.create(input, images, message);
    })();
    this.creations.set(input.requestId, { fingerprint, promise: work });
    this.active.add(`create:${input.requestId}`);
    try {
      return await work;
    } finally {
      this.creations.delete(input.requestId);
      this.active.delete(`create:${input.requestId}`);
    }
  }
  create(
    raw: unknown,
    initialImages: ContentImage[] = [],
    initialMessage?: string,
  ): JianshuDetail {
    const input = jianshuCreateSchema.parse(raw);
    this.assertOpen();
    const requestKey = `jianshu:create:v1:${input.requestId}`;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const prior = this.db.setting<{ id: string; fingerprint: string } | null>(
      requestKey,
      null,
    );
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new AppError(
          "JIANSHU_REQUEST",
          "同一新建请求的内容已变化，请重新发起。",
        );
      return this.get(prior.id);
    }
    const sources = this.selectedSources(input.sourceIds);
    const own = this.resource(input.copyId ?? null);
    if (input.accountId) this.account(input.accountId);
    const time = now();
    const firstSource = sources[0];
    const sourceTitle = firstSource
      ? jianshuSourceWritingText(firstSource, firstSource.title).slice(
          0,
          200,
        ) || firstSource.sourceName.slice(0, 200)
      : "";
    const title = input.title || own?.resource.title || sourceTitle;
    const summary =
      own?.resource.summary ||
      (firstSource &&
        jianshuSourceWritingText(firstSource, firstSource.summary)) ||
      "";
    const article: JianshuArticle = {
      id: id("jianshu"),
      title,
      body: normalizeJianshuBody(
        input.body || jianshuInitialBody(title, summary, input.template),
      ),
      copyId: input.copyId ?? null,
      sourceIds: [...new Set(input.sourceIds)],
      template: input.template,
      accountId: input.accountId ?? null,
      images: structuredClone(initialImages),
      revision: 1,
      versions: [],
      aiAssisted: false,
      stage: "editing",
      message: initialMessage ?? "草稿已保存，可直接编辑或按模板生成文章。",
      editorUrl: null,
      receiptUrl: null,
      preparedRevision: null,
      preparedUid: null,
      preparedEnvironment: null,
      preparedText: null,
      preparedDelivery: null,
      preparedShareCodeHash: null,
      preparedFill: null,
      createdAt: time,
      updatedAt: time,
    };
    this.recordVersion(article, "created", "");
    this.db.transaction(() => {
      this.persist(article);
      this.db.setSetting(articleIndex, [
        ...this.db.setting<string[]>(articleIndex, []),
        article.id,
      ]);
      this.db.setSetting(requestKey, { id: article.id, fingerprint });
    });
    return this.get(article.id);
  }
  private recordVersion(
    article: JianshuArticle,
    origin: JianshuVersion["origin"],
    instruction: string,
  ) {
    if (origin !== "created" && article.preparedFill)
      article.preparedFill.filled = false;
    article.versions.push({
      revision: article.revision,
      title: article.title,
      body: article.body,
      images: structuredClone(article.images),
      origin,
      instruction,
      createdAt: now(),
      copyId: article.copyId,
      sourceIds: [...article.sourceIds],
      template: article.template,
    });
  }
  save(raw: unknown): JianshuDetail {
    const input = jianshuSaveSchema.parse(raw);
    const article = this.load(input.id);
    this.revision(article, input.revision);
    this.editable(article);
    if (
      jianshuDraftUrl(article.editorUrl) &&
      input.accountId !== article.accountId
    )
      throw new AppError(
        "JIANSHU_ACCOUNT",
        "文章已关联原账号的简书草稿，请保留原账号；使用其他账号请新建文章。",
      );
    if (input.accountId) this.account(input.accountId);
    this.selectedSources(input.sourceIds);
    if (input.copyId) this.resource(input.copyId);
    const next = {
      title: input.title,
      body: normalizeJianshuBody(input.body),
      template: input.template,
      images: input.images,
      accountId: input.accountId,
      copyId: input.copyId,
      sourceIds: [...new Set(input.sourceIds)],
    };
    if (
      Object.entries(next).every(
        ([key, value]) =>
          JSON.stringify(article[key as keyof JianshuArticle]) ===
          JSON.stringify(value),
      )
    )
      return this.get(article.id);
    Object.assign(article, next);
    article.revision++;
    article.message = "当前版本已保存。";
    this.recordVersion(article, "manual", "");
    this.persist(article);
    return this.get(article.id);
  }
  generate(raw: unknown): Promise<JianshuDetail> {
    const input = jianshuGenerateSchema.parse(raw);
    const inputHash = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const requestKey = `jianshu:generation:v1:${input.requestId}`;
    const record = this.db.setting<GenerationRecord | null>(requestKey, null);
    if (record) {
      if (record.inputHash !== inputHash)
        return Promise.reject(
          new AppError(
            "JIANSHU_REQUEST",
            "同一生成请求的内容已变化，请重新发起。",
          ),
        );
      const running = this.generations.get(input.requestId);
      if (running) return running;
      if (record.status === "completed")
        return Promise.resolve(this.get(record.articleId));
      return Promise.reject(
        new AppError(
          "JIANSHU_REQUEST_USED",
          record.message ||
            "此生成请求已处理或中断，请保留原稿并明确重新生成。",
        ),
      );
    }
    const article = this.load(input.id);
    this.revision(article, input.revision);
    this.editable(article);
    const sources = this.selectedSources(article.sourceIds);
    const own = this.resource(article.copyId);
    if (!article.body.trim() && !sources.length && !own)
      return Promise.reject(
        new AppError(
          "JIANSHU_BASIS",
          "请先选择资源、采集素材或填写已知内容，再生成文章。",
        ),
      );
    this.active.add(article.id);
    this.db.transaction(() => {
      this.db.setSetting(requestKey, {
        articleId: article.id,
        inputHash,
        status: "running",
      } satisfies GenerationRecord);
      this.db.setSetting("jianshu:generations:v1", [
        ...this.db.setting<string[]>("jianshu:generations:v1", []),
        input.requestId,
      ]);
    });
    const operation = (async () => {
      try {
        const output = z
          .object({
            title: z.string().trim().min(1).max(200),
            body: z.string().trim().min(30).max(100000),
          })
          .parse(
            await this.deps.generateText({
              title: article.title,
              body: article.body,
              template: article.template,
              instruction: input.instruction,
              resource: own
                ? {
                    title: own.resource.title,
                    summary: own.resource.summary,
                    files: own.copy.files.map((file) => file.name),
                  }
                : null,
              sources,
            }),
          );
        this.assertOpen();
        const current = this.load(article.id);
        this.revision(current, input.revision);
        current.title = output.title;
        current.body = normalizeJianshuBody(output.body);
        const issues = jianshuIssues(
          current,
          own?.copy.shareUrl ?? null,
        ).filter((issue) => issue.severity === "error");
        if (issues.length)
          throw new AppError(
            "JIANSHU_AI_CONTENT",
            issues.map((issue) => issue.text).join(" "),
          );
        current.aiAssisted = true;
        current.revision++;
        current.message =
          "新版本已生成，原稿保留在版本记录中；请核对事实与资料入口。";
        this.recordVersion(current, "ai", input.instruction);
        this.db.transaction(() => {
          this.persist(current);
          this.db.setSetting(requestKey, {
            articleId: article.id,
            inputHash,
            status: "completed",
          } satisfies GenerationRecord);
        });
        return { ...this.get(article.id), busy: false };
      } catch (cause) {
        if (!this.closed) {
          this.db.setSetting(requestKey, {
            articleId: article.id,
            inputHash,
            status: "failed",
            message: safeMessage(cause),
          } satisfies GenerationRecord);
          const current = this.load(article.id);
          current.message = `生成未完成，原稿已保留：${safeMessage(cause)}`;
          this.persist(current);
        }
        throw cause;
      } finally {
        this.active.delete(article.id);
        this.generations.delete(input.requestId);
      }
    })();
    this.generations.set(input.requestId, operation);
    return operation;
  }
  async importImages(raw: unknown): Promise<JianshuDetail | null> {
    const input = jianshuVersionSchema.parse(raw);
    const article = this.load(input.id);
    this.revision(article, input.revision);
    this.editable(article);
    if (!this.deps.importImages)
      throw new AppError(
        "JIANSHU_IMAGES",
        "当前窗口尚未加载图片导入，请应用更新后继续。",
      );
    this.active.add(article.id);
    try {
      const imported = await this.deps.importImages();
      if (!imported) return null;
      this.assertOpen();
      const current = this.load(article.id);
      this.revision(current, input.revision);
      const images = [
        ...new Map(
          [...current.images, ...imported].map((image) => [
            image.sha256,
            image,
          ]),
        ).values(),
      ];
      if (images.length > 20)
        throw new AppError(
          "JIANSHU_IMAGES",
          "一篇文章最多20张配图，请减少后再导入。",
        );
      if (this.deps.validateImage)
        for (const image of images) await this.deps.validateImage(image);
      current.images = images;
      current.revision++;
      this.recordVersion(current, "manual", "导入配图");
      current.message = "配图已保存，请在简书官方编辑器确认图片上传结果。";
      this.persist(current);
      return { ...this.get(current.id), busy: false };
    } finally {
      this.active.delete(article.id);
    }
  }
  private payload(detail: JianshuDetail): JianshuPayload {
    return {
      ...detail.delivery,
      id: detail.article.id,
      title: detail.article.title,
      images: detail.article.images,
      aiAssisted: detail.article.aiAssisted,
      editorUrl: jianshuDraftUrl(detail.article.editorUrl),
      fillCheckpoint: detail.article.preparedFill ?? null,
    };
  }
  private async validateDelivery(detail: JianshuDetail) {
    const errors = detail.issues.filter((issue) => issue.severity === "error");
    if (errors.length)
      throw new AppError(
        "JIANSHU_CONTENT",
        errors.map((issue) => issue.text).join(" "),
      );
    if (this.deps.validateImage)
      for (const image of detail.article.images)
        await this.deps.validateImage(image);
  }
  async prepare(raw: unknown): Promise<JianshuDetail> {
    const input = jianshuVersionSchema.parse(raw);
    const candidate = await this.deliveryDetail(input.id);
    this.revision(candidate.article, input.revision);
    this.preparable(candidate.article);
    await this.validateDelivery(candidate);
    const detail = await this.deliveryDetail(input.id),
      article = detail.article;
    this.revision(article, input.revision);
    this.preparable(article);
    if (
      article.stage !== "editing" &&
      article.preparedDelivery &&
      article.preparedShareCodeHash &&
      article.preparedShareCodeHash !==
        createHash("sha256")
          .update(detail.delivery.resourceCode ?? "")
          .digest("hex")
    )
      throw new AppError(
        "JIANSHU_SHARE_CODE_CHANGED",
        "资料提取信息已变化，未改写原官网草稿；请先核对入口，确认未发布后再修改本地文章。",
      );
    const selected = this.account(article.accountId);
    if (!this.deps.port)
      throw new AppError(
        "JIANSHU_DESKTOP",
        "当前后台尚未加载简书官网交接，请应用更新后继续；可先复制文章。 ",
      );
    this.active.add(article.id);
    const previous = structuredClone(article);
    let enteredPort = false;
    const persistedDelivery = this.get(article.id).delivery;
    article.stage = "preparing";
    article.message = "正在核对简书账号并填写官方草稿，尚未发布。";
    article.preparedRevision = article.revision;
    article.preparedText = persistedDelivery.text;
    article.preparedDelivery = persistedDelivery;
    article.preparedShareCodeHash = createHash("sha256")
      .update(detail.delivery.resourceCode ?? "")
      .digest("hex");
    this.persist(article);
    try {
      await this.deps.accounts.use(selected.id, "jianshu", async (account) => {
        this.assertOpen();
        if (
          !account.uid ||
          account.status !== "connected" ||
          account.unverified ||
          (article.preparedUid && account.uid !== article.preparedUid)
        )
          throw new AppError(
            "JIANSHU_ACCOUNT",
            "请先核实简书登录身份；当前账号必须与原官网草稿的账号一致。",
          );
        const environment = JSON.stringify(
          this.deps.environmentStamp(account.id),
        );
        article.preparedUid = account.uid;
        article.preparedEnvironment = environment;
        this.persist(article);
        const checkpoint = async (raw: JianshuFillCheckpoint) => {
          this.assertOpen();
          const saved = jianshuFillCheckpointSchema.parse(raw);
          const editorUrl = jianshuDraftUrl(saved.editorUrl)!;
          const priorUrl = jianshuDraftUrl(article.editorUrl);
          if (priorUrl && priorUrl !== editorUrl)
            throw new AppError(
              "JIANSHU_DRAFT_CHANGED",
              "官网草稿地址与原记录不一致，已停止填写，请核对原草稿。",
              true,
            );
          article.editorUrl = editorUrl;
          const result = {
            ...article.preparedFill,
            ...saved,
            editorUrl,
          };
          if (
            (result.totalImages !== undefined &&
              result.totalImages !== article.images.length) ||
            (result.filled &&
              article.images.length > 0 &&
              result.uploadedImages !== article.images.length) ||
            (result.filled && !!result.pendingImageSha256)
          ) {
            article.preparedFill = {
              ...article.preparedFill,
              editorUrl,
              filled: false,
            };
            this.persist(article);
            throw new AppError(
              "JIANSHU_IMAGE_PROGRESS",
              "官网配图填写结果不完整，请在原草稿继续核对。",
              true,
            );
          }
          article.preparedFill = result;
          article.message = saved.filled
            ? "官网草稿内容已填写，正在完成核对，尚未发布。"
            : "已记录原简书草稿，正在填写，尚未发布。";
          this.persist(article);
        };
        enteredPort = true;
        const prepared = await this.deps.port!.prepare(
          account,
          this.payload(detail),
          checkpoint,
        );
        this.assertOpen();
        if (
          environment !== JSON.stringify(this.deps.environmentStamp(account.id))
        )
          throw new AppError(
            "JIANSHU_ENVIRONMENT",
            "浏览器环境已变化，请核对原页面后再继续。",
            true,
          );
        if (prepared.filled || jianshuDraftUrl(prepared.editorUrl))
          await checkpoint({
            editorUrl: prepared.editorUrl,
            filled: prepared.filled,
            ...(prepared.uploadedImages !== undefined
              ? { uploadedImages: prepared.uploadedImages }
              : {}),
            ...(prepared.totalImages !== undefined
              ? { totalImages: prepared.totalImages }
              : {}),
          });
        else if (jianshuDraftUrl(article.editorUrl))
          throw new AppError(
            "JIANSHU_DRAFT_CHANGED",
            "官网未返回原草稿地址，请核对已保存的原草稿。",
            true,
          );
        else article.editorUrl = prepared.editorUrl;
        article.stage = "prepared";
        article.preparedRevision = article.revision;
        article.preparedUid = account.uid;
        article.preparedEnvironment = environment;
        article.message =
          prepared.message ||
          (prepared.filled
            ? "已填写到官方编辑器，尚未发布，请在简书核对后完成。"
            : "官方编辑器已打开，尚未填写或发布；请复制文章并在官网完成。 ");
        this.persist(article);
      });
      return { ...this.get(article.id), busy: false };
    } catch (cause) {
      if (!this.closed) {
        if (!enteredPort) Object.assign(article, previous);
        else article.stage = "uncertain";
        article.message = `官网填写未完成：${safeMessage(cause)}`;
        this.persist(article);
      }
      throw cause;
    } finally {
      this.active.delete(article.id);
    }
  }
  async checkResult(raw: unknown): Promise<JianshuDetail> {
    const input = jianshuResultSchema.parse(raw);
    const url = jianshuArticleUrl(input.url);
    if (!url)
      throw new AppError(
        "JIANSHU_RESULT_URL",
        "请填写简书公开文章的完整HTTPS地址。 ",
      );
    const detail = await this.deliveryDetail(input.id),
      article = detail.article;
    this.revision(article, input.revision);
    this.assertOpen();
    if (this.active.has(article.id))
      throw new AppError("JIANSHU_BUSY", "文章正在处理，请等待当前操作完成。");
    if (!this.deps.port)
      throw new AppError(
        "JIANSHU_DESKTOP",
        "当前后台尚未加载简书结果核对，请应用更新后重试。",
      );
    const selected = this.account(article.accountId);
    if (article.stage === "published" && article.receiptUrl === url)
      return detail;
    if (article.stage === "published")
      throw new AppError(
        "JIANSHU_PUBLISHED",
        "文章已有已核实的发布记录，不能换成其他文章链接。",
      );
    this.active.add(article.id);
    try {
      await this.deps.accounts.use(selected.id, "jianshu", async (account) => {
        if (
          !account.uid ||
          (article.preparedUid && article.preparedUid !== account.uid)
        )
          throw new AppError(
            "JIANSHU_ACCOUNT",
            "当前简书身份与交接时不一致，请重新核对账号。",
          );
        const payload = this.payload(detail);
        if (article.preparedDelivery) {
          if (
            article.preparedShareCodeHash &&
            article.preparedShareCodeHash !==
              createHash("sha256")
                .update(detail.delivery.resourceCode ?? "")
                .digest("hex")
          )
            throw new AppError(
              "JIANSHU_SHARE_CODE_CHANGED",
              "资料提取信息已变化，请在原简书文章核对入口，未登记为发布成功。 ",
            );
          Object.assign(
            payload,
            jianshuDeliveryWithCode(
              article.preparedDelivery,
              article.title,
              detail.delivery.resourceCode ?? null,
            ),
          );
        } else if (article.preparedText) payload.text = article.preparedText;
        const receipt = await this.deps.port!.checkResult(
          account,
          url,
          payload,
        );
        this.assertOpen();
        if (receipt.verified) {
          if (jianshuArticleUrl(receipt.url) !== url)
            throw new AppError(
              "JIANSHU_RECEIPT",
              "核对结果的文章链接不一致，未登记为发布成功。 ",
            );
          article.stage = "published";
          article.receiptUrl = receipt.url;
          article.imageReviewRequired = !!receipt.imageReviewRequired;
          article.imageReviewedAt = null;
          article.message = receipt.imageReviewRequired
            ? "已核实文章作者、正文及获取入口；配图仍需在官网人工核对。"
            : "已核实简书文章作者、内容及获取入口。";
        } else {
          article.stage = "uncertain";
          article.message =
            receipt.reason || "尚未核实发布结果，请检查原文章，不会自动重发。";
        }
        this.persist(article);
      });
      return { ...this.get(article.id), busy: false };
    } catch (cause) {
      if (!this.closed) {
        article.stage = "uncertain";
        article.message = `结果核对未完成：${safeMessage(cause)}`;
        this.persist(article);
      }
      throw cause;
    } finally {
      this.active.delete(article.id);
    }
  }
  resolve(raw: unknown): JianshuDetail {
    const input = jianshuResolveSchema.parse(raw);
    const article = this.load(input.id);
    this.revision(article, input.revision);
    this.assertOpen();
    if (this.active.has(article.id))
      throw new AppError("JIANSHU_BUSY", "文章正在处理，请等待当前操作完成。");
    if (article.stage === "published" || article.receiptUrl)
      throw new AppError(
        "JIANSHU_PUBLISHED",
        "已核实发布的文章保留历史，请新建文章。",
      );
    if (input.newDraft && !jianshuDraftUrl(article.editorUrl))
      throw new AppError(
        "JIANSHU_DRAFT_NOT_LINKED",
        "当前没有已关联的官网草稿，可以直接填写。",
      );
    if (input.imageNotUploaded) {
      if (!article.preparedFill?.pendingImageSha256)
        throw new AppError(
          "JIANSHU_IMAGE_NOT_PENDING",
          "当前没有待确认的图片上传，未更改草稿状态。",
        );
      article.preparedFill.pendingImageSha256 = null;
      article.preparedFill.filled = false;
    }
    article.stage = "editing";
    const draftUrl = input.newDraft ? null : jianshuDraftUrl(article.editorUrl);
    article.editorUrl = draftUrl;
    article.preparedRevision = null;
    if (!draftUrl) {
      article.preparedUid = null;
      article.preparedFill = null;
    }
    article.preparedText = null;
    article.preparedEnvironment = null;
    article.preparedDelivery = null;
    article.preparedShareCodeHash = null;
    article.message = input.newDraft
      ? "已解除原官网草稿关联，原稿仍保留在简书。本地文章与版本已保留，下次填写将新建草稿。"
      : input.imageNotUploaded
        ? "已按你确认的图片未上传结果恢复编辑，保留原简书草稿和已上传配图；重试前请确保官网没有仍在进行的上传。"
        : draftUrl
          ? "已按你确认的未发布结果恢复编辑，保留原简书草稿，重新填写不会新建重复稿。"
          : "已按你确认的未发布结果恢复编辑，原稿和版本保留。";
    this.persist(article);
    return this.get(article.id);
  }
  confirmImages(raw: unknown): JianshuDetail {
    const input = jianshuVersionSchema
      .extend({ confirmed: z.literal(true) })
      .parse(raw);
    const article = this.load(input.id);
    this.revision(article, input.revision);
    this.assertOpen();
    if (this.active.has(article.id))
      throw new AppError("JIANSHU_BUSY", "文章正在处理，请等待完成后再记录。 ");
    if (article.stage !== "published" || !article.receiptUrl)
      throw new AppError(
        "JIANSHU_RESULT_PENDING",
        "请先完成公开文章作者、正文及入口核对，再记录配图检查。 ",
      );
    if (article.imageReviewRequired) {
      article.imageReviewRequired = false;
      article.imageReviewedAt = now();
      article.message =
        "文章已核实，配图已由你在官网人工核对；保留人工核对时间。";
      this.persist(article);
    }
    return this.get(article.id);
  }
}

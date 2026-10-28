import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { id, now } from "../database";
import { AppError, safeMessage } from "../errors";
import { ContentSources, sameContentWord } from "../content-sources";
import { readResourceCover } from "../cover-assets";
import { recordEditorOpened } from "../publications";
import { includesOwnShareLink } from "../../shared/publication";
import { bindingEditorUrl } from "../../shared/channels";
import {
  weiboMarketingInput,
  weiboDeliveryOptions,
  weiboPostText,
  weiboContentIssue,
  weiboReceiptUrl,
  type WeiboMarketingRun,
  type WeiboMarketingDetail,
} from "../../shared/weibo-marketing";
import type { Repository } from "../repository";
import type { SearchOperations } from "../search";
import type { AiService } from "../ai";
import type { StudioService } from "../studio";
import type { WebsiteAccounts } from "../website-accounts";
import type { AppPorts } from "../ports";
import type { WeiboEditorPayload } from "../../shared/weibo-publishing";
import type { PublicationPackage } from "../../shared/ipc-commands";

interface Dependencies {
  repo: Repository;
  search: SearchOperations;
  ai: AiService;
  studio: StudioService;
  websiteAccounts: WebsiteAccounts;
  dataPath: string;
  ports: Pick<
    AppPorts,
    "chooseDirectory" | "copyText" | "openPath" | "normalizeCover"
  >;
  verifyTarget(topicId: string): Promise<void>;
  contentPackage(
    draftId: string,
    bindingId: string,
    includeLink: boolean,
  ): Promise<PublicationPackage>;
  record(input: {
    draftId: string;
    bindingId: string;
    url: string;
    status: "submitted" | "published";
  }): Promise<unknown>;
  changed(): void;
}
const indexKey = "weiboMarketing:index:v1";
const key = (runId: string) => `weiboMarketing:v1:${runId}`;
const frozen = new Set([
  "filled",
  "submitting",
  "uncertain",
  "handoff",
  "submitted",
  "published",
]);

/** Resource-backed image posts. Preparing and opening a window never imply publication. */
export class WeiboMarketing {
  private active = new Set<string>();
  private closed = false;
  private sources: ContentSources;
  constructor(private deps: Dependencies) {
    this.sources = new ContentSources(deps.repo, deps.search);
    for (const run of this.history()) {
      if (run.stage === "submitting") {
        run.stage = "uncertain";
        run.message =
          "上次微博提交已中断，请先核对官方窗口和回执；不会自动重发。";
        this.save(run);
      }
      if (["generating", "preparing"].includes(run.stage)) {
        run.stage = "attention";
        run.message =
          "上次操作已中断，本地内容保留；请核对后重新准备，不会自动生成或发布。";
        run.prepared = null;
        this.save(run);
      }
    }
  }
  get isBusy() {
    return this.active.size > 0;
  }
  close() {
    this.closed = true;
  }
  words(raw: unknown) {
    return this.sources.words(raw);
  }
  matches(raw: unknown) {
    return this.sources.matches(raw);
  }
  history(): WeiboMarketingRun[] {
    return this.deps.repo.db
      .setting<string[]>(indexKey, [])
      .map((runId) => this.load(runId));
  }
  private load(runId: string): WeiboMarketingRun {
    const run = this.deps.repo.db.setting<WeiboMarketingRun | null>(
      key(runId),
      null,
    );
    if (!run) throw new AppError("NOT_FOUND", "微博图文任务不存在。");
    if (run.options) {
      run.options.accountId ??= "";
      run.options.visibility ??= "public";
    }
    return run;
  }
  get(runId: string): WeiboMarketingDetail {
    const run = this.load(runId);
    const draft = this.deps.repo.draft(run.draftId);
    const resource = this.deps.repo.getResource(draft.resourceId);
    return {
      run,
      draft,
      resourceTitle: resource.title,
      hasCover: !!resource.coverId,
      coverId: resource.coverId,
      versions: this.deps.repo.db.all<{
        id: string;
        title: string;
        version: number;
      }>(
        "SELECT id,title,version FROM drafts WHERE topic_id=? AND copy_id=? AND platform='weibo' AND split_item_id IS NULL ORDER BY updated_at DESC,rowid DESC",
        run.topicId,
        run.input.copyId,
      ),
    };
  }
  private save(run: WeiboMarketingRun) {
    if (this.closed) return;
    run.updatedAt = now();
    const previous = this.deps.repo.db.setting<WeiboMarketingRun | null>(
      key(run.id),
      null,
    );
    if (previous?.stage !== run.stage || previous?.message !== run.message)
      run.events = [
        ...run.events,
        { stage: run.stage, message: run.message, at: run.updatedAt },
      ].slice(-60);
    this.deps.repo.db.setSetting(key(run.id), run);
    this.deps.changed();
  }
  private editable(run: WeiboMarketingRun) {
    if (this.closed || this.active.has(run.id))
      throw new AppError("WEIBO_BUSY", "此任务正在处理，请等待当前操作完成。");
    if (frozen.has(run.stage))
      throw new AppError(
        "WEIBO_RECEIPT_REQUIRED",
        "图文已交接到微博窗口，请先回填发布结果；确认尚未发布后才能修改本任务。",
      );
  }
  create(raw: unknown) {
    const input = weiboMarketingInput.parse(raw);
    const source =
      input.sourceId === "manual"
        ? {
            id: "manual",
            word: input.keyword,
            source: "手工选题 · 微博搜索热度未提供",
            observedAt: null,
            metrics: {},
          }
        : this.words({ query: input.keyword }).find(
            (word) => word.id === input.sourceId && word.word === input.keyword,
          );
    if (!source)
      throw new AppError(
        "CONTENT_WORD_CHANGED",
        "关键词来源已变化，请重新选择或使用手工选题。",
      );
    this.deps.search.assertTarget(input.copyId, null);
    const history = this.history();
    const duplicate = history.find(
      (run) =>
        sameContentWord(run.input.keyword) === sameContentWord(input.keyword) &&
        run.input.copyId === input.copyId,
    );
    if (duplicate) return this.get(duplicate.id);
    const existing = this.deps.repo.db
      .all<{
        id: string;
        keyword: string;
        copy_id: string | null;
        split_item_id: string | null;
      }>(
        "SELECT id,keyword,copy_id,split_item_id FROM search_topics WHERE platform='weibo' AND archived=0",
      )
      .find(
        (topic) =>
          sameContentWord(topic.keyword) === sameContentWord(input.keyword),
      );
    if (
      existing &&
      (existing.copy_id !== input.copyId || existing.split_item_id)
    )
      throw new AppError(
        "WEIBO_TOPIC_EXISTS",
        "该关键词已关联其他微博资料，请在搜索运营中核对后继续。",
      );
    const topic = existing
      ? this.deps.search.get(existing.id).topic
      : this.deps.search.create(
          {
            keyword: input.keyword,
            copyId: input.copyId,
            platform: "weibo",
            intent:
              `资源推荐${input.audience ? ` · ${input.audience}` : ""}`.slice(
                0,
                100,
              ),
          },
          false,
        );
    if (
      this.deps.search
        .get(topic.id)
        .publications.some((item) => item.status !== "opened")
    )
      throw new AppError(
        "WEIBO_ALREADY_PUBLISHED",
        "该选题已有发布记录，请继续原选题的效果复盘。",
      );
    if (topic.evidence !== input.evidence)
      this.deps.search.facts({
        id: topic.id,
        intent: topic.intent,
        softwareVersion: topic.softwareVersion,
        operatingSystem: topic.operatingSystem,
        evidence: input.evidence,
      });
    const draft = this.deps.search.write(topic.id);
    const time = now();
    const run: WeiboMarketingRun = {
      id: id("weibo"),
      input,
      source,
      topicId: topic.id,
      draftId: draft.id,
      options: null,
      stage: "review",
      message:
        "已关联本人资料。可以直接编辑，或显式生成资源推荐文案与配图方案。",
      prepared: null,
      url: null,
      receiptSyncPending: false,
      createdAt: time,
      updatedAt: time,
      events: [],
    };
    this.deps.repo.db.transaction(() => {
      this.deps.repo.db.setSetting(key(run.id), run);
      this.deps.repo.db.setSetting(indexKey, [
        run.id,
        ...history.map((item) => item.id),
      ]);
    });
    this.deps.changed();
    return this.get(run.id);
  }
  private async work(
    runId: string,
    stage: "generating" | "preparing",
    action: (run: WeiboMarketingRun) => Promise<void>,
    allowHandoff = false,
  ) {
    const run = this.load(runId);
    if (allowHandoff && ["handoff", "filled"].includes(run.stage)) {
      if (this.closed || this.active.has(run.id))
        throw new AppError("WEIBO_BUSY", "此任务正在处理。");
    } else this.editable(run);
    this.active.add(runId);
    const wasHandedOff = ["handoff", "filled"].includes(run.stage);
    if (!wasHandedOff) {
      run.stage = stage;
      run.message =
        stage === "generating"
          ? "正在使用现有文案模型生成资源推荐内容…"
          : "正在核验本人分享、稿件与图片…";
      this.save(run);
    }
    try {
      await action(run);
    } catch (error) {
      if (!this.closed) {
        if (!frozen.has(run.stage)) {
          run.stage = "attention";
          run.prepared = null;
        }
        run.message = safeMessage(error);
        this.save(run);
      }
    } finally {
      this.active.delete(runId);
    }
    return this.get(runId);
  }
  generate(runId: string, artwork: "cover" | "creative") {
    return this.work(runId, "generating", async (run) => {
      this.deps.studio.assertWorkingCopySaved(run.draftId);
      await this.deps.verifyTarget(run.topicId);
      if (this.closed) return;
      const draft =
        artwork === "creative"
          ? await this.deps.studio.create({
              copyId: run.input.copyId,
              platform: "weibo",
              sourceDraftId: run.draftId,
              mode: "ai",
              format: "image",
              contentFormat: "shortpost",
              aspectRatio: "3:4",
              pageCount: 1,
              brief: `资源推荐图文。目标人群：${run.input.audience || "以资料事实为准"}。正文建议 140–280 字，最多 3 个相关话题。配图为资料主题介绍，不伪造文件内页、实测或评价。`,
            })
          : await this.deps.ai.draft(
              run.input.copyId,
              "weibo",
              null,
              this.deps.search.context(run.topicId),
            );
      if (this.closed) return;
      run.draftId = draft.id;
      run.prepared = null;
      run.stage = "review";
      run.message =
        artwork === "creative"
          ? "文案和配图方案已保存。请在下方生成实际图片，再核对并审阅。"
          : "资源推荐文案已保存，请核对事实、话题和配套封面并审阅。";
      this.save(run);
    });
  }
  attachDraft(runId: string, draftId: string) {
    const run = this.load(runId);
    this.editable(run);
    const draft = this.deps.repo.draft(draftId);
    if (
      draft.platform !== "weibo" ||
      draft.contentFormat !== "shortpost" ||
      draft.copyId !== run.input.copyId ||
      draft.topicId !== run.topicId ||
      draft.splitItemId
    )
      throw new AppError(
        "DRAFT_MISMATCH",
        "稿件与当前微博选题或本人资料不一致。",
      );
    run.draftId = draftId;
    run.prepared = null;
    run.stage = "review";
    run.message = "已保存当前文案版本，请重新审阅并准备图文包。";
    this.save(run);
    return this.get(runId);
  }
  configure(runId: string, raw: unknown) {
    const run = this.load(runId);
    this.editable(run);
    const options = weiboDeliveryOptions.parse(raw);
    const account = this.deps.websiteAccounts.get(options.accountId);
    if (
      account.provider !== "weibo" ||
      !account.uid ||
      account.uid !== options.uid
    )
      throw new AppError(
        "WEIBO_ACCOUNT_MISMATCH",
        "请在其他账号完成微博登录，并选择识别出的账号身份。",
      );
    if (
      !this.deps.repo
        .bindings()
        .some(
          (binding) =>
            binding.id === options.bindingId &&
            binding.platform === "weibo" &&
            binding.websiteAccountId === account.id,
        )
    )
      throw new AppError(
        "BINDING_MISMATCH",
        "请选择其他账号中已连接的微博账号。",
      );
    run.options = options;
    run.prepared = null;
    run.stage = "review";
    run.message = "发布设置已保存，准备时会实时核验本人分享。";
    this.save(run);
    return this.get(runId);
  }
  private binding(run: WeiboMarketingRun) {
    const binding = this.deps.repo
      .bindings()
      .find((item) => item.id === run.options?.bindingId);
    if (
      !binding ||
      binding.platform !== "weibo" ||
      !binding.websiteAccountId ||
      binding.websiteAccountId !== run.options?.accountId
    )
      throw new AppError(
        "BINDING_MISMATCH",
        "请在其他账号连接微博，并重新选择任务的发布账号。",
      );
    return binding;
  }
  private async delivery(run: WeiboMarketingRun, verifyIdentity = true) {
    if (!run.options)
      throw new AppError(
        "WEIBO_OPTIONS_REQUIRED",
        "请先保存微博账号与配图设置。",
      );
    const binding = this.binding(run),
      draft = this.deps.repo.draft(run.draftId);
    if (verifyIdentity)
      await this.deps.websiteAccounts.verifyWeibo(
        binding.websiteAccountId!,
        run.options.uid,
      );
    const { copy } = this.deps.search.context(run.topicId);
    const pack = await this.deps.contentPackage(
      draft.id,
      binding.id,
      run.options.includeLink &&
        !includesOwnShareLink(draft.body, copy.shareUrl),
    );
    const text = weiboPostText(draft, pack.body),
      issue = weiboContentIssue(draft, text);
    if (issue) throw new AppError("WEIBO_CONTENT_REQUIRED", issue);
    const files: { name: string; path: string; bytes?: Buffer }[] = [];
    if (run.options.artwork === "cover") {
      const resource = this.deps.repo.getResource(draft.resourceId);
      if (!resource.coverId || !/^[a-f0-9]{64}$/.test(resource.coverId))
        throw new AppError(
          "WEIBO_COVER_REQUIRED",
          "此资源还没有封面。请在资源库补充封面，或生成实际 AI 配图后选择稿件图片。",
        );
      const cover = await readResourceCover(this.deps.dataPath, resource.coverId);
      files.push({
        name: "01-资源封面.png",
        path: cover.path,
        // The platform still receives PNG; the resource library retains WebP.
        bytes:
          cover.extension === "webp"
            ? await this.deps.ports.normalizeCover(cover.bytes)
            : undefined,
      });
    } else {
      if (
        !draft.creative ||
        !["image", "carousel"].includes(draft.creative.format)
      )
        throw new AppError(
          "WEIBO_IMAGE_REQUIRED",
          "当前稿件没有图片方案。请先生成配图方案和实际图片，或改用资源封面。",
        );
      for (const asset of await this.deps.studio.assertReady(draft.id)) {
        if (
          asset.kind !== "image" ||
          !["png", "jpg", "jpeg", "gif"].includes(asset.extension ?? "")
        )
          throw new AppError(
            "WEIBO_IMAGE_FORMAT",
            "微博图文包只支持 PNG、JPG 和 GIF 图片，请调整素材后重试。",
          );
        files.push({
          name: `${String(asset.slot + 1).padStart(2, "0")}-配图.${asset.extension}`,
          path: await this.deps.studio.assetPath(
            `${asset.asset}.${asset.extension}`,
          ),
        });
      }
    }
    if (!files.length || files.length > 9)
      throw new AppError(
        "WEIBO_IMAGE_REQUIRED",
        "图文包须包含 1–9 张实际图片。",
      );
    const hashes = [];
    for (const file of files) {
      const stat = await lstat(file.path).catch(() => {
        throw new AppError(
          "WEIBO_IMAGE_MISSING",
          "配图文件已丢失，请恢复或重新生成后准备。",
        );
      });
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size <= 0 ||
        stat.size >= 20 * 1024 * 1024 ||
        (file.bytes !== undefined &&
          (!file.bytes.length || file.bytes.length >= 20 * 1024 * 1024))
      )
        throw new AppError(
          "WEIBO_IMAGE_FORMAT",
          "配图必须是有效本地文件且小于 20MB，请调整后重试。",
        );
      hashes.push([
        file.name,
        createHash("sha256")
          .update(file.bytes ?? (await readFile(file.path)))
          .digest("hex"),
      ]);
    }
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          draftId: draft.id,
          reviewed: draft.reviewed,
          revision: draft.resourceRevision,
          shareVersion: draft.shareVersion,
          text,
          images: hashes,
          options: run.options,
          windowId: binding.windowId,
          websiteAccountId: binding.websiteAccountId,
          editorUrl: bindingEditorUrl(binding, "shortpost"),
          capabilities: binding.capabilities,
          verifiedAt: binding.verifiedAt,
          linkPermission: binding.linkPermission,
        }),
      )
      .digest("hex");
    return { draft, binding, text, files, fingerprint };
  }
  prepare(runId: string) {
    return this.work(runId, "preparing", async (run) => {
      run.prepared = null;
      this.save(run);
      const delivery = await this.delivery(run);
      const selected = await this.deps.ports.chooseDirectory(
        "content",
        this.deps.repo.db.setting<string | undefined>(
          "lastContentExportDirectory",
          undefined,
        ),
      );
      if (this.closed) return;
      if (!selected) {
        run.stage = "review";
        run.message = "已取消导出，本地稿件保留。";
        this.save(run);
        return;
      }
      const folder = join(selected, `盘序微博-${id("package")}`);
      await mkdir(folder, { mode: 0o700 });
      try {
        for (const file of delivery.files) {
          if (file.bytes)
            await writeFile(join(folder, file.name), file.bytes, { mode: 0o600 });
          else await copyFile(file.path, join(folder, file.name));
          await chmod(join(folder, file.name), 0o600);
        }
        await writeFile(join(folder, "微博文案.txt"), delivery.text, {
          mode: 0o600,
        });
        await writeFile(
          join(folder, "发布清单.json"),
          JSON.stringify(
            {
              platform: "weibo",
              runId: run.id,
              topicId: run.topicId,
              draftId: delivery.draft.id,
              draftVersion: delivery.draft.version,
              uid: run.options!.uid,
              accountId: run.options!.accountId,
              resourceTitle: this.deps.repo.getResource(
                delivery.draft.resourceId,
              ).title,
              images: delivery.files.map((file) => file.name),
              source: run.source,
              published: false,
              preparedAt: now(),
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        const latest = await this.delivery(run);
        if (latest.fingerprint !== delivery.fingerprint || this.closed)
          throw new AppError(
            "WEIBO_CONTENT_CHANGED",
            "导出期间内容或账号配置发生变化，请重新准备。",
          );
        const checksums: Record<string, string> = {};
        for (const name of [
          "微博文案.txt",
          ...delivery.files.map((file) => file.name),
        ])
          checksums[name] = createHash("sha256")
            .update(await readFile(join(folder, name)))
            .digest("hex");
        run.prepared = {
          fingerprint: delivery.fingerprint,
          text: delivery.text,
          folder,
          images: delivery.files.map((file) => file.name),
          checksums,
          preparedAt: now(),
          draftId: delivery.draft.id,
          bindingId: delivery.binding.id,
          accountId: run.options!.accountId,
          uid: run.options!.uid,
        };
        run.stage = "ready";
        run.message =
          "文案、图片和发布清单已导出。下一步复制文案并打开指定微博窗口，上传图片后由本人发布。";
        this.deps.repo.db.setSetting("lastContentExportDirectory", selected);
        this.save(run);
      } catch (error) {
        await rm(folder, { recursive: true, force: true });
        throw error;
      }
    });
  }
  handoff(runId: string) {
    const stored = this.load(runId);
    if (!["ready", "handoff"].includes(stored.stage) || !stored.prepared)
      throw new AppError(
        "WEIBO_PREPARE_REQUIRED",
        "请先完成核验并导出图文包。",
      );
    return this.work(
      runId,
      "preparing",
      async (run) => {
        const delivery = await this.delivery(run);
        if (delivery.fingerprint !== run.prepared?.fingerprint)
          throw new AppError(
            "WEIBO_CONTENT_CHANGED",
            "稿件、分享、配图或窗口配置发生变化。若已在微博发布，请先回填结果；尚未发布时重新准备。",
          );
        await this.assertPackage(run);
        // Persist handoff intent before opening the platform; a restart cannot silently regenerate this task.
        run.stage = "handoff";
        run.message =
          "图文已交接。请在指定窗口核对微博账号、粘贴文案并上传全部图片，发布后回填单条微博链接。";
        this.save(run);
        await this.deps.ports.copyText(run.prepared!.text);
        await this.deps.websiteAccounts.open(
          delivery.binding.websiteAccountId!,
          run.prepared!.uid,
        );
        recordEditorOpened(
          this.deps.repo.db,
          delivery.draft,
          delivery.binding.id,
          true,
        );
        this.deps.changed();
      },
      true,
    );
  }
  private editorPayload(run: WeiboMarketingRun): WeiboEditorPayload {
    const prepared = run.prepared!;
    return {
      taskId: run.id,
      environment: prepared.environment,
      uid: prepared.uid,
      text: prepared.text,
      visibility: run.options?.visibility ?? "public",
      aiAssisted: !["manual", "local-template"].includes(
        this.deps.repo.draft(prepared.draftId).model,
      ),
      images: prepared.images.map((name) => ({
        name,
        path: join(prepared.folder, name),
        sha256: prepared.checksums[name],
      })),
    };
  }
  fill(runId: string) {
    const stored = this.load(runId);
    if (!["ready", "filled"].includes(stored.stage) || !stored.prepared)
      throw new AppError(
        "WEIBO_PREPARE_REQUIRED",
        "请先核验并准备当前图文包。",
      );
    return this.work(
      runId,
      "preparing",
      async (run) => {
        const delivery = await this.delivery(run);
        if (delivery.fingerprint !== run.prepared!.fingerprint)
          throw new AppError(
            "WEIBO_CONTENT_CHANGED",
            "稿件、图片或账号设置已变化，请重新准备。",
          );
        await this.assertPackage(run);
        const editor = await this.deps.websiteAccounts.fillWeibo(
          run.options!.accountId,
          this.editorPayload(run),
        );
        run.prepared!.environment = editor.environment;
        run.stage = "filled";
        run.message =
          "文案已填写，全部图片已上传到官方发布器。请核对账号、可见范围及内容声明，再确认发布。";
        this.save(run);
      },
      true,
    );
  }
  async submit(runId: string) {
    const run = this.load(runId);
    if (run.stage !== "filled" || !run.prepared)
      throw new AppError("WEIBO_FILL_REQUIRED", "请先自动填写并上传当前图文。");
    if (this.closed || this.active.has(runId))
      throw new AppError("WEIBO_BUSY", "当前任务正在处理。");
    this.active.add(runId);
    try {
      const receipt = await this.deps.websiteAccounts.submitWeibo(
        run.options!.accountId,
        this.editorPayload(run),
        async () => {
          const latest = await this.delivery(run, false);
          if (latest.fingerprint !== run.prepared!.fingerprint)
            throw new AppError(
              "WEIBO_CONTENT_CHANGED",
              "提交前内容或账号设置发生变化，请重新准备。",
            );
          await this.assertPackage(run);
          run.stage = "submitting";
          run.message = "正在向微博提交图文，等待官方回执…";
          this.save(run);
        },
      );
      if (receipt.status === "rejected") {
        run.stage = "filled";
        run.message = receipt.message;
        this.save(run);
      } else {
        run.stage = "submitted";
        run.url = weiboReceiptUrl(receipt.url, run.prepared.uid);
        run.receiptSyncPending = true;
        run.message =
          run.options?.visibility === "self"
            ? "微博已返回提交成功回执，单条链接已自动保存；当前仅自己可见。"
            : "微博已返回提交成功回执，单条链接已自动保存。公开状态与资料入口可继续核对。";
        this.save(run);
        await this.syncReceipt(run);
      }
    } catch (error) {
      if ((run.stage as string) === "submitting") run.stage = "uncertain";
      run.message = safeMessage(error);
      this.save(run);
    } finally {
      this.active.delete(runId);
    }
    return this.get(runId);
  }
  private async assertPackage(run: WeiboMarketingRun) {
    if (!run.prepared)
      throw new AppError("WEIBO_PREPARE_REQUIRED", "尚未导出图文包。");
    for (const name of ["微博文案.txt", ...run.prepared.images]) {
      const stat = await lstat(join(run.prepared.folder, name)).catch(
        () => null,
      );
      if (!stat?.isFile() || stat.isSymbolicLink())
        throw new AppError(
          "WEIBO_PACKAGE_MISSING",
          "导出图文包已移动或缺失。尚未发布时先确认未提交，再重新导出；已发布时直接回填链接。",
        );
      if (
        createHash("sha256")
          .update(await readFile(join(run.prepared.folder, name)))
          .digest("hex") !== run.prepared.checksums[name]
      )
        throw new AppError(
          "WEIBO_PACKAGE_CHANGED",
          "导出文案或图片已被修改。请确认未发布后重新准备，保留当前平台现场。",
        );
    }
  }
  async openFolder(runId: string) {
    const run = this.load(runId);
    await this.assertPackage(run);
    await this.deps.ports.openPath(run.prepared!.folder);
    return true;
  }
  async openReceipt(runId: string) {
    const run = this.load(runId);
    if (!run.url || !run.options?.accountId)
      throw new AppError(
        "WEIBO_RECEIPT_REQUIRED",
        "任务尚未保存可打开的微博回执。",
      );
    return this.deps.websiteAccounts.openWeiboPost(
      run.options.accountId,
      run.url,
    );
  }
  async resolve(
    runId: string,
    result: "submitted" | "published" | "not_submitted",
    url: string,
  ) {
    const run = this.load(runId);
    if (this.closed || this.active.has(runId) || !frozen.has(run.stage))
      throw new AppError(
        "WEIBO_HANDOFF_REQUIRED",
        "请先完成图文交接，再登记实际发布结果。",
      );
    if (result === "not_submitted") {
      if (
        run.url ||
        !["handoff", "filled", "uncertain"].includes(run.stage) ||
        url.trim()
      )
        throw new AppError(
          "WEIBO_RESULT_EXISTS",
          "已有发布回执时不能清除记录后重发。",
        );
      run.stage = "review";
      run.prepared = null;
      run.message = "已人工确认尚未发布，可以修改内容并重新准备。";
      this.save(run);
      return this.get(runId);
    }
    let permalink: string;
    if (result === "published" && run.options?.visibility === "self")
      throw new AppError(
        "WEIBO_PRIVATE_POST",
        "此任务仅自己可见，只能登记已提交，不能确认公开。",
      );
    try {
      permalink = weiboReceiptUrl(url, run.prepared!.uid);
    } catch (error) {
      throw new AppError("WEIBO_RECEIPT_MISMATCH", safeMessage(error));
    }
    if (run.url && run.url !== permalink)
      throw new AppError(
        "WEIBO_RECEIPT_MISMATCH",
        "请使用本任务已登记的微博链接。",
      );
    if (run.stage === "published" && result === "submitted")
      throw new AppError(
        "WEIBO_RESULT_EXISTS",
        "已确认公开，无需回退为待核对。",
      );
    run.url = permalink;
    run.stage = result;
    run.receiptSyncPending = true;
    run.message =
      result === "published"
        ? "已人工确认微博公开，图文、资料与发布记录已关联。"
        : "已登记提交链接，公开状态请在微博核对。";
    this.save(run); // Keep the receipt even if synchronizing the common publication ledger fails.
    await this.syncReceipt(run);
    return this.get(runId);
  }
  private async syncReceipt(run: WeiboMarketingRun) {
    try {
      const draft = this.deps.repo.draft(run.prepared!.draftId);
      recordEditorOpened(
        this.deps.repo.db,
        draft,
        run.prepared!.bindingId,
        true,
      );
      await this.deps.record({
        draftId: draft.id,
        bindingId: run.prepared!.bindingId,
        url: run.url!,
        status: run.stage as "submitted" | "published",
      });
      run.receiptSyncPending = false;
      this.save(run);
    } catch (error) {
      run.message = `回执已保存，但发布记录同步失败：${safeMessage(error)}。请重试同步，无需重复发帖。`;
      this.save(run);
    }
  }
}

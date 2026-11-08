import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { id, now, type Database } from "../database";
import { AppError, safeMessage } from "../errors";
import type { WebsiteAccounts } from "../website-accounts";
import type { VideoService } from "../video-service";
import type { Repository } from "../repository";
import { readResourceCover } from "../cover-assets";
import { validateOutgoingLinks } from "../links";
import { hasVerifiedShare } from "../../shared/share-status";
import {
  bilibiliDraftId,
  bilibiliDraftInput,
  bilibiliEditorUrl,
  canonicalBilibiliReceipt,
  type BilibiliContentPort,
  type BilibiliDraft,
  type BilibiliDraftSummary,
  type BilibiliPreview,
  type BilibiliEditorPayload,
} from "../../shared/bilibili";

const indexKey = "bilibili:drafts:v1";
const key = (draftId: string) => `bilibili:draft:${draftId}:v1`;
export class BilibiliContent {
  private active = new Set<string>();
  private closed = false;
  constructor(
    private d: {
      db: Database;
      accounts: WebsiteAccounts;
      video: VideoService;
      repo: Repository;
      dataPath: string;
      port?: BilibiliContentPort;
      changed(): void;
    },
  ) {}
  get isBusy() {
    return this.active.size > 0;
  }
  close() {
    this.closed = true;
    this.d.port?.close?.();
  }
  private assertOpen() {
    if (this.closed)
      throw new AppError("BILIBILI_CLOSED", "工作空间已关闭，未操作其它空间。");
  }
  list(): BilibiliDraftSummary[] {
    this.assertOpen();
    return this.d.db
      .setting<string[]>(indexKey, [])
      .map((draftId) => {
        const {
          id,
          revision,
          accountId,
          copyId,
          kind,
          title,
          videoJobId,
          stage,
          updatedAt,
          message,
          receipt,
        } = this.get(draftId);
        return {
          id,
          revision,
          accountId,
          copyId,
          kind,
          title,
          videoJobId,
          stage,
          updatedAt,
          message,
          receipt,
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  get(draftId: string): BilibiliDraft {
    this.assertOpen();
    bilibiliDraftId.parse(draftId);
    const draft = this.d.db.setting<BilibiliDraft | null>(key(draftId), null);
    if (!draft)
      throw new AppError("BILIBILI_NOT_FOUND", "B站稿件不存在，请刷新列表。");
    return draft;
  }
  private persist(draft: BilibiliDraft) {
    this.assertOpen();
    draft.updatedAt = now();
    this.d.db.setSetting(key(draft.id), draft);
    this.d.changed();
    return draft;
  }
  save(raw: unknown) {
    this.assertOpen();
    const input = bilibiliDraftInput.parse(raw);
    const old = input.id ? this.get(input.id) : null;
    if (old && this.active.has(old.id))
      throw new AppError("BILIBILI_BUSY", "当前稿件正在填写，请完成后再修改。");
    if (old && input.revision !== old.revision)
      throw new AppError(
        "BILIBILI_STALE",
        "稿件已在其它窗口更新，请重新读取后再编辑；当前文字保留。",
      );
    if (
      input.accountId &&
      this.d.accounts.get(input.accountId).provider !== "bilibili"
    )
      throw new AppError("BILIBILI_ACCOUNT", "请选择哔哩哔哩账号。");
    if (input.copyId) this.d.repo.getCopy(input.copyId);
    const item: BilibiliDraft = {
      ...input,
      id: old?.id ?? id("bili"),
      revision: (old?.revision ?? 0) + 1,
      stage: "draft",
      createdAt: old?.createdAt ?? now(),
      updatedAt: now(),
      message: "稿件保存在本机，可预览后填写到官网。",
      ...(old?.receipt ? { receipt: old.receipt } : {}),
    };
    this.d.db.transaction(() => {
      if (!old) {
        const ids = this.d.db.setting<string[]>(indexKey, []);
        if (ids.length >= 500)
          throw new AppError(
            "BILIBILI_LIMIT",
            "本地B站稿件已达到500份，请先整理已有稿件。",
          );
        this.d.db.setSetting(indexKey, [item.id, ...ids]);
      }
      this.d.db.setSetting(key(item.id), item);
    });
    this.d.changed();
    return item;
  }
  private video(draft: BilibiliDraft) {
    return draft.copyId && draft.videoJobId
      ? (this.d.video
          .jobs(draft.copyId)
          .find(
            (video) =>
              video.id === draft.videoJobId && video.status === "completed",
          ) ?? null)
      : null;
  }
  private async assertAsset(path: string, extensions: string) {
    const pattern = new RegExp(`^[a-f0-9]{64}\\.(?:${extensions})$`);
    const name = basename(path),
      info = await lstat(path);
    if (
      !pattern.test(name) ||
      !info.isFile() ||
      info.isSymbolicLink() ||
      !info.size ||
      info.size > 512 * 1024 * 1024
    )
      throw new AppError(
        "BILIBILI_ASSET",
        "所选本地素材不完整，请重新制作或恢复素材。",
      );
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest("hex") !== name.slice(0, 64))
      throw new AppError("BILIBILI_ASSET", "所选本地素材已变化，请重新制作。");
    return path;
  }
  private async cover(draft: BilibiliDraft): Promise<string | null> {
    const video = this.video(draft);
    if (video)
      return this.assertAsset(
        (await this.d.video.output(video.id, "cover")).path,
        "png",
      );
    if (!draft.copyId) return null;
    const copy = this.d.repo.getCopy(draft.copyId),
      resource = this.d.repo.getResource(copy.resourceId);
    if (!resource.coverId) return null;
    const image = await readResourceCover(this.d.dataPath, resource.coverId);
    return this.assertAsset(image.path, "png|webp");
  }
  async preview(draftId: string): Promise<BilibiliPreview> {
    const draft = this.get(draftId),
      issues: BilibiliPreview["issues"] = [];
    const problem = (message: string, level: "error" | "warning" = "error") =>
      issues.push({ level, message });
    let accountLabel = "尚未选择账号";
    if (!draft.accountId) problem("请选择哔哩哔哩账号。");
    else {
      try {
        const account = this.d.accounts.get(draft.accountId);
        accountLabel = account.nickname || account.alias;
        if (account.provider !== "bilibili")
          problem("所选账号不是哔哩哔哩账号。");
        else if (
          account.status !== "connected" ||
          !account.uid ||
          account.unverified
        )
          problem("请先完成B站登录并检查当前身份。");
      } catch {
        problem("所选账号已移除，请重新选择。");
      }
    }
    const video = this.video(draft);
    if (draft.kind === "video" && !video)
      problem("请选择当前资源已制作完成的视频。");
    if (draft.kind !== "video" && !draft.text.trim())
      problem("请填写动态或文章正文。");
    if (draft.kind !== "article" && draft.text.length > 2000)
      problem("正文较长，请在官网核对当前字数限制。", "warning");
    if (draft.kind === "article" && draft.title.length > 40)
      problem(
        "专栏标题超过40字；开放平台API采用40字限制，网页版请以当前编辑器提示为准。",
        "warning",
      );
    if (draft.kind === "article" && draft.text.trim().length < 200)
      problem(
        "当前文章较短；开放平台API文字稿要求至少200字，网页版仍需在官网核对。",
        "warning",
      );
    try {
      const copy = draft.copyId ? this.d.repo.getCopy(draft.copyId) : null;
      const account = copy ? this.d.repo.getAccount(copy.accountId) : undefined;
      validateOutgoingLinks(
        `${draft.title}\n${draft.text}`,
        copy?.shareUrl ?? "",
        !!copy && hasVerifiedShare(copy, account),
      );
    } catch (error) {
      problem(safeMessage(error));
    }
    let imageUrl: string | null = null;
    try {
      const cover = await this.cover(draft);
      if (cover)
        imageUrl = `data:image/${cover.endsWith(".webp") ? "webp" : "png"};base64,${(await readFile(cover)).toString("base64")}`;
      else if (draft.kind !== "video")
        problem(
          "未选择配图；可选用资源封面或已完成视频的封面，也可在官网补充图片。",
          "warning",
        );
    } catch (error) {
      problem(safeMessage(error));
    }
    if (video?.project.hasAudio)
      problem("视频含背景音乐，发布前请核对该音轨在B站的使用范围。", "warning");
    return {
      draft,
      accountLabel,
      editorUrl: bilibiliEditorUrl(draft.kind),
      video,
      imageUrl,
      issues,
    };
  }
  async prepare(draftId: string) {
    const draft = this.get(draftId);
    if (this.active.has(draft.id))
      throw new AppError("BILIBILI_BUSY", "当前稿件正在填写，请等待完成。");
    if (!this.d.port)
      throw new AppError(
        "BILIBILI_UNAVAILABLE",
        "当前环境不支持B站官网填写，请使用桌面开发窗口。",
      );
    this.active.add(draft.id);
    try {
      const preview = await this.preview(draft.id);
      const failures = preview.issues.filter(
        (issue) => issue.level === "error",
      );
      if (failures.length)
        throw new AppError(
          "BILIBILI_NOT_READY",
          failures.map((issue) => issue.message).join(" "),
        );
      const payload: BilibiliEditorPayload = {
        draftId: draft.id,
        uid: "",
        kind: draft.kind,
        title: draft.title,
        text: draft.text,
        tags: draft.tags,
      };
      if (draft.kind === "video")
        payload.videoPath = await this.assertAsset(
          (await this.d.video.output(draft.videoJobId, "video")).path,
          "mp4",
        );
      payload.coverPath = (await this.cover(draft)) ?? undefined;
      this.persist({
        ...draft,
        stage: "attention",
        message: "正在打开官网并填写，尚未提交发布。",
      });
      const result = await this.d.accounts.use(
        draft.accountId,
        "bilibili",
        async (account) => {
          this.assertOpen();
          payload.uid = account.uid!;
          return this.d.port!.prepare(account, payload);
        },
        "哔哩哔哩投稿准备",
      );
      this.assertOpen();
      if (result.editorUrl !== bilibiliEditorUrl(draft.kind))
        throw new AppError(
          "BILIBILI_RESPONSE",
          "官网填写回执的目标页面不匹配，请核对原窗口。",
        );
      const preparation = { ...result, preparedAt: now() };
      return this.persist({
        ...draft,
        stage: result.status === "filled" ? "prepared" : "attention",
        preparation,
        message: result.message,
      });
    } catch (error) {
      if (!this.closed)
        this.persist({
          ...draft,
          stage: "attention",
          message: safeMessage(error),
        });
      throw error;
    } finally {
      this.active.delete(draft.id);
    }
  }
  recordReceipt(draftId: string, url: string) {
    const draft = this.get(draftId);
    if (this.active.has(draftId))
      throw new AppError(
        "BILIBILI_BUSY",
        "当前稿件正在填写，请完成后再记录链接。",
      );
    let canonical: string;
    try {
      canonical = canonicalBilibiliReceipt(url, draft.kind);
    } catch (error) {
      throw new AppError("BILIBILI_RECEIPT", safeMessage(error));
    }
    return this.persist({
      ...draft,
      stage: "attention",
      receipt: { url: canonical, status: "unverified", recordedAt: now() },
      message: "官网内容链接已记录，作者身份与发布状态尚待核对。",
    });
  }
  async package(draftId: string) {
    const preview = await this.preview(draftId),
      draft = preview.draft;
    const assets: string[] = [];
    if (this.video(draft))
      assets.push(
        `视频文件：${(await this.d.video.output(draft.videoJobId, "video")).path}`,
      );
    const cover = await this.cover(draft);
    if (cover) assets.push(`封面文件：${cover}`);
    return {
      name: `${draft.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 60)}-B站稿件.txt`,
      bytes: Buffer.from(
        [
          draft.title,
          "",
          draft.text,
          "",
          draft.tags.map((tag) => `#${tag}`).join(" "),
          "",
          ...assets,
          `官网编辑器：${preview.editorUrl}`,
          "此文件为本地稿件，官网提交及审核结果请另行核对。",
        ].join("\n"),
      ),
    };
  }
}

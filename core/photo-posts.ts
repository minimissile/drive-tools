import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { id, now } from "./database";
import { AppError } from "./errors";
import { validatePublicationUrl, validateOutgoingLinks } from "./links";
import { providers } from "../shared/platforms";
import {
  photoPlatforms,
  photoProviders,
  photoSaveSchema,
  photoVersionSchema,
  photoPublicationText,
  type PhotoPost,
} from "../shared/photo-posts";
import type { HandlerServices } from "./ipc/types";
type Dependencies = Pick<
  HandlerServices,
  "repo" | "db" | "ports" | "changed" | "assertOwnCopy" | "checkShare"
>;
const prefix = "photoPosts:task:";
const targetSchema = photoVersionSchema.extend({
  platform: z.enum(photoPlatforms),
});
export class PhotoPosts {
  private active = new Set<string>();
  constructor(private d: Dependencies) {}
  get isBusy() {
    return this.active.size > 0;
  }
  list(raw?: unknown): PhotoPost[] {
    const { copyId } = z
      .object({ copyId: z.string().min(1).max(100).optional() })
      .parse(raw ?? {});
    return this.d.db
      .all<{ value: string }>(
        "SELECT value FROM settings WHERE key LIKE ? AND (? IS NULL OR json_extract(value,'$.copyId')=?) ORDER BY json_extract(value,'$.updatedAt') DESC,key DESC LIMIT 100",
        `${prefix}%`,
        copyId ?? null,
        copyId ?? null,
      )
      .map((row) => JSON.parse(row.value));
  }
  get(postId: string): PhotoPost {
    const row = this.d.db.get<{ value: string }>(
      "SELECT value FROM settings WHERE key=?",
      prefix + postId,
    );
    if (!row)
      throw new AppError("NOT_FOUND", "图文任务不存在，请刷新任务列表。");
    return JSON.parse(row.value);
  }
  read(raw: unknown) {
    const { id, copyId } = z
      .object({
        id: z.string().regex(/^photo_[\w-]+$/),
        copyId: z.string().min(1).max(100),
      })
      .parse(raw);
    const post = this.get(id);
    if (post.copyId !== copyId)
      throw new AppError(
        "PHOTO_COPY_MISMATCH",
        "任务不属于当前资源副本，请重新选择。",
      );
    return post;
  }
  private current(postId: string, version: number) {
    const post = this.get(postId);
    if (post.version !== version)
      throw new AppError(
        "PHOTO_VERSION_CHANGED",
        "任务已在其他窗口更新，请重新读取后继续。",
      );
    return post;
  }
  private persist(post: PhotoPost) {
    this.d.db.setSetting(prefix + post.id, post);
    this.d.changed();
    return post;
  }
  private assertSource(post: PhotoPost) {
    const copy = this.d.repo.getCopy(post.copyId),
      resource = this.d.repo.getResource(copy.resourceId),
      account = this.d.assertOwnCopy(copy);
    if (
      !copy.shareUrl ||
      !copy.shareVerifiedAt ||
      copy.shareOwnerUid !== account.uid ||
      copy.shareUrl !== post.shareUrl ||
      copy.shareVersion !== post.shareVersion ||
      account.uid !== post.ownerUid ||
      resource.revision !== post.resourceRevision
    )
      throw new AppError(
        "PHOTO_SOURCE_CHANGED",
        "本人分享或资源内容已变化，请重新带入资源、核对口令并保存新版本。",
      );
  }
  save(raw: unknown) {
    const input = photoSaveSchema.parse(raw),
      copy = this.d.repo.getCopy(input.copyId),
      resource = this.d.repo.getResource(copy.resourceId);
    if (!(photoProviders as readonly string[]).includes(resource.provider))
      throw new AppError(
        "PHOTO_PROVIDER_UNSUPPORTED",
        "图文营销目前支持夸克、百度、UC、迅雷。",
      );
    const previous = input.id
      ? this.current(input.id, input.expectedVersion ?? 0)
      : null;
    if (previous && previous.copyId !== copy.id)
      throw new AppError(
        "PHOTO_COPY_FIXED",
        "已有任务的资源副本不可替换，请新建图文任务。",
      );
    if (previous && this.active.has(previous.id))
      throw new AppError("PHOTO_BUSY", "当前任务正在处理，请等待完成。");
    const time = now(),
      changed =
        !previous ||
        JSON.stringify(previous.form) !== JSON.stringify(input.form) ||
        previous.shareUrl !== copy.shareUrl ||
        previous.shareVersion !== copy.shareVersion ||
        previous.ownerUid !== copy.shareOwnerUid ||
        previous.resourceRevision !== resource.revision;
    return this.persist({
      id: previous?.id ?? id("photo"),
      resourceId: resource.id,
      copyId: copy.id,
      provider: resource.provider,
      shareUrl: copy.shareUrl,
      shareVersion: copy.shareVersion,
      ownerUid: copy.shareOwnerUid,
      resourceRevision: resource.revision,
      version: (previous?.version ?? 0) + Number(changed),
      form: input.form,
      exportedVersion: previous?.exportedVersion ?? null,
      publications: previous?.publications ?? [],
      createdAt: previous?.createdAt ?? time,
      updatedAt: time,
    });
  }
  remove(raw: unknown) {
    const input = photoVersionSchema.parse(raw),
      post = this.current(input.id, input.version);
    if (this.active.has(post.id))
      throw new AppError("PHOTO_BUSY", "任务正在处理，请等待完成。");
    if (post.publications.length)
      throw new AppError(
        "PHOTO_HISTORY_EXISTS",
        "任务已有官网交接记录，请保留发布历史。",
      );
    this.d.db.run("DELETE FROM settings WHERE key=?", prefix + post.id);
    this.d.changed();
    return true;
  }
  private async run<T>(postId: string, action: () => Promise<T>) {
    if (this.active.has(postId))
      throw new AppError("PHOTO_BUSY", "此任务正在处理，请等待完成。");
    this.active.add(postId);
    try {
      return await action();
    } finally {
      this.active.delete(postId);
    }
  }
  async export(raw: unknown) {
    const input = photoVersionSchema
      .extend({ images: z.array(z.string().max(17_000_000)).length(3) })
      .parse(raw);
    return this.run(input.id, async () => {
      const post = this.current(input.id, input.version);
      if (!post.form.passphrase.trim())
        throw new AppError(
          "PHOTO_PHRASE_REQUIRED",
          "请填写中文口令，并核对其对应的本人分享。",
        );
      if (!post.form.details.trim())
        throw new AppError(
          "PHOTO_DETAILS_REQUIRED",
          "请填写已核实的资源详情后再导出。",
        );
      validateOutgoingLinks(
        photoPublicationText(
          post.form,
          providers[post.provider],
          post.form.platforms[0],
        ),
        post.shareUrl ?? "",
        false,
      );
      this.assertSource(post);
      const images = input.images.map((value) => {
        if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))
          throw new AppError(
            "PHOTO_IMAGE_INVALID",
            "请重新生成完整的三张 PNG 图片。",
          );
        const bytes = Buffer.from(value.split(",")[1], "base64");
        if (
          bytes.length < 33 ||
          bytes.length > 12 * 1024 * 1024 ||
          !bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          bytes.toString("ascii", 12, 16) !== "IHDR" ||
          bytes.readUInt32BE(16) !== 1080 ||
          bytes.readUInt32BE(20) !== 1440
        )
          throw new AppError(
            "PHOTO_IMAGE_INVALID",
            "图片必须为 1080 × 1440 的有效 PNG。",
          );
        return bytes;
      });
      const checked = await this.d.checkShare(post.copyId);
      if (checked.status !== "valid")
        throw new AppError(
          "PHOTO_SHARE_UNAVAILABLE",
          checked.message || "本人分享未通过核验，请回到资源库处理。",
        );
      this.assertSource(post);
      const selected = await this.d.ports.chooseDirectory("content");
      if (!selected) return null;
      this.current(post.id, post.version);
      let folder: string | null = null;
      try {
        folder = await mkdtemp(join(selected, "盘序图文-"));
        for (const [index, bytes] of images.entries())
          await writeFile(
            join(folder, `${String(index + 1).padStart(2, "0")}.png`),
            bytes,
            { mode: 0o600 },
          );
        for (const platform of post.form.platforms)
          await writeFile(
            join(folder, `${platform}-发布文案.txt`),
            photoPublicationText(post.form, providers[post.provider], platform),
            { mode: 0o600 },
          );
        await writeFile(
          join(folder, "内容信息.json"),
          JSON.stringify(
            {
              taskId: post.id,
              version: post.version,
              resourceId: post.resourceId,
              copyId: post.copyId,
              provider: post.provider,
              shareUrl: post.shareUrl,
              shareVersion: post.shareVersion,
              passphrase: post.form.passphrase,
              retrieval: post.form.retrieval,
              form: post.form,
              images: images.map((bytes, index) => ({
                name: `${String(index + 1).padStart(2, "0")}.png`,
                sha256: createHash("sha256").update(bytes).digest("hex"),
              })),
              exportedAt: now(),
              published: false,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        const current = this.current(post.id, post.version);
        this.assertSource(current);
        current.exportedVersion = current.version;
        this.persist(current);
        return { folder, post: current };
      } catch (error) {
        if (folder) await rm(folder, { recursive: true, force: true });
        throw error;
      }
    });
  }
  async open(raw: unknown) {
    const input = targetSchema.parse(raw);
    return this.run(input.id, async () => {
      const post = this.current(input.id, input.version);
      if (
        !post.form.platforms.includes(input.platform) ||
        post.exportedVersion !== post.version
      )
        throw new AppError(
          "PHOTO_EXPORT_REQUIRED",
          "请先核验并导出当前版本的图文包。",
        );
      this.assertSource(post);
      if (!this.d.ports.photoPostBrowser)
        throw new AppError(
          "PHOTO_BROWSER_UNAVAILABLE",
          "请在桌面源码窗口打开平台官网。",
        );
      await this.d.ports.photoPostBrowser.open(input.platform);
      const current = this.current(post.id, post.version),
        previous = current.publications.find(
          (p) => p.platform === input.platform && p.version === current.version,
        );
      if (!previous)
        current.publications.push({
          platform: input.platform,
          version: current.version,
          status: "opened",
          url: null,
          updatedAt: now(),
        });
      return this.persist(current);
    });
  }
  result(raw: unknown) {
    const input = targetSchema
        .extend({
          status: z.enum(["submitted", "published"]),
          url: z.string().max(2000),
        })
        .parse(raw),
      post = this.current(input.id, input.version);
    if (this.active.has(post.id))
      throw new AppError("PHOTO_BUSY", "当前任务正在处理，请等待完成。");
    const record = post.publications.find(
      (p) => p.platform === input.platform && p.version === post.version,
    );
    if (!record)
      throw new AppError(
        "PHOTO_HANDOFF_REQUIRED",
        "请先打开此版本的平台官网，再登记真实结果。",
      );
    const url = validatePublicationUrl(input.platform, input.url);
    if (record.status === "published" && input.status !== "published")
      throw new AppError(
        "PHOTO_ALREADY_PUBLISHED",
        "已公开记录不能退回待审核。",
      );
    record.status = input.status;
    record.url = url;
    record.updatedAt = now();
    return this.persist(post);
  }
}

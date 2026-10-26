import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, extname } from "node:path";
import { id, now, type Database } from "../database";
import { AppError, safeMessage } from "../errors";
import { weiboPostInput, type WeiboPost } from "../../shared/weibo-posts";
import { weiboReceiptUrl } from "../../shared/weibo-marketing";
import type { WeiboEditorPayload } from "../../shared/weibo-publishing";
import type { WebsiteAccounts } from "../website-accounts";
import type { AppPorts } from "../ports";
import { validateOutgoingLinks } from "../links";

const indexKey = "weiboPosts:index:v1";
const key = (id: string) => `weiboPosts:v1:${id}`;
export class WeiboPosts {
  private active = new Set<string>();
  constructor(
    private deps: {
      db: Database;
      accounts: WebsiteAccounts;
      dataPath: string;
      ports: AppPorts;
      changed(): void;
    },
  ) {
    for (const post of this.list()) {
      if (post.stage === "submitting") {
        post.stage = "uncertain";
        post.message = "上次提交已中断，请核对微博后登记结果，禁止自动重发。";
        this.persist(post);
      }
      if (post.stage === "filling") {
        post.stage = "attention";
        post.message = "上次填写已中断，本地内容保留，请检查官方发布框后重试。";
        this.persist(post);
      }
    }
  }
  get isBusy() {
    return this.active.size > 0;
  }
  async open(id: string) {
    const post = this.get(id);
    if (!post.url)
      throw new AppError("WEIBO_RECEIPT_REQUIRED", "此任务尚未保存发布回执。");
    return this.deps.accounts.openWeiboPost(post.accountId, post.url);
  }
  list(accountId?: string): WeiboPost[] {
    return this.deps.db
      .setting<string[]>(indexKey, [])
      .map((id) => this.get(id))
      .filter((post) => !accountId || post.accountId === accountId);
  }
  get(id: string) {
    const post = this.deps.db.setting<WeiboPost | null>(key(id), null);
    if (!post) throw new AppError("NOT_FOUND", "微博草稿不存在。");
    return post;
  }
  private persist(post: WeiboPost) {
    post.updatedAt = now();
    this.deps.db.setSetting(key(post.id), post);
    this.deps.changed();
  }
  private editable(post: WeiboPost) {
    if (this.active.has(post.id))
      throw new AppError("WEIBO_BUSY", "微博任务正在处理中。");
    if (!["editing", "attention"].includes(post.stage))
      throw new AppError(
        "WEIBO_RESULT_EXISTS",
        "当前图文已上传或提交，请先核对发布结果，不会重复发送。",
      );
  }
  save(raw: unknown) {
    const input = weiboPostInput.parse(raw);
    const account = this.deps.accounts.get(input.accountId);
    if (
      account.provider !== "weibo" ||
      !account.uid ||
      account.status !== "connected"
    )
      throw new AppError(
        "WEBSITE_LOGIN_REQUIRED",
        "请先完成微博登录和身份核验。",
      );
    // Resource promotion still goes through verified ownership and channel permissions.
    try {
      validateOutgoingLinks(input.text, "", false);
    } catch {
      throw new AppError(
        "WEIBO_RESOURCE_REQUIRED",
        "带网盘链接的推荐内容，请从微博图文营销关联已核验的本人资料后发布。",
      );
    }
    const post: WeiboPost = input.id
      ? this.get(input.id)
      : {
          id: id("wbpost"),
          accountId: account.id,
          uid: account.uid,
          text: input.text,
          visibility: input.visibility,
          images: [],
          stage: "editing",
          message: "本地草稿已保存，未调用模型或发布。",
          url: null,
          createdAt: now(),
          updatedAt: now(),
        };
    this.editable(post);
    if (post.accountId !== account.id || post.uid !== account.uid)
      throw new AppError(
        "WEIBO_ACCOUNT_MISMATCH",
        "草稿账号不可替换，请新建草稿。",
      );
    post.text = input.text;
    post.visibility = input.visibility;
    post.stage = "editing";
    if (!input.id)
      this.deps.db.setSetting(indexKey, [
        post.id,
        ...this.deps.db.setting<string[]>(indexKey, []),
      ]);
    this.persist(post);
    return post;
  }
  private directory(post: WeiboPost) {
    return join(this.deps.dataPath, "weibo-posts", post.id);
  }
  async images(id: string) {
    const post = this.get(id);
    this.editable(post);
    this.active.add(id);
    try {
      if (!this.deps.ports.readWeiboImages)
        throw new AppError(
          "WEIBO_IMAGES_UNAVAILABLE",
          "请在桌面窗口选择图片。",
        );
      const files = await this.deps.ports.readWeiboImages();
      if (!files) return post;
      if (files.length > 9)
        throw new AppError("WEIBO_IMAGE_LIMIT", "最多选择 9 张图片。");
      const staged = join(this.directory(post), `images-${idSuffix()}`);
      await mkdir(staged, { recursive: true, mode: 0o700 });
      const images = [];
      try {
        for (const [index, file] of files.entries()) {
          const extension = extname(file.name).toLowerCase();
          const signature = file.bytes.subarray(0, 8);
          const valid =
            extension === ".png"
              ? signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
              : [".jpg", ".jpeg"].includes(extension)
                ? signature[0] === 255 && signature[1] === 216
                : extension === ".gif" &&
                  /^GIF8[79]a/.test(signature.toString("ascii"));
          if (
            !valid ||
            !file.bytes.length ||
            file.bytes.length >= 20 * 1024 * 1024
          )
            throw new AppError(
              "WEIBO_IMAGE_INVALID",
              "请选择实际 PNG、JPG、GIF 图片，每张小于 20MB。",
            );
          const name = `${String(index + 1).padStart(2, "0")}${extension}`;
          await writeFile(join(staged, name), file.bytes, { mode: 0o600 });
          images.push({
            name: `${staged.split(/[\\/]/).pop()}/${name}`,
            sha256: createHash("sha256").update(file.bytes).digest("hex"),
          });
        }
        const previous = post.images;
        post.images = images;
        post.stage = "editing";
        post.message = `已保存 ${images.length} 张本地图片，尚未上传。`;
        this.persist(post);
        for (const file of previous)
          await rm(join(this.directory(post), file.name), {
            force: true,
          }).catch(() => {});
      } catch (error) {
        await rm(staged, { recursive: true, force: true });
        throw error;
      }
      return post;
    } finally {
      this.active.delete(id);
    }
  }
  private async payload(post: WeiboPost): Promise<WeiboEditorPayload> {
    const images = [];
    for (const image of post.images) {
      const path = join(this.directory(post), image.name);
      if (
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex") !== image.sha256
      )
        throw new AppError(
          "WEIBO_IMAGE_CHANGED",
          "本地图片已变化，请重新选择。",
        );
      images.push({ ...image, path });
    }
    return {
      taskId: post.id,
      environment: post.environment,
      uid: post.uid,
      text: post.text,
      images,
      visibility: post.visibility,
      aiAssisted: false,
    };
  }
  async fill(id: string) {
    const post = this.get(id);
    if (post.stage !== "filled") this.editable(post);
    if (this.active.has(id)) throw new AppError("WEIBO_BUSY", "任务正在处理。");
    this.active.add(id);
    try {
      post.stage = "filling";
      post.message = "正在填写官方发布器并上传本地图片…";
      this.persist(post);
      const editor = await this.deps.accounts.fillWeibo(
        post.accountId,
        await this.payload(post),
      );
      post.environment = editor.environment;
      post.stage = "filled";
      post.message = "文案和图片已就绪，请核对官方窗口后确认发布。";
    } catch (error) {
      post.stage = "attention";
      post.message = safeMessage(error);
    } finally {
      this.persist(post);
      this.active.delete(id);
    }
    return post;
  }
  async submit(id: string) {
    const post = this.get(id);
    if (post.stage !== "filled")
      throw new AppError("WEIBO_FILL_REQUIRED", "请先自动填写并上传。");
    if (this.active.has(id)) throw new AppError("WEIBO_BUSY", "任务正在处理。");
    this.active.add(id);
    try {
      const receipt = await this.deps.accounts.submitWeibo(
        post.accountId,
        await this.payload(post),
        async () => {
          await this.payload(post);
          post.stage = "submitting";
          post.message = "正在提交，等待微博官方回执…";
          this.persist(post);
        },
      );
      if (receipt.status === "rejected") {
        post.stage = "filled";
        post.message = receipt.message;
      } else {
        post.stage = "submitted";
        post.url = weiboReceiptUrl(receipt.url, post.uid);
        post.message = "微博已返回提交成功回执，单条链接已保存。";
      }
    } catch (error) {
      if ((post.stage as string) === "submitting") post.stage = "uncertain";
      post.message = safeMessage(error);
    } finally {
      this.persist(post);
      this.active.delete(id);
    }
    return post;
  }
  resolve(id: string, url: string) {
    const post = this.get(id);
    if (
      this.active.has(id) ||
      !["filled", "uncertain", "submitted"].includes(post.stage)
    )
      throw new AppError("WEIBO_HANDOFF_REQUIRED", "请先完成网页填写。");
    if (url.trim()) {
      const permalink = weiboReceiptUrl(url, post.uid);
      if (post.url && post.url !== permalink)
        throw new AppError(
          "WEIBO_RECEIPT_MISMATCH",
          "请使用已登记的单条微博链接。",
        );
      post.url = permalink;
      post.stage = "submitted";
      post.message = "单条微博链接已登记，不会重复发布。";
    } else {
      if (post.url)
        throw new AppError(
          "WEIBO_RESULT_EXISTS",
          "已有回执时不能返回编辑重发。",
        );
      post.stage = "editing";
      post.message = "已确认尚未发布。再次填写前请先在网页保存或清空旧草稿。";
    }
    this.persist(post);
    return post;
  }
}
const idSuffix = () => id("images").replace(/[^a-zA-Z0-9_-]/g, "");

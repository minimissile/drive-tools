import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppError } from "../core/errors";
import { decodeWechatImageReceipt } from "./wechat-upload-receipt";

type Receipt = { url: string; id?: string };

/** Workspace/account/content scoped receipts, independent of draft or source URL. */
export class WechatImageUploads {
  private pending = new Map<string, Promise<Receipt>>();
  constructor(
    private folder: () => string,
    private verify: (bytes: Buffer, receipt: Receipt) => Promise<void>,
  ) {}

  async use(uid: string, bytes: Buffer, upload: () => Promise<Receipt>) {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const account = createHash("sha256").update(uid).digest("hex");
    const file = join(
      this.folder(),
      "cache",
      "wechat-uploads-v1",
      account,
      `${sha256}.json`,
    );
    const running = this.pending.get(file);
    if (running) return running;
    const task = this.resolve(file, uid, sha256, bytes, upload);
    this.pending.set(file, task);
    try {
      return await task;
    } finally {
      this.pending.delete(file);
    }
  }

  private async resolve(
    file: string,
    uid: string,
    sha256: string,
    bytes: Buffer,
    upload: () => Promise<Receipt>,
  ) {
    let saved: Receipt | undefined;
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (value && value.uid === uid && value.sha256 === sha256)
        saved = decodeWechatImageReceipt({
          base_resp: { ret: 0 },
          cdn_url: value.receipt?.url,
          file_id: value.receipt?.id,
        });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError) &&
        !(error instanceof AppError)
      )
        throw error;
    }
    if (saved) {
      try {
        await this.verify(bytes, saved);
        return saved;
      } catch (error) {
        // A transient read failure must never cause another material upload.
        if (
          !(error instanceof AppError) ||
          error.code !== "WECHAT_IMAGE_MISSING"
        )
          throw error;
        await unlink(file).catch(() => {});
      }
    }
    const folder = dirname(file);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const receipt = await upload();
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ uid, sha256, receipt }), {
        mode: 0o600,
      });
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return receipt;
  }
}

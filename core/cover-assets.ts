import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "./errors";

// Use decimal KB so the saved file also fits a 200 KiB limit.
export const resourceCoverMaxBytes = 200_000;
export const coverFilePattern = /^[a-f0-9]{64}\.(png|webp)$/;

export function assertWebpCover(bytes: Buffer) {
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length ||
    !["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))
  )
    throw new AppError(
      "INVALID_COVER",
      "封面转换为 WebP 失败，请重新选择图片。",
    );
  if (bytes.length > resourceCoverMaxBytes)
    throw new AppError(
      "COVER_TOO_LARGE",
      "封面压缩后仍超过200KB，请重新选择图片。",
    );
}

export async function saveResourceCover(dataPath: string, bytes: Buffer) {
  // Check the actual encoder output before writing a file or changing a resource.
  assertWebpCover(bytes);
  const coverId = createHash("sha256").update(bytes).digest("hex");
  await mkdir(join(dataPath, "covers"), { recursive: true, mode: 0o700 });
  await writeFile(join(dataPath, "covers", `${coverId}.webp`), bytes, {
    mode: 0o600,
  });
  return coverId;
}

export async function readResourceCover(dataPath: string, coverId: string) {
  if (!/^[a-f0-9]{64}$/.test(coverId))
    throw new AppError("INVALID_COVER", "封面记录不正确，请重新选择图片。");
  // Historical resources and backups retain their original PNG files.
  for (const extension of ["webp", "png"] as const) {
    const path = join(dataPath, "covers", `${coverId}.${extension}`);
    try {
      const bytes = await readFile(path);
      return { path, bytes, extension, mime: `image/${extension}` };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new AppError("COVER_MISSING", "封面文件已丢失，请重新上传或恢复备份。");
}

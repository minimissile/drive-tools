import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "./errors";
import type { ContentImage } from "../shared/content-sources";

export async function saveContentImage(
  dataPath: string,
  bytes: Buffer,
  displayName: string,
  storage: ContentImage["storage"] = "content-assets",
  allowGif = false,
): Promise<ContentImage> {
  if (!bytes.length || bytes.length >= 20 * 1024 * 1024)
    throw new AppError("CONTENT_IMAGE", "单张图片需要小于 20MB。");
  const png = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216;
  const gif =
    allowGif && /^GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii"));
  if (!png && !jpeg && !gif)
    throw new AppError("CONTENT_IMAGE", "内容配图仅支持 PNG / JPG。");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = `${sha256}.${png ? "png" : gif ? "gif" : "jpg"}`;
  const folder = join(dataPath, storage!);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(join(folder, file), bytes, { mode: 0o600 });
  return { name: displayName, file, sha256, storage };
}
export async function readContentImage(dataPath: string, image: ContentImage) {
  if (!/^[a-f0-9]{64}\.(png|jpg|gif)$/.test(image.file))
    throw new AppError("CONTENT_IMAGE", "图片文件名不正确。");
  const path = contentImagePath(dataPath, image);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size >= 20 * 1024 * 1024)
    throw new AppError("CONTENT_IMAGE", "图片文件不可读取。");
  const bytes = await readFile(path);
  if (createHash("sha256").update(bytes).digest("hex") !== image.sha256)
    throw new AppError("CONTENT_IMAGE", "图片文件已变化，请重新采集。");
  return bytes;
}

export function contentImagePath(dataPath: string, image: ContentImage) {
  const storage = image.storage ?? "content-assets";
  if (
    !["content-assets", "zhihu-assets"].includes(storage) ||
    !/^[a-f0-9]{64}\.(png|jpg|gif)$/.test(image.file)
  )
    throw new AppError("CONTENT_IMAGE", "图片存储位置不正确。");
  return join(dataPath, storage, image.file);
}

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "../errors";
import { readLimitedBytes } from "../http";
import { musicAudioUrl } from "./network";

// Base64 stays below shared/video.ts's 28 MiB input limit.
export const musicAudioMaxBytes = 20 * 1024 * 1024;
export interface MusicAsset {
  file: string;
  mime: string;
}
const format = (bytes: Buffer): { mime: string; extension: string } | null => {
  if (bytes.length < 16) return null;
  if (
    bytes.subarray(0, 3).toString() === "ID3" ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0)
  )
    return { mime: "audio/mpeg", extension: "mp3" };
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WAVE"
  )
    return { mime: "audio/wav", extension: "wav" };
  if (bytes.subarray(0, 4).toString() === "OggS")
    return { mime: "audio/ogg", extension: "ogg" };
  if (bytes.subarray(4, 8).toString() === "ftyp")
    return { mime: "audio/mp4", extension: "m4a" };
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0)
    return { mime: "audio/aac", extension: "aac" };
  return null;
};
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const cacheError = () =>
  new AppError(
    "MUSIC_CACHE",
    "本地配乐缓存不可用或已被修改，请显式重试重新获取。",
  );

async function directory(dataPath: string) {
  const path = join(dataPath, "music");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== join(await realpath(dataPath), "music")
  )
    throw cacheError();
  return path;
}

export async function readMusicAsset(dataPath: string, asset: MusicAsset) {
  if (!/^[a-f0-9]{64}\.(mp3|wav|ogg|m4a|aac)$/.test(asset.file))
    throw cacheError();
  const path = join(await directory(dataPath), asset.file);
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => {
    throw cacheError();
  });
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > musicAudioMaxBytes) throw cacheError();
    const bytes = await file.readFile();
    const type = format(bytes);
    if (
      hash(bytes) !== asset.file.slice(0, 64) ||
      !type ||
      type.mime !== asset.mime ||
      !asset.file.endsWith(`.${type.extension}`)
    )
      throw cacheError();
    return `data:${type.mime};base64,${bytes.toString("base64")}`;
  } finally {
    await file.close();
  }
}

export async function downloadMusicAsset(
  dataPath: string,
  urls: string[],
  request: (url: string, init: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<MusicAsset> {
  // Try only one supplied URL per operation. Failures never cause hidden requests.
  const target = urls.map(musicAudioUrl).find((url): url is string => !!url);
  if (!target)
    throw new AppError("MUSIC_AUDIO", "该歌曲暂未提供可下载的抖音音频地址。");
  const response = await request(target, {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new AppError(
      "MUSIC_AUDIO",
      `配乐下载未成功（HTTP ${response.status}），可稍后显式重试。`,
    );
  }
  const bytes = await readLimitedBytes(response, musicAudioMaxBytes);
  const type = format(bytes);
  if (
    !type ||
    /(?:text\/|html|json)/i.test(response.headers.get("content-type") ?? "")
  )
    throw new AppError("MUSIC_AUDIO", "下载内容不是支持的音频，未保存为配乐。");
  signal.throwIfAborted();
  const file = `${hash(bytes)}.${type.extension}`;
  const folder = await directory(dataPath);
  const path = join(folder, file);
  const temporary = join(folder, `.music-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    signal.throwIfAborted();
    // A hard link publishes a completed inode without overwriting an existing
    // asset. Another song with identical bytes can never observe a partial file.
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const asset = { file, mime: type.mime };
    await readMusicAsset(dataPath, asset);
    return asset;
  } finally {
    await rm(temporary, { force: true });
  }
}

import type { MusicTrack } from "../../shared/music";
import { AppError } from "../errors";
import { musicAudioUrl } from "./network";

export interface StoredMusicTrack extends Omit<MusicTrack, "audioCached"> {
  audioUrls: string[];
}
export const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown, length: number) =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, length)
    : "";
const numeric = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)
      ? Number(value)
      : null;

/** Modern V8 exposes the original number token; never use a rounded music ID. */
export function parseMusicJson(raw: string): unknown {
  return JSON.parse(
    raw,
    (_key: string, value: unknown, context?: { source?: string }) => {
      if (
        typeof value === "number" &&
        Number.isInteger(value) &&
        !Number.isSafeInteger(value)
      ) {
        if (!context?.source || !/^-?\d+$/.test(context.source))
          throw new AppError(
            "MUSIC_INTEGER",
            "音乐响应包含无法精确读取的ID，请使用当前源码运行环境解析归档。",
          );
        return context.source;
      }
      return value;
    },
  );
}

export function musicData(payload: unknown) {
  const envelope = record(payload);
  if (
    !envelope ||
    (envelope.code !== undefined && numeric(envelope.code) !== 200)
  )
    throw new AppError(
      "MUSIC_RESPONSE",
      "TikHub 未返回成功的音乐数据，响应已保留，请稍后手动重试。",
    );
  const data = record(envelope.data);
  if (!data)
    throw new AppError(
      "MUSIC_RESPONSE",
      "TikHub 音乐响应结构无法识别，原始响应已保留。",
    );
  if (data.status_code !== undefined && numeric(data.status_code) !== 0)
    throw new AppError(
      "MUSIC_RESPONSE",
      "抖音未返回可用音乐数据，原始响应已保留。",
    );
  return data;
}

export function musicUrls(value: Record<string, unknown>) {
  const play = record(value.play_url) ?? record(value.play_addr);
  const candidates = [
    ...(Array.isArray(play?.url_list) ? play.url_list : []),
    play?.uri,
    typeof value.play_url === "string" ? value.play_url : null,
  ];
  return [
    ...new Set(
      candidates.map(musicAudioUrl).filter((url): url is string => !!url),
    ),
  ].slice(0, 4);
}

function track(value: unknown, index: number): StoredMusicTrack | null {
  const row = record(value);
  if (!row) return null;
  const music = record(row.music_info) ?? record(row.music) ?? row;
  const idValue = music.id_str ?? music.music_id ?? music.mid ?? music.id;
  const id =
    typeof idValue === "number" && Number.isSafeInteger(idValue)
      ? String(idValue)
      : typeof idValue === "string"
        ? idValue
        : "";
  const title = text(music.title ?? music.music_name, 200);
  if (!/^\d{1,30}$/.test(id) || !title) return null;
  const duration = numeric(music.duration);
  const rank = numeric(row.rank ?? row.position);
  return {
    id,
    title,
    author: text(music.author ?? music.author_name, 100),
    rank:
      rank !== null && Number.isSafeInteger(rank) && rank > 0
        ? rank
        : index + 1,
    ...(duration !== null && duration > 0 && duration < 86400
      ? { durationSeconds: duration }
      : {}),
    audioUrls: musicUrls(music),
  };
}

export function parseMusicChart(payload: unknown): StoredMusicTrack[] {
  const data = musicData(payload);
  const billboard = record(data.music_billboard) ?? record(data.billboard_data);
  const list =
    data.music_list ??
    data.music_infos ??
    billboard?.music_list ??
    (Array.isArray(data.music_billboard) ? data.music_billboard : undefined);
  if (!Array.isArray(list))
    throw new AppError(
      "MUSIC_RESPONSE",
      "TikHub 音乐榜结构无法识别，原始响应已保留。",
    );
  const tracks = new Map<string, StoredMusicTrack>();
  for (let index = 0; index < Math.min(list.length, 500); index++) {
    const item = track(list[index], index);
    if (item && !tracks.has(item.id)) tracks.set(item.id, item);
    if (tracks.size >= 20) break;
  }
  if (list.length && !tracks.size)
    throw new AppError(
      "MUSIC_RESPONSE",
      "音乐榜未识别到有效歌曲，原始响应已保留。",
    );
  return [...tracks.values()];
}

export function parseMusicDetail(
  payload: unknown,
  musicId: string,
): StoredMusicTrack {
  const data = musicData(payload);
  const item = track(record(data.music_info) ?? record(data.music) ?? data, 0);
  if (!item || item.id !== musicId)
    throw new AppError(
      "MUSIC_RESPONSE",
      "音乐详情与所选歌曲不匹配，原始响应已保留。",
    );
  return item;
}

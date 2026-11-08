import { isIP } from "node:net";
import { AppError } from "../errors";

export const musicApiPaths = {
  chart: "/api/v1/douyin/app/v3/fetch_music_hot_search_list",
  detail: "/api/v1/douyin/app/v3/fetch_music_detail",
} as const;

// Audio URLs are provided by Douyin. Never accept arbitrary user-supplied hosts.
const audioDomains = [
  "douyincdn.com",
  "douyinstatic.com",
  "douyin.com",
  "iesdouyin.com",
  "amemv.com",
  "snssdk.com",
  "pstatp.com",
  "byteimg.com",
  "bytecdn.cn",
  "bytedance.com",
  "ibytedtos.com",
  "bytefcdn.com",
  "zjcdn.com",
];
export function musicNetworkTarget(raw: string, method = "GET"): URL {
  try {
    const url = new URL(raw);
    if (
      method.toUpperCase() !== "GET" ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
      url.hash
    )
      throw new Error();
    if (url.hostname === "api.tikhub.io") {
      if (
        !Object.values(musicApiPaths).includes(
          url.pathname as typeof musicApiPaths.chart,
        )
      )
        throw new Error();
    } else if (
      !audioDomains.some(
        (domain) =>
          url.hostname === domain || url.hostname.endsWith(`.${domain}`),
      )
    ) {
      throw new Error();
    }
    return url;
  } catch {
    throw new AppError("MUSIC_URL", "音乐地址不属于允许的抖音音频来源。");
  }
}

export function musicAudioUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 12000) return null;
  try {
    const url = musicNetworkTarget(raw);
    return url.hostname === "api.tikhub.io" ? null : url.href;
  } catch {
    return null;
  }
}

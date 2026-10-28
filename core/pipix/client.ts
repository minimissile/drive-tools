import { AppError } from "../errors";
import { readLimited, readLimitedBytes } from "../http";
import { parsePipixPage } from "./parser";

export function pipixShareUrl(raw: string): URL {
  const matches = raw.match(/https?:\/\/[^\s<>"'，。！？、）】]+/g) ?? [];
  if (matches.length !== 1)
    throw new AppError(
      "PIPIX_URL",
      "每次采集请提供一个皮皮虾分享链接；支持粘贴整段分享文案。",
    );
  return validateUrl(matches[0].replace(/[)\],;]+$/, ""), false);
}
function validateUrl(raw: string, media: boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError("PIPIX_URL", "分享地址不正确。");
  }
  const host = media
    ? /^[a-z0-9-]+\.byteimg\.com$/.test(u.hostname)
    : u.hostname === "h5.pipix.com";
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    !host ||
    (!media &&
      !/^\/(?:ppx\/item\/\d{8,30}\/?|s\/[A-Za-z0-9_-]+\/?)$/.test(u.pathname))
  )
    throw new AppError(
      "PIPIX_URL",
      media
        ? "图片地址不属于已支持的皮皮虾图片域名。"
        : "请使用 h5.pipix.com 的官方帖子或短分享链接。",
    );
  u.hash = "";
  return u;
}
export class PipixClient {
  constructor(private request: typeof fetch = fetch) {}
  private async response(raw: string, media: boolean, signal: AbortSignal) {
    let u = validateUrl(raw, media);
    for (let hop = 0; hop <= 5; hop++) {
      const response = await this.request(u.href, {
        redirect: "manual",
        signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const next = response.headers.get("location");
        if (!next) break;
        u = validateUrl(new URL(next, u).href, media);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(
          "PIPIX_HTTP",
          `皮皮虾${media ? "图片" : "分享页"}读取失败（HTTP ${response.status}），请稍后重试。`,
        );
      }
      return { response, url: u };
    }
    throw new AppError("PIPIX_REDIRECT", "分享链接跳转过多或地址不可用。");
  }
  async collect(raw: string, signal: AbortSignal) {
    const input = pipixShareUrl(raw);
    const { response, url } = await this.response(input.href, false, signal);
    const expected =
      input.pathname.match(/\/item\/(\d+)/)?.[1] ??
      url.pathname.match(/\/item\/(\d+)/)?.[1];
    return parsePipixPage(
      await readLimited(response, 4 * 1024 * 1024),
      expected,
    );
  }
  async image(url: string, signal: AbortSignal) {
    const { response } = await this.response(url, true, signal);
    const bytes = await readLimitedBytes(response, 20 * 1024 * 1024 - 1);
    if (!bytes.length) throw new AppError("PIPIX_IMAGE", "图片数据为空。");
    return bytes;
  }
}

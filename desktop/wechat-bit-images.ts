import type { BrowserContext } from "playwright-core";
import { AppError } from "../core/errors";
import { normalizeWechatRemoteImageUrl } from "./wechat-image-policy";

/** Material re-use checks stay in the selected profile, including the CDN request. */
export async function readBitWechatImage(context: BrowserContext, raw: string) {
  const allowed = (value: string) => {
    const url = normalizeWechatRemoteImageUrl(value);
    if (!["mmbiz.qpic.cn", "mmbiz.qlogo.cn"].includes(url.hostname))
      throw new AppError(
        "WECHAT_IMAGE_URL",
        "指纹环境支持读取微信素材图片；其他网站的图片请先上传为本地图片。",
      );
    return url.href;
  };
  const url = allowed(raw);
  const page = await context.newPage();
  try {
    await page.route("**/*", async (route) => {
      try {
        allowed(route.request().url());
        await route.fallback();
      } catch {
        await route.abort();
      }
    });
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
      referer: "https://mp.weixin.qq.com/",
    });
    allowed(page.url());
    if (!response?.ok())
      throw new AppError(
        [404, 410].includes(response?.status() ?? 0)
          ? "WECHAT_IMAGE_MISSING"
          : "WECHAT_IMAGE_DOWNLOAD",
        "微信素材图片读取失败，请检查关联环境的网络后重试。",
      );
    if (Number(response.headers()["content-length"]) > 10 * 1024 * 1024)
      throw new AppError(
        "WECHAT_IMAGE_DOWNLOAD",
        "图片超过 10MB，请压缩后上传。",
      );
    const bytes = await response.body();
    if (!bytes.length || bytes.length > 10 * 1024 * 1024)
      throw new AppError("WECHAT_IMAGE_DOWNLOAD", "图片需要在 10MB 以内。");
    return bytes;
  } finally {
    await page.close().catch(() => {});
  }
}

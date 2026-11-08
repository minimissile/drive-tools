import { AppError } from "../core/errors";
import { isIP } from "node:net";

export function isPublicWechatImageAddress(address: string) {
  const text = address.toLowerCase();
  if (isIP(text) === 4) {
    const [a, b] = text.split(".").map(Number);
    return (
      a > 0 &&
      a !== 10 &&
      a !== 127 &&
      a < 224 &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && b === 168) &&
      !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 198 && (b === 18 || b === 19))
    );
  }
  return isIP(text) === 6 && /^[23][0-9a-f]{0,3}:/.test(text);
}

/** Fragments describe article display state and are never part of an image download. */
export function normalizeWechatRemoteImageUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(
      "WECHAT_IMAGE_URL",
      "请使用可公开访问的 HTTPS 图片，或上传本地图片。",
    );
  }
  url.hash = "";
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !url.hostname.includes(".") ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)
  )
    throw new AppError(
      "WECHAT_IMAGE_URL",
      "请使用可公开访问的 HTTPS 图片，或上传本地图片。",
    );
  return url;
}

/** This protocol is an image-only preview transport, not a general URL proxy. */
export function wechatPreviewImageSource(value: string, method: string) {
  const request = new URL(value);
  if (
    request.protocol !== "panxu-media:" ||
    request.hostname !== "wechat-image" ||
    request.username ||
    request.password ||
    request.port ||
    request.hash ||
    request.pathname !== "/" ||
    !["GET", "HEAD"].includes(method) ||
    request.searchParams.size !== 1 ||
    request.searchParams.getAll("url").length !== 1
  )
    throw new AppError("WECHAT_IMAGE_PREVIEW", "图片预览地址无效。");
  const source = request.searchParams.get("url")!;
  if (!source || source.length > 8000)
    throw new AppError("WECHAT_IMAGE_PREVIEW", "图片预览地址无效。");
  return normalizeWechatRemoteImageUrl(source).href;
}

/** Header filtering is followed by nativeImage decoding and a PNG re-encode. */
export function assertWechatPreviewBytes(bytes: Uint8Array) {
  const starts = (signature: number[], at = 0) =>
    signature.every((byte, index) => bytes[at + index] === byte);
  const png = starts([137, 80, 78, 71, 13, 10, 26, 10]);
  const jpeg = starts([255, 216, 255]);
  const gif =
    starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97]);
  const webp = starts([82, 73, 70, 70]) && starts([87, 69, 66, 80], 8);
  if (
    !bytes.length ||
    bytes.length > 10 * 1024 * 1024 ||
    !(png || jpeg || gif || webp)
  )
    throw new AppError(
      "WECHAT_IMAGE_PREVIEW",
      "预览仅支持 10MB 以内的 PNG、JPG、GIF 或 WebP 图片。",
    );
}

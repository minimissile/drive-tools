import { isWechatImageUrl, wechatHtml } from "../../shared/wechat-markup";

/** The renderer never downloads arbitrary remote images directly. */
export function wechatImagePreviewUrl(raw: string) {
  try {
    const url = new URL(raw);
    if (!isWechatImageUrl(url)) return "";
    if (url.protocol === "https:")
      return `panxu-media://wechat-image/?url=${encodeURIComponent(url.href)}`;
    if (url.protocol === "panxu-media:" && url.hostname === "wechat")
      return raw;
  } catch {
    // Keep malformed addresses in the editable draft; don't request them.
  }
  return "";
}

const entities: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
};
export function wechatPreviewHtml(body: string) {
  return wechatHtml(body).replace(
    /(<img\b[^>]*\bsrc=")([^"]+)(")/g,
    (_, before: string, escaped: string, after: string) => {
      const url = escaped.replace(
        /&(?:amp|quot|#39|lt|gt);/g,
        (entity) => entities[entity],
      );
      return `${before}${wechatImagePreviewUrl(url)}${after}`;
    },
  );
}

import { articleHtml } from "./article-markup";
import { providerSpecs } from "./providers";

const resourceHosts = new Set([
  ...Object.values(providerSpecs).map((spec) => spec.shareHost),
  "yun.baidu.com",
  "pan.uc.cn",
  "fast.uc.cn",
  "guangyapan.com",
  "www.guangyapan.com",
]);

/** Recognizes supported share URLs without importing backend parsing or state. */
export function isWechatResourceUrl(url: URL) {
  return (
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.port &&
    resourceHosts.has(url.hostname) &&
    (/^\/s\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname) ||
      (["pan.baidu.com", "yun.baidu.com"].includes(url.hostname) &&
        url.pathname === "/share/init" &&
        /^[a-zA-Z0-9_-]+$/.test(url.searchParams.get("surl") ?? "")))
  );
}

export function isWechatImageUrl(url: URL) {
  if (url.username || url.password || url.port) return false;
  if (url.protocol === "panxu-media:")
    return (
      url.hostname === "wechat" &&
      /^\/[a-f0-9]{64}\.(png|jpg|gif)$/.test(url.pathname) &&
      !url.search &&
      !url.hash
    );
  return url.protocol === "https:";
}
export function wechatArticleImages(body: string) {
  return Array.from(
    body.matchAll(
      /!\[([^\]\n]*)\]\((https:\/\/[^\s)]+|panxu-media:\/\/[^\s)]+)\)/gi,
    ),
    (match) => ({
      markup: match[0],
      alt: match[1],
      url: match[2],
      index: match.index!,
    }),
  );
}

/** Normalize editable prose only; existing links, images and code remain intact. */
export function linkifyWechatMarkdown(body: string) {
  const protectedMarkup =
    /```[\s\S]*?(?:```|(?![\s\S]))|~~~[\s\S]*?(?:~~~|(?![\s\S]))|`[^`\n]*`|!?\[[^\]\n]*\]\([^\n)]*\)|^\s*\[[^\]\n]+\]:[^\n]*$/gm;
  const prose = (value: string) =>
    value.replace(/https?:\/\/[^\s<>"'，。；）)\]]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        if (url.username || url.password || url.port) return raw;
        return `[${isWechatResourceUrl(url) ? "查看资源" : raw}](${raw})`;
      } catch {
        return raw;
      }
    });
  let result = "",
    offset = 0;
  for (const match of body.matchAll(protectedMarkup)) {
    result += prose(body.slice(offset, match.index)) + match[0];
    offset = match.index! + match[0].length;
  }
  return result + prose(body.slice(offset));
}
export function wechatHtml(body: string) {
  // WeChat may strip external anchor attributes. Keep resource URLs, including
  // extraction-code parameters, visible so the saved draft remains usable.
  return articleHtml(body, isWechatImageUrl).replace(
    /<a href="([^"]+)" rel="noopener noreferrer">([^<]*)<\/a>/g,
    (anchor, href: string, label: string) => {
      try {
        const url = new URL(href.replace(/&amp;/g, "&"));
        if (!isWechatResourceUrl(url) || label.includes(href)) return anchor;
        return `<a href="${href}" rel="noopener noreferrer">${label}（${href}）</a>`;
      } catch {
        return anchor;
      }
    },
  );
}

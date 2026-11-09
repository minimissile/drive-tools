import { articleHtml } from "./article-markup";
import { providerSpecs } from "./providers";
import {
  typesetWechatHtml,
  wechatTypesettingVersion,
} from "./wechat-typesetting";

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
function visibleResourceLinks(html: string) {
  // WeChat may strip external anchor attributes. Keep resource URLs, including
  // extraction-code parameters, visible so the saved draft remains usable.
  return html.replace(
    /(<a href="([^"]+)" rel="noopener noreferrer"[^>]*>)([\s\S]*?)<\/a>/g,
    (anchor, opening: string, href: string, label: string) => {
      try {
        const url = new URL(href.replace(/&amp;/g, "&"));
        if (!isWechatResourceUrl(url) || label.includes(href)) return anchor;
        return `${opening}${label}（${href}）</a>`;
      } catch {
        return anchor;
      }
    },
  );
}

/** Older uncertain saves without a proof must be checked against their original delivery. */
export function wechatLegacyHtml(body: string) {
  return visibleResourceLinks(articleHtml(body, isWechatImageUrl));
}

/** The native WeChat entry accepts one URL; select the first resource in reading order. */
export function wechatReadMoreUrl(body: string) {
  const prose = body.replace(
    /```[\s\S]*?(?:```|(?![\s\S]))|~~~[\s\S]*?(?:~~~|(?![\s\S]))/g,
    "",
  );
  const html = articleHtml(prose, isWechatImageUrl);
  for (const match of html.matchAll(/<a href="([^"]+)"/g)) {
    try {
      const url = new URL(match[1].replace(/&amp;/g, "&"));
      if (isWechatResourceUrl(url)) return url.href;
    } catch {
      /* Generated links are validated; ignore any unsupported address. */
    }
  }
  return "";
}

export function wechatHtml(body: string, version = wechatTypesettingVersion) {
  if (version < 1) return wechatLegacyHtml(body);
  return visibleResourceLinks(
    typesetWechatHtml(
      articleHtml(body, isWechatImageUrl),
      isWechatResourceUrl,
      {
        readMoreUrl: version >= 2 ? wechatReadMoreUrl(body) : "",
        compactLists: version >= 2,
        entryLabels: version >= 3,
      },
    ),
  );
}

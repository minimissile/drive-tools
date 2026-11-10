import { providerSpecs } from "./providers";
import {
  getWechatTemplate,
  type WechatResourceAppearance,
} from "./wechat-templates";

function providerName(url: URL) {
  const host =
    (
      {
        "yun.baidu.com": "pan.baidu.com",
        "pan.uc.cn": "drive.uc.cn",
        "fast.uc.cn": "drive.uc.cn",
        "guangyapan.com": "www.guangyapan.com",
      } as Record<string, string>
    )[url.hostname] ?? url.hostname;
  return `${Object.values(providerSpecs).find((provider) => provider.shareHost === host)?.name ?? "资源"}网盘资源`;
}

/** Accept only a short caption ending in a colon, or separators; never consume prose. */
function caption(value: string) {
  const text = value.replace(/<\/?strong>/g, "").trim();
  if (/<[^>]+>/.test(text)) return null;
  if (/^[\p{P}\p{S}\s]*$/u.test(text)) return "";
  const label = text
    .replace(/^[\p{P}\p{S}\s]+/u, "")
    .replace(/[:：]\s*$/, "")
    .trim();
  if (
    !/[:：]\s*$/.test(text) ||
    !label ||
    label.length > 60 ||
    /[。！？.!?；;]/.test(label.replace(/&(?:amp|lt|gt|quot|#39);/g, ""))
  )
    return null;
  return label;
}

const codePattern = /(?:提取码|访问码|密码)\s*[:：]?\s*[a-zA-Z0-9]{4,8}\b/g;

/** Keep card presentation identical across supported source layouts and legacy verification. */
export function wechatResourceCard(
  href: string,
  title: string,
  code: string,
  help: string,
  appearance: WechatResourceAppearance = getWechatTemplate().resource,
) {
  return (
    `<section style="${appearance.container}">` +
    `<p style="${appearance.title}">${title}</p>` +
    `<p style="${appearance.address}"><a href="${href}" rel="noopener noreferrer">${href}</a></p>` +
    (code ? `<p style="${appearance.code}">${code}</p>` : "") +
    `<p style="${appearance.help}">${help}</p></section>`
  );
}

/** Generated/escaped paragraphs only. Recognize resource-only blocks by structure, not topic words. */
export function wechatResourceCards(
  html: string,
  isResource: (url: URL) => boolean,
  readMoreUrl = "",
  appearance?: WechatResourceAppearance,
) {
  return html.replace(/<p>([^\n]*?)<\/p>/g, (paragraph, content: string) => {
    const anchors = [
      ...content.matchAll(
        /<a href="([^"]+)" rel="noopener noreferrer">([\s\S]*?)<\/a>/g,
      ),
    ];
    if (!anchors.length) return paragraph;
    const urls: URL[] = [];
    try {
      for (const anchor of anchors) {
        const url = new URL(anchor[1].replace(/&amp;/g, "&"));
        if (!isResource(url) || /<(?!\/?strong>)[^>]+>/.test(anchor[2]))
          return paragraph;
        urls.push(url);
      }
    } catch {
      return paragraph;
    }
    const captions: string[] = [],
      codes: string[] = [];
    let offset = 0;
    for (let i = 0; i <= anchors.length; i++) {
      const part = content
        .slice(offset, i < anchors.length ? anchors[i].index : content.length)
        .replace(/<\/?strong>/g, "");
      const foundCodes = [...part.matchAll(codePattern)].map(
        (match) => match[0],
      );
      const rest = part.replace(codePattern, "");
      const label = caption(rest);
      // The final segment can contain extraction codes/separators, not an instruction or another caption.
      if (
        label === null ||
        (i === 0 && foundCodes.length) ||
        (i === anchors.length && label)
      )
        return paragraph;
      if (i) codes[i - 1] = foundCodes.join("；");
      if (i < anchors.length) {
        captions[i] = label;
        offset = anchors[i].index! + anchors[i][0].length;
      }
    }
    return anchors
      .map((anchor, i) => {
        const href = anchor[1],
          label = anchor[2].replace(/<\/?strong>/g, "").trim(),
          url = urls[i];
        const generic = [
          href,
          url.href,
          "查看资源",
          "链接",
          "下载链接",
          "资源链接",
        ].includes(label);
        // The word list only chooses a display title; it does not decide whether a card exists.
        const specificCaption = captions[i]
          .replace(/链接|入口|地址|资源|资料|网盘|下载|获取|查看|测试/g, "")
          .replace(/[\p{P}\p{S}\s]/gu, "");
        const title = specificCaption
          ? `${captions[i]}${generic ? "" : ` · ${label}`}`
          : generic
            ? providerName(url)
            : label;
        const help =
          url.href === readMoreUrl
            ? "点击文末“阅读原文”打开资源"
            : "复制链接到浏览器打开";
        return wechatResourceCard(href, title, codes[i], help, appearance);
      })
      .join("");
  });
}

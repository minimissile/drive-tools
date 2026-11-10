import { providerSpecs } from "./providers";
import { getWechatTemplate, type WechatTemplateId } from "./wechat-templates";
import { layoutWechatTemplate } from "./wechat-template-layout";
import {
  wechatResourceCard,
  wechatResourceCards,
} from "./wechat-resource-cards";

export const wechatTypesettingVersion = 5;

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
  return `${Object.values(providerSpecs).find((provider) => provider.shareHost === host)?.name ?? "资源"}网盘`;
}

/** Only generated, escaped HTML is accepted here. No source HTML or CSS is imported. */
export function typesetWechatHtml(
  html: string,
  isResource: (url: URL) => boolean,
  options: {
    readMoreUrl?: string;
    compactLists?: boolean;
    entryLabels?: boolean;
    resourceBlocks?: boolean;
    templateId?: WechatTemplateId;
  } = {},
) {
  const { bodyStyle, styles, resource, sectionLayout } = getWechatTemplate(
    options.templateId,
  );
  if (options.compactLists !== false)
    html = html.replace(
      /<(ul|ol)([^>]*)>([\s\S]*?)<\/\1>/g,
      (_list, tag, attributes, content: string) => {
        const items = content
          .replace(/<li>\s*<\/li>/g, "")
          .replace(/>\s+</g, "><")
          .trim();
        return items ? `<${tag}${attributes}>${items}</${tag}>` : "";
      },
    );
  const resources = html.replace(
    /<p>([^\n]*?)<\/p>/g,
    (paragraph, content: string) => {
      const match = content.match(
        /^(.*?)<a href="([^"]+)" rel="noopener noreferrer">([^<]*)<\/a>(.*?)$/,
      );
      if (
        !match ||
        !(options.entryLabels
          ? /^(?:(?:下载|网盘|资源|资料|测试)?链接|资源|资料|(?:测试|下载|资源|获取)?入口)?$/.test(
              match[1].replace(/[\p{P}\p{S}\s]/gu, ""),
            )
          : /^\s*(?:(?:下载|网盘|资源|资料)?链接|资源|资料)?\s*[:：]?\s*$/.test(
              match[1],
            ))
      )
        return paragraph;
      if (
        !/^\s*(?:(?:提取码|访问码|密码)\s*[:：]?\s*[a-zA-Z0-9]{4,8})?\s*[。.]?\s*$/.test(
          match[4],
        )
      )
        return paragraph;
      const [, , href, label, suffix] = match;
      let url: URL;
      try {
        url = new URL(href.replace(/&amp;/g, "&"));
      } catch {
        return paragraph;
      }
      if (!isResource(url)) return paragraph;
      const generic = [
        href,
        url.href,
        "查看资源",
        "链接",
        "下载链接",
        "资源链接",
      ].includes(label);
      const title = generic ? `${providerName(url)}资源` : label;
      const code = suffix.trim().replace(/[。.]$/, "");
      const help =
        url.href === options.readMoreUrl
          ? "点击文末“阅读原文”打开资源"
          : "复制链接到浏览器打开";
      return wechatResourceCard(href, title, code, help, resource);
    },
  );
  const currentResources = options.resourceBlocks
    ? wechatResourceCards(resources, isResource, options.readMoreUrl, resource)
    : resources;
  const styled = currentResources.replace(
    /<(h[2-6]|p|strong|blockquote|ul|ol|li|a|img|hr|pre|code)(?=[ >])([^>]*)>/g,
    (tag, name: string, attributes: string) =>
      /\bstyle=/.test(attributes)
        ? tag
        : `<${name}${attributes} style="${styles[name]}">`,
  );
  return `<section style="${bodyStyle}">${sectionLayout ? layoutWechatTemplate(styled, sectionLayout) : styled}</section>`;
}

import { providerSpecs } from "./providers";

export const wechatTypesettingVersion = 3;

const bodyStyle =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;font-size:16px;line-height:1.85;color:#283245;text-align:left;text-align-last:left;letter-spacing:0;word-break:normal;overflow-wrap:break-word;";
const styles: Record<string, string> = {
  p: "margin:0 0 18px;padding:0;line-height:1.85;text-align:left;text-align-last:left;letter-spacing:0;",
  h2: "margin:28px 0 14px;font-size:22px;font-weight:700;line-height:1.5;color:#1d293d;",
  h3: "margin:26px 0 12px;font-size:20px;font-weight:700;line-height:1.5;color:#1d293d;",
  h4: "margin:22px 0 10px;font-size:18px;font-weight:600;line-height:1.5;color:#1d293d;",
  h5: "margin:20px 0 10px;font-size:17px;font-weight:600;line-height:1.5;color:#1d293d;",
  h6: "margin:20px 0 10px;font-size:16px;font-weight:600;line-height:1.5;color:#1d293d;",
  strong: "font-weight:700;color:#1d293d;",
  blockquote:
    "margin:20px 0;padding:12px 16px;background-color:#f5f7fb;color:#52627a;line-height:1.8;text-align:left;",
  ul: "margin:0 0 20px;padding-left:1.5em;list-style-type:disc;",
  ol: "margin:0 0 20px;padding-left:1.5em;list-style-type:decimal;",
  li: "margin:0 0 8px;padding-left:2px;line-height:1.85;text-align:left;",
  a: "color:#2d5edb;text-decoration:underline;word-break:break-all;letter-spacing:0;",
  img: "display:block;max-width:100%;height:auto;margin:20px auto;",
  hr: "margin:28px 0;border:0;border-top:1px solid #e0e6ef;",
  pre: "margin:20px 0;padding:14px 16px;background-color:#f5f7fb;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.7;",
  code: "font-family:Menlo,Consolas,monospace;font-size:0.9em;",
};

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
  } = {},
) {
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
      return (
        `<section style="margin:22px 0;padding:16px 18px;border:1px solid #e0e6ef;border-radius:12px;background-color:#f7f9fc;text-align:left;text-align-last:left;letter-spacing:0;">` +
        `<p style="margin:0 0 10px;font-size:16px;font-weight:600;line-height:1.5;color:#1d293d;">${title}</p>` +
        `<p style="margin:0 0 10px;font-size:14px;line-height:1.7;text-align:left;text-align-last:left;letter-spacing:0;word-break:break-all;overflow-wrap:anywhere;"><a href="${href}" rel="noopener noreferrer">${href}</a></p>` +
        (code
          ? `<p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#52627a;">${code}</p>`
          : "") +
        `<p style="margin:0;font-size:13px;line-height:1.6;color:#52627a;">${help}</p></section>`
      );
    },
  );
  const styled = resources.replace(
    /<(h[2-6]|p|strong|blockquote|ul|ol|li|a|img|hr|pre|code)(?=[ >])([^>]*)>/g,
    (tag, name: string, attributes: string) =>
      /\bstyle=/.test(attributes)
        ? tag
        : `<${name}${attributes} style="${styles[name]}">`,
  );
  return `<section style="${bodyStyle}">${styled}</section>`;
}

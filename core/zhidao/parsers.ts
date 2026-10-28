import { AppError } from "../errors";
import { zhidaoQuestionTitleLimit } from "../../shared/zhidao-content";

export function decodeHtml(value: string): string {
  return value
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, n: string) => {
      const v =
        n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
      return v > 0 && v <= 0x10ffff ? String.fromCodePoint(v) : "";
    })
    .replace(
      /&(amp|lt|gt|quot|apos|nbsp);/g,
      (_, n: string) =>
        ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[n]!,
    );
}
export function plainHtml(value: string) {
  return decodeHtml(
    value
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/?(?:p|div|br|li|section|h[1-6])\b[^>]*>/gi, " ")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
}
export const normalizedName = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·、,，。:：;；!?！?\-—_/\\|（）()\[\]【】《》"'“”‘’]+/g, "");
export function resourceName(value: string) {
  const quoted = value.match(/《([^》]{2,80})》/);
  return plainHtml(quoted?.[1] ?? value)
    .replace(
      /(?:百度网盘|网盘资源|提取码|下载链接|链接分享|全集下载|求分享).*$/,
      " ",
    )
    .replace(/^\s*(?:求分享|哪里有|求|跪求|谁有)\s*/, "")
    .replace(/\.(?:zip|rar|7z|pdf|txt|epub|mp4|docx?|xlsx?)$/i, "")
    .trim()
    .slice(0, 100);
}
export function assertSourcePage(body: string) {
  if (
    body.length < 80000 &&
    /百度安全验证|请输入验证码|wappass|访问过于频繁|verify\.baidu/.test(body)
  )
    throw new AppError(
      "SOURCE_VERIFICATION",
      "来源要求安全验证，任务已暂停；请在账号窗口完成验证后继续。",
    );
}
export function extractBaiduShares(body: string) {
  const text = decodeHtml(body)
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&");
  const found: { name: string; link: string; code: string }[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(
    /(?:https?:\/\/)?pan\.baidu\.com\/s\/([\w-]{8,})(?:\?[^\s<>"'\\【】\u4e00-\u9fff]*)?/g,
  )) {
    const key = match[1];
    if (seen.has(key)) continue;
    seen.add(key);
    const raw = match[0].replace(/[.,，。;；、)）\]}]+$/g, "");
    const code =
      raw.match(/[?&]pwd=([\da-z]{4})(?:[^\da-z]|$)/i)?.[1] ??
      text
        .slice(
          match.index! + match[0].length,
          match.index! + match[0].length + 180,
        )
        .match(
          /(?:提取码|访问码|密码|pwd)\s*[:：=]?\s*(?:<[^>]*>\s*)*([\da-z]{4})(?:[^\da-z]|$)/i,
        )?.[1] ??
      "";
    found.push({
      name: "",
      link: `https://pan.baidu.com/s/${key}${code ? `?pwd=${code}` : ""}`,
      code,
    });
  }
  return found;
}
export function parseZhidaoSearch(body: string) {
  assertSourcePage(body);
  const results: { url: string; title: string }[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(
    /<a\b[^>]*href=["']((?:https?:\/\/zhidao\.baidu\.com)?\/question\/(?:hx\/)?[\w-]+(?:\.html)?(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const url = new URL(decodeHtml(m[1]), "https://zhidao.baidu.com").href;
    const title = plainHtml(m[2]);
    if (title && !seen.has(url)) {
      seen.add(url);
      results.push({ url, title });
    }
  }
  if (
    !results.length &&
    !/没有找到|未找到|暂无相关|没有相关|抱歉.*没有/.test(plainHtml(body))
  )
    throw new AppError(
      "SOURCE_CHANGED",
      "未识别到百度知道搜索结果，页面结构可能变化；已保留进度。",
    );
  return results;
}
export function safeHtmlAnswer(text: string, link = "", code = "") {
  const escape = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]!,
    );
  const body = text
    .split(/\n+/)
    .filter(Boolean)
    .map((p) => `<p>${escape(p)}</p>`)
    .join("");
  return (
    body +
    (link
      ? `<p>相关资料：${escape(link)}${code ? ` 提取码：${escape(code)}` : ""}</p>`
      : "")
  );
}
const titlePairs = [
  ["如何使用", "？"],
  ["怎么上手", "？"],
  ["使用", "前需要注意什么？"],
];
export function questionTitle(name: string, index: number) {
  const [prefix, suffix] = titlePairs[index % titlePairs.length];
  return (
    prefix +
    resourceName(name).slice(
      0,
      zhidaoQuestionTitleLimit - prefix.length - suffix.length,
    ) +
    suffix
  );
}

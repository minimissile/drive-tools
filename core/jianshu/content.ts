import type {
  JianshuDelivery,
  JianshuIssue,
  JianshuSource,
  JianshuArticle,
} from "../../shared/jianshu";
import {
  collectionLinkKey,
  collectionShare,
} from "../../shared/resource-collection";
import { parseShare } from "../links";

export const normalizeJianshuBody = (body: string) =>
  body
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const jianshuTextUrls = /https?:\/\/[^\s<>"'，。；）)\]]+/gi;

export function jianshuSourceWritingText(source: JianshuSource, text: string) {
  if (source.provider !== "tieba") return text;
  return normalizeJianshuBody(
    text
      .replace(jianshuTextUrls, "")
      .replace(
        /(?:提取码|访问码|分享密码|密码)(?:[ \t]*[:：][ \t]*|[ \t]+)[a-z0-9]{4,8}(?![a-z0-9])/gi,
        "",
      ),
  );
}

function shareKey(url: string) {
  try {
    return collectionLinkKey(parseShare(url).url);
  } catch {
    const share = collectionShare(url);
    return share ? collectionLinkKey(share.link) : null;
  }
}

/** Markdown is never evaluated as HTML or script when copied or prepared for an editor. */
export function jianshuHtml(title: string, text: string) {
  return (
    `<h1>${escape(title)}</h1>` +
    text
      .split(/\n\n+/)
      .map((block) => {
        const heading = block.match(/^(#{1,4})\s+([^\n]+)$/);
        if (heading)
          return `<h${heading[1].length + 1}>${escape(heading[2])}</h${heading[1].length + 1}>`;
        return `<p>${escape(block).replace(/\n/g, "<br>")}</p>`;
      })
      .join("\n")
  );
}

export function jianshuDelivery(
  article: JianshuArticle,
  sources: JianshuSource[],
  resource?: { title: string; url: string } | null,
): JianshuDelivery {
  const parts = [normalizeJianshuBody(article.body)];
  if (resource && !article.body.includes(resource.url))
    parts.push(`## 资料获取\n${resource.title}\n${resource.url}`);
  const sourceByUrl = new Map<string, JianshuSource>();
  for (const source of sources)
    if (!sourceByUrl.has(source.url)) sourceByUrl.set(source.url, source);
  const sourceUrls = [...sourceByUrl.keys()];
  const bodyUrls = new Set(article.body.match(jianshuTextUrls));
  const missingSources = [...sourceByUrl.values()].filter((source) =>
    source.provider === "tieba"
      ? !bodyUrls.has(source.url)
      : !article.body.includes(source.url),
  );
  if (missingSources.length)
    parts.push(
      "## 参考来源\n" +
        missingSources
          .map((s) => {
            const title = jianshuSourceWritingText(s, s.title) || s.sourceName;
            const author = jianshuSourceWritingText(s, s.author);
            return `${title}${author ? `（${author}）` : ""}\n${s.url}`;
          })
          .join("\n\n"),
    );
  const text = parts.filter(Boolean).join("\n\n");
  return {
    text,
    html: jianshuHtml(article.title, text),
    resourceUrl: resource?.url ?? null,
    sourceUrls,
  };
}

export function jianshuDeliveryWithCode(
  delivery: JianshuDelivery,
  title: string,
  value: string | null,
): JianshuDelivery {
  const code = value?.trim() ?? "";
  if (!delivery.resourceUrl || !code) return delivery;
  if (code.length > 100 || /[\r\n\x00-\x1f]/.test(code))
    throw new Error("资料提取码格式异常，请重新核对本人分享。");
  const text = delivery.text.replace(
    delivery.resourceUrl,
    `${delivery.resourceUrl}\n提取码：${code}`,
  );
  return {
    ...delivery,
    text,
    html: jianshuHtml(title, text),
    resourceCode: code,
  };
}

export function jianshuIssues(
  article: JianshuArticle,
  resourceUrl: string | null,
  extra: JianshuIssue[] = [],
): JianshuIssue[] {
  const issues = [...extra];
  if (!article.title.trim())
    issues.push({ severity: "error", text: "请填写文章标题。" });
  if (article.body.trim().length < 30)
    issues.push({
      severity: "error",
      text: "正文至少需要30字，请补充实际资料介绍或使用说明。",
    });
  if (
    /作为(?:一个)?(?:AI|人工智能)|我无法(?:为你|为您|提供|完成)|无法为您提供|抱歉[，,]?我|\[(?:待补充|占位|标题|正文)\]|TODO|PLACEHOLDER/i.test(
      article.body,
    )
  )
    issues.push({
      severity: "error",
      text: "正文包含模型异常回复或未替换的占位内容，请修改后继续。",
    });
  const ownShare = resourceUrl ? shareKey(resourceUrl) : null;
  const containsExternalShare = [article.title, article.body].some((text) =>
    [...text.matchAll(jianshuTextUrls)].some(([url]) => {
      const key = shareKey(url);
      return key !== null && key !== ownShare;
    }),
  );
  if (containsExternalShare)
    issues.push({
      severity: "error",
      text: "文章含未关联的网盘分享，请移除外部链接，或关联本人资料后使用对应入口。",
    });
  if (article.copyId && !resourceUrl)
    issues.push({
      severity: "error",
      text: "关联资料的本人分享当前不可用，请重新选择资料或完成核验。",
    });
  return issues;
}

/** Image reuse is selected explicitly; source image URLs are never downloaded here. */
export function jianshuInitialBody(
  _title: string,
  summary: string,
  template: JianshuArticle["template"],
) {
  if (!summary.trim()) return "";
  return template === "guide"
    ? `## 资料说明\n${summary}\n\n## 使用建议\n先阅读资料目录，再根据自己的学习目标选择相关部分；具体内容以实际文件为准。`
    : `## 资料介绍\n${summary}`;
}

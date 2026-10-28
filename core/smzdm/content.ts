import type {
  SmzdmArticle,
  SmzdmIssue,
  SmzdmResourceLink,
} from "../../shared/smzdm";
import { parseShare } from "../links";
import { id } from "../database";

const urls = /https?:\/\/[^\s<>"'，。；）)\]]+/gi;
const codePattern =
  /((?:提取码|访问码|密码)\s*[:：]?\s*(?:\*\*|`)?)\s*([a-zA-Z0-9]{4,8})/;
export function articleLinkOccurrences(body: string) {
  return [...body.matchAll(urls)].flatMap((match) => {
    try {
      const end = match.index + match[0].length;
      const nearby = body.slice(end, end + 120).split(/https?:\/\//)[0];
      const codeMatch = nearby.match(codePattern);
      const query = parseShare(match[0]);
      const share = parseShare(match[0], codeMatch?.[2]);
      return [
        {
          start: match.index,
          end,
          share,
          queryCode: query.code,
          codeStart: codeMatch ? end + codeMatch.index! : null,
          codeText: codeMatch?.[0] ?? "",
          codeLabel: codeMatch?.[1] ?? "",
        },
      ];
    } catch {
      return [];
    }
  });
}
export function articleLinks(body: string): SmzdmResourceLink[] {
  const result: SmzdmResourceLink[] = [];
  for (const { share } of articleLinkOccurrences(body)) {
    if (!result.some((v) => v.url === share.url))
      result.push({
        id: id("smzlink"),
        url: share.url,
        sourceText: `${share.url}${share.code ? ` 提取码：${share.code}` : ""}`,
        code: share.code,
        provider: share.provider,
        copyId: null,
        resourceId: null,
        ownUrl: null,
      });
  }
  return result;
}
export function replaceArticleLinks(
  body: string,
  links: SmzdmResourceLink[],
  replacements: Map<string, { url: string; code: string }>,
) {
  const edits: { start: number; end: number; text: string }[] = [];
  for (const occurrence of articleLinkOccurrences(body)) {
    const link = links.find(
      (v) =>
        v.url === occurrence.share.url || v.ownUrl === occurrence.share.url,
    );
    const own = link && replacements.get(link.id);
    if (!link || !own) continue;
    edits.push({
      start: occurrence.start,
      end: occurrence.end,
      text: own.url + (own.code ? `?pwd=${encodeURIComponent(own.code)}` : ""),
    });
    if (occurrence.codeStart !== null)
      edits.push({
        start: occurrence.codeStart,
        end: occurrence.codeStart + occurrence.codeText.length,
        text: own.code ? occurrence.codeLabel + own.code : "",
      });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start))
    body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  return body;
}
export function formatArticle(body: string) {
  return body
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^(#{1,6})([^#\s])/gm, "$1 $2")
    .trim();
}
export function articleIssues(article: SmzdmArticle): SmzdmIssue[] {
  const issues: SmzdmIssue[] = [];
  if (
    [...article.body.matchAll(urls)].some(([url]) => {
      try {
        return /(?:^|\.)(?:aliyundrive\.com|alipan\.com|115\.com|115cdn\.com|123pan\.com|123684\.com|123865\.com|cloud\.189\.cn|caiyun\.139\.com|lanzou[a-z]?\.com)$/.test(
          new URL(url).hostname,
        );
      } catch {
        return false;
      }
    })
  )
    issues.push({
      severity: "error",
      text: "正文含暂未接入入库流程的网盘链接，请移除或改用已归档、可核验的本人资源。",
    });
  if (!article.title.trim() || article.title.length > 30)
    issues.push({
      severity: "error",
      text: "什么值得买文章标题需为 1–30 字。",
    });
  if (article.body.replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim().length < 80)
    issues.push({
      severity: "error",
      text: "正文不足 80 字，请补全文章内容。",
    });
  const allowed = new Set(article.links.map((v) => v.ownUrl).filter(Boolean));
  if (articleLinks(article.body).some((v) => !allowed.has(v.url)))
    issues.push({
      severity: "error",
      text: "正文仍含未替换或未核验的网盘链接，请完成入库并同步本人链接。",
    });
  if (article.links.some((v) => !v.copyId || !v.ownUrl))
    issues.push({ severity: "error", text: "文章资源尚未全部关联本人副本。" });
  if (/关注\s*[「『“【]\s*[」』”】]/.test(article.body))
    issues.push({
      severity: "error",
      text: "正文中的关注对象为空，请删除残留引导或补全内容。",
    });
  if (!article.body.includes(article.source.url))
    issues.push({
      severity: "warning",
      text: "稿件未注明原文地址，请补充来源和作者，核对转载及配图授权。",
    });
  if (
    /(?:TODO|待补充|作为一个(?:AI|人工智能)|由AI生成的占位|\[在此填写)/i.test(
      article.body,
    )
  )
    issues.push({
      severity: "error",
      text: "正文包含占位内容或模型自述，请编辑后再发布。",
    });
  if (
    /(?:在当今|在这个快节奏|综上所述|总而言之|让我们一起来|不容错过|赋能|颠覆性)/.test(
      article.body,
    )
  )
    issues.push({
      severity: "warning",
      text: "部分表达较模板化，建议换成具体事实、使用场景与自然叙述。",
    });
  if (/(?:亲测|实测|百分之百|100%|绝对有效)/.test(article.body))
    issues.push({
      severity: "warning",
      text: "请核对实测与效果表述，避免把原作者经历改成自己的经历。",
    });
  return [
    ...issues,
    ...article.source.warnings.map((text): SmzdmIssue => ({
      severity: "warning",
      text,
    })),
  ];
}
export { articleHtml } from "../../shared/article-markup";

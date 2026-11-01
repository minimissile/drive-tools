import { AppError } from "../../errors";
import {
  collectionShare,
  collectionLinkKey,
} from "../../../shared/resource-collection";
import {
  zhidaoAnswerPageUrl,
  type DiscoveredAnswer,
} from "../../../shared/zhidao-page-discovery";
import { decodeHtml, plainHtml } from "../parsers";

export function assertDiscoveryPage(body: string) {
  const title = plainHtml(
    body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "",
  );
  if (
    /安全验证|访问验证|验证码|访问过于频繁/.test(title) ||
    /id=["'](?:vcode-spin|verify-bar)["']/.test(body)
  )
    throw new AppError(
      "DISCOVERY_VERIFICATION",
      "来源要求安全验证，请查看异常页；已保留进度，验证后手动继续。",
    );
  if (body.trim().length < 100)
    throw new AppError(
      "DISCOVERY_EMPTY_RESPONSE",
      "来源返回空白或不完整页面，不能按没有结果处理。",
    );
}

/** Only answer content roots qualify. Metadata, scripts, related questions and comments are excluded. */
function answerBlocks(html: string) {
  const clean = html.replace(
    /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,
    "",
  );
  const stack: { tag: string; start: number; aid: string; content: boolean }[] =
    [];
  const blocks: { aid: string; html: string }[] = [];
  for (const m of clean.matchAll(/<(\/?)([a-z][\w:-]*)\b([^>]*)>/gi)) {
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const index = stack.findLastIndex((v) => v.tag === tag);
      if (index < 0) continue;
      const [node] = stack.splice(index);
      if (node.content)
        blocks.push({ aid: node.aid, html: clean.slice(node.start, m.index) });
      continue;
    }
    if (
      /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(
        tag,
      ) ||
      /\/\s*$/.test(m[3])
    )
      continue;
    const id = m[3].match(/\bid\s*=\s*["']([^"']*)["']/i)?.[1] || "";
    const classes = m[3].match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1] || "";
    const aid =
      id.match(
        /^(?:(?:best|recommend|answer|target)-content-|answer-)(\d+)$/,
      )?.[1] ||
      stack.at(-1)?.aid ||
      "";
    const isRoot =
      /^(?:best|recommend|answer|target)-content-\d+$/.test(id) ||
      /(?:^|\s)(?:best-text|recommend-text|answer-text|target-text)(?:\s|$)/.test(
        classes,
      );
    stack.push({
      tag,
      start: m.index! + m[0].length,
      aid,
      content: !!aid && isRoot && !stack.some((v) => v.content),
    });
  }
  return blocks;
}

function cloudLinks(html: string) {
  const clean = decodeHtml(html).replace(/\\\//g, "/");
  const entries = [
    ...clean.matchAll(
      /(?:https?:\/\/|(?=(?:pan\.baidu\.com|yun\.baidu\.com|pan\.quark\.cn)\/))[^\s<>"'\\，。；）)【】《》「」『』\u4e00-\u9fff]+/gi,
    ),
  ];
  const links: DiscoveredAnswer["links"] = [];
  for (const [i, m] of entries.entries()) {
    try {
      const raw = m[0].replace(/[.,;:!\]\}]+$/, "");
      const u = new URL(/^https?:/.test(raw) ? raw : `https://${raw}`);
      const share = collectionShare(u.href);
      if (!share) continue;
      const key = collectionLinkKey(share.link);
      // href and visible anchor text often repeat a link. Stop at the next distinct URL
      // so one share cannot accidentally inherit another share's extraction code.
      const next =
        entries.slice(i + 1).find((entry) => {
          try {
            return (
              collectionLinkKey(
                /^https?:/.test(entry[0]) ? entry[0] : `https://${entry[0]}`,
              ) !== key
            );
          } catch {
            return true;
          }
        })?.index ?? clean.length;
      const nearby = plainHtml(
        clean.slice(
          m.index! + m[0].length,
          Math.min(next, m.index! + m[0].length + 300),
        ),
      );
      const code =
        share.code ||
        nearby.match(
          /(?:提取码|访问码|密码)\s*[:：=]?\s*([a-z\d]{4,8})\b/i,
        )?.[1] ||
        "";
      const old = links.find((v) => collectionLinkKey(v.url) === key);
      if (old) {
        if (!old.code) old.code = code;
        continue;
      }
      links.push({ url: share.link, code, provider: share.driveType });
    } catch {
      /* Non-URL text cannot qualify as a share link. */
    }
  }
  return links.slice(0, 50);
}

export function inspectZhidaoAnswers(body: string, pageUrl: string) {
  assertDiscoveryPage(body);
  const page = zhidaoAnswerPageUrl(pageUrl);
  if (!page)
    throw new AppError("DISCOVERY_URL", "仅检查百度知道问题页和回答页。");
  if (/问题不存在|问题已删除|该问题已失效/.test(plainHtml(body).slice(0, 5000)))
    return [];
  const title = plainHtml(
    body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
      body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
      "",
  )
    .replace(/[_-]百度知道.*$/, "")
    .trim();
  const blocks = answerBlocks(body);
  if (!blocks.length)
    throw new AppError(
      "DISCOVERY_ANSWER_STRUCTURE",
      "没有识别到回答正文，页面可能尚未加载、没有公开回答或结构已变化。",
    );
  if (page.aid && !blocks.some((block) => block.aid === page.aid))
    throw new AppError(
      "DISCOVERY_TARGET_MISSING",
      "页面未返回指定回答的正文，已记录为异常页。",
    );
  const answers: Omit<DiscoveredAnswer, "keyword" | "origin" | "foundAt">[] =
    [];
  for (const block of blocks) {
    if (page.aid && page.aid !== block.aid) continue;
    const links = cloudLinks(block.html);
    if (!links.length || answers.some((v) => v.aid === block.aid)) continue;
    answers.push({
      id: `${page.qid}:${block.aid}`,
      qid: page.qid,
      aid: block.aid,
      title,
      questionUrl: `https://zhidao.baidu.com/question/${page.qid}.html`,
      answerUrl: `https://zhidao.baidu.com/question/${page.qid}/answer/${block.aid}.html`,
      answer: plainHtml(block.html)
        .replace(/^展开全部\s*/, "")
        .slice(0, 12000),
      links,
    });
  }
  return answers;
}

export function discoverZhidaoCandidates(body: string) {
  assertDiscoveryPage(body);
  const decoded = decodeHtml(body)
    .replace(/\\\//g, "/")
    .replace(/\\u002[fF]/g, "/");
  const urls = new Set<string>();
  for (const m of decoded.matchAll(
    /(?:https?:)?\/\/zhidao\.baidu\.com\/question\/\d+(?:\/answer\/\d+)?\.html/g,
  )) {
    const page = zhidaoAnswerPageUrl(
      m[0].startsWith("//") ? `https:${m[0]}` : m[0],
    );
    if (page) urls.add(page.url);
  }
  // Search results may expose only Baidu redirect links; the runner resolves them before checking the answer.
  for (const card of decoded.matchAll(/<h3\b[^>]*>[\s\S]*?(?=<h3\b|$)/gi)) {
    if (!card[0].includes("zhidao.baidu.com")) continue;
    const redirect = card[0].match(
      /href=["'](https?:\/\/www\.baidu\.com\/link\?[^"']+)["']/i,
    )?.[1];
    if (redirect) {
      const target = new URL(redirect);
      target.protocol = "https:";
      urls.add(target.href);
    }
  }
  const noResults =
    /抱歉.{0,80}(?:没有找到|未找到)|(?:没有找到|未找到).{0,50}(?:结果|网页)/.test(
      plainHtml(decoded),
    );
  const hasResults =
    /<h3\b[^>]*>\s*<a\b/i.test(decoded) &&
    /content_left|c-container|result-op/.test(decoded);
  if (!urls.size && !noResults && !hasResults)
    throw new AppError(
      "DISCOVERY_SEARCH_STRUCTURE",
      "未识别到搜索结果区域，请查看异常页后继续。",
    );
  return [...urls].slice(0, 25);
}

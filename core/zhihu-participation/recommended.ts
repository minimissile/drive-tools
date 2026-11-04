import type { Page } from "playwright-core";
import { AppError } from "../errors";
import {
  zhihuRecommendedMinimumViews,
  zhihuRecommendedQuestionsUrl,
  zhihuResearchHitSchema,
  type ZhihuResearchHit,
} from "../../shared/zhihu-participation";

/** Parse only the metric explicitly labelled 浏览. Answer/follower counts never qualify. */
export function zhihuQuestionViewCount(text: string): number | null {
  const match = text
    .replace(/[\u00a0\u200b-\u200d\ufeff]/g, " ")
    .match(
      /(?:^|[^\d.,+-])((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(亿|万)?\s*(?:次)?\s*浏览(?:量)?/,
    );
  if (!match) return null;
  const [whole, fraction = ""] = match[1].replaceAll(",", "").split(".");
  if (whole.length + fraction.length > 24) return null;
  const denominator = 10n ** BigInt(fraction.length);
  const numerator =
    BigInt(whole + fraction) *
    (match[2] === "亿" ? 100000000n : match[2] === "万" ? 10000n : 1n);
  if (numerator % denominator) return null;
  const value = numerator / denominator;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}
interface FeaturedSnapshot {
  url: string;
  shell: boolean;
  empty: boolean;
  rows: { url: string; title: string; text: string }[];
}
/** Visible DOM only. A row must contain one unique canonical question and its own metric. */
function featuredDom(): FeaturedSnapshot {
  const visible = (e: Element) =>
    e instanceof HTMLElement &&
    e.getClientRects().length > 0 &&
    getComputedStyle(e).visibility !== "hidden";
  const question = (anchor: Element): string | null => {
    if (!(anchor instanceof HTMLAnchorElement)) return null;
    try {
      const url = new URL(anchor.href);
      return url.origin === "https://www.zhihu.com" &&
        /^\/question\/[1-9]\d{0,29}\/?$/.test(url.pathname)
        ? `${url.origin}${url.pathname.replace(/\/$/, "")}`
        : null;
    } catch {
      return null;
    }
  };
  const roots = [...document.querySelectorAll("a[href*='/question/']")].filter(
    visible,
  );
  const rows: FeaturedSnapshot["rows"] = [];
  for (const anchor of roots) {
    const url = question(anchor),
      title = (anchor as HTMLElement).innerText.trim();
    if (
      !url ||
      !title ||
      title === "写回答" ||
      rows.some((row) => row.url === url)
    )
      continue;
    let parent = anchor.parentElement;
    for (
      let depth = 0;
      parent && depth < 8;
      depth++, parent = parent.parentElement
    ) {
      const urls = new Set(
        [...parent.querySelectorAll("a[href*='/question/']")]
          .filter(visible)
          .map(question)
          .filter(Boolean),
      );
      if (urls.size !== 1) break;
      const text = parent.innerText.trim();
      if (
        /[\d,.]+\s*[万亿]?\s*(?:次)?\s*浏览/.test(text) &&
        text.length <= 5000
      ) {
        rows.push({
          url,
          title: title.slice(0, 300),
          text: text.slice(0, 5000),
        });
        break;
      }
    }
    if (rows.length >= 50) break;
  }
  const body = document.body.innerText;
  return {
    url: location.href,
    shell: body.includes("推荐问题") && body.includes("问题搜索"),
    empty: /暂无推荐问题|暂时没有推荐问题/.test(body),
    rows,
  };
}
export async function readFeaturedQuestions(
  page: Page,
  limit: number,
  guard: () => Promise<void>,
) {
  const response = await page.goto(zhihuRecommendedQuestionsUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await guard();
  if (!response?.ok())
    throw new AppError(
      "ZHIHU_RECOMMEND_LOAD",
      `推荐问题页加载失败${response ? `（HTTP ${response.status()}）` : ""}，未记作空结果。`,
    );
  const script = `(() => { const __name = (fn) => fn; return (${featuredDom.toString()})(); })()`;
  const deadline = Date.now() + 10000;
  let previous = "",
    stableSince = 0;
  for (;;) {
    await guard();
    const snapshot = await page.evaluate<FeaturedSnapshot>(script);
    if (snapshot.url.replace(/\/$/, "") !== zhihuRecommendedQuestionsUrl)
      throw new AppError(
        "ZHIHU_RECOMMEND_REDIRECT",
        "推荐问题页地址变化，读取已停止。",
      );
    if (snapshot.shell && snapshot.rows.length) {
      const signature = JSON.stringify(snapshot.rows);
      if (signature !== previous) {
        previous = signature;
        stableSince = Date.now();
      }
      // Cards hydrate separately. Wait for the current visible list to settle,
      // rather than treating the first hydrated row as the whole loaded list.
      if (Date.now() - stableSince < 750) {
        if (Date.now() >= deadline)
          throw new AppError(
            "ZHIHU_RECOMMEND_LOADING",
            "推荐列表仍在加载变化，未将不完整卡片当作完整结果保存。",
          );
        await page.waitForTimeout(250);
        continue;
      }
      const observedAt = new Date().toISOString();
      let known = 0;
      const hits: ZhihuResearchHit[] = [];
      for (const row of snapshot.rows) {
        const views = zhihuQuestionViewCount(row.text);
        if (views === null) continue;
        known++;
        if (views <= zhihuRecommendedMinimumViews) continue;
        const viewText =
          row.text.match(/[\d,.]+\s*[万亿]?\s*(?:次)?\s*浏览(?:量)?/)?.[0] ??
          "";
        hits.push(
          zhihuResearchHitSchema.parse({
            kind: "question",
            url: row.url,
            title: row.title,
            excerpt: row.text.slice(0, 2000),
            recommendation: {
              sourceUrl: zhihuRecommendedQuestionsUrl,
              views,
              viewText,
              observedAt,
            },
          }),
        );
      }
      if (!known)
        throw new AppError(
          "ZHIHU_RECOMMEND_METRICS",
          "推荐问题已加载，但浏览量结构无法识别；未当作没有合格问题。",
        );
      return hits
        .sort((a, b) => b.recommendation!.views - a.recommendation!.views)
        .slice(0, limit);
    }
    if (snapshot.shell && snapshot.empty && !snapshot.rows.length) return [];
    if (Date.now() >= deadline)
      throw new AppError(
        "ZHIHU_RECOMMEND_SHAPE",
        "未识别到推荐问题及其浏览量，请核对页面结构；原候选保留。",
      );
    await page.waitForTimeout(250);
  }
}

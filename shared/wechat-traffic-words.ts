import { z } from "zod";

export function normalizeWechatTrafficWords(value: string | readonly string[]) {
  const seen = new Set<string>();
  return (typeof value === "string" ? [value] : value)
    .flatMap((line) => line.split(/\r\n?|\n/))
    .map((word) => word.trim().replace(/[\t ]+/g, " "))
    .filter((word) => {
      const key = word.toLocaleLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export const wechatTrafficWordsInput = z
  .array(z.string().max(12000, "流量词内容过长，请精简后保存。"))
  .max(12001, "输入行数过多，请精简后保存。")
  .transform(normalizeWechatTrafficWords)
  .pipe(
    z
      .array(z.string().max(80, "单个流量词最多 80 个字，请精简后保存。"))
      .max(100, "每篇最多保存 100 个流量词，请精简后保存。"),
  );

export interface WechatTrafficWords {
  words: string[];
  revision: number;
}

export interface WechatTrafficWordCount {
  word: string;
  uses: number;
}

export interface WechatTrafficWordPlan {
  priorityWords: string[];
  coveredWords: string[];
  mode: "uncovered" | "least-used";
  usage: WechatTrafficWordCount[];
}

/** All words remain available. Priority is advisory and never consumes the pool. */
export function planWechatTrafficWords(
  words: readonly string[],
  history: readonly WechatTrafficWordCount[] = [],
): WechatTrafficWordPlan {
  const counts = new Map(
    history.map(({ word, uses }) => [word.toLocaleLowerCase(), uses]),
  );
  const usage = normalizeWechatTrafficWords(words).map((word) => ({
    word,
    uses: counts.get(word.toLocaleLowerCase()) ?? 0,
  }));
  const uncovered = usage
    .filter(({ uses }) => uses === 0)
    .map(({ word }) => word);
  const lowest = usage.length ? Math.min(...usage.map(({ uses }) => uses)) : 0;
  return {
    priorityWords: uncovered.length
      ? uncovered
      : usage.filter(({ uses }) => uses === lowest).map(({ word }) => word),
    coveredWords: usage.filter(({ uses }) => uses > 0).map(({ word }) => word),
    mode: uncovered.length || !usage.length ? "uncovered" : "least-used",
    usage,
  };
}

/** Counts visible title/body text, excluding image descriptions and URL addresses. */
export function wechatTrafficWordUsage(
  words: readonly string[],
  title: string,
  body: string,
) {
  const visible = `${title}\n${body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(?:https?:|panxu-media:)\/\/[^\s)]+/g, "")}`
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .toLocaleLowerCase();
  const used: string[] = [],
    unused: string[] = [];
  for (const word of normalizeWechatTrafficWords(words))
    (visible.includes(word.toLocaleLowerCase()) ? used : unused).push(word);
  return { used, unused };
}

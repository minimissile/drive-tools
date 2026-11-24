import { z } from "zod";
import {
  discoverySeeds,
  discoveryWordKey,
  normalizeDiscoveryWord,
} from "./baidu-discovery";
import { websiteAccountIdSchema } from "./website-accounts";

export const resourceSeedLimit = 5;
export const resourceKeywordLimit = 100;
export const resourceCandidateLimit = 750;
export const resourceKeywordSources = [
  "suggest",
  "people",
  "related",
  "5118",
  "baidu-marketing",
  "manual",
] as const;
export type ResourceKeywordSource = (typeof resourceKeywordSources)[number];
export const keywordWordSchema = z.string().trim().min(1).max(100);
export const resourceKeywordsSchema = z
  .array(keywordWordSchema)
  .max(resourceKeywordLimit);
export const keywordCandidateSchema = z.object({
  word: keywordWordSchema,
  sources: z
    .array(z.enum(resourceKeywordSources))
    .min(1)
    .max(resourceKeywordSources.length),
  seeds: z.array(keywordWordSchema).max(resourceSeedLimit),
});
export type KeywordCandidate = z.infer<typeof keywordCandidateSchema>;
export const keywordLookupSchema = z.object({
  seeds: z.array(keywordWordSchema).min(1).max(resourceSeedLimit),
  baiduAccountId: websiteAccountIdSchema.optional(),
});
export const keywordBatchSchema = z.object({
  id: z.string().uuid(),
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        title: z.string().trim().min(1).max(200),
        seeds: keywordLookupSchema.shape.seeds,
      }),
    )
    .min(1)
    .max(50)
    .refine(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
      "资源不能重复",
    ),
  baiduAccountId: websiteAccountIdSchema.optional(),
});
export interface KeywordBatch {
  id: string;
  status: "running" | "completed" | "interrupted";
  items: {
    id: string;
    title: string;
    seeds: string[];
    status: "pending" | "running" | "completed" | "failed";
    result?: KeywordLookup;
    message?: string;
  }[];
}
export interface KeywordLookup {
  candidates: KeywordCandidate[];
  issues: {
    channel: "baidu" | "5118" | "baidu-marketing";
    seed?: string;
    message: string;
    code?: "login_required";
  }[];
}
export type KeywordSourceChannel = KeywordLookup["issues"][number]["channel"];
export interface KeywordSourcesCheck {
  checkedAt: string;
  sources: Record<
    KeywordSourceChannel,
    {
      status: "ready" | "login_required" | "unavailable" | "unconfigured";
      message: string;
    }
  >;
}
export function normalizeResourceKeywords(
  words: readonly string[],
  limit = resourceKeywordLimit,
) {
  const unique = new Map<string, string>();
  for (const raw of words) {
    const word = normalizeDiscoveryWord(raw);
    if (
      !word ||
      word.length > 100 ||
      !/[\p{L}\p{N}]/u.test(word) ||
      /https?:\/\/|www\.|[\p{Cc}<>]/iu.test(word)
    )
      continue;
    const key = discoveryWordKey(word);
    if (!unique.has(key)) unique.set(key, word);
    if (unique.size >= limit) break;
  }
  return [...unique.values()];
}
export function parseResourceKeywordSeeds(text: string) {
  return discoverySeeds(text).map((word) => normalizeDiscoveryWord(word));
}
export function parseResourceKeywordText(text: string) {
  return normalizeResourceKeywords(text.split(/\r?\n/), Infinity);
}
export function parseImportedResourceKeywords(text: string) {
  // A copied TSV table has keyword in the first column. A plain list may use commas or newlines.
  return normalizeResourceKeywords(
    text
      .split(/\r?\n/)
      .flatMap((line) =>
        line.includes("\t") ? [line.split("\t")[0]] : line.split(/[,，;；]+/),
      )
      .map((word) => word.trim().replace(/^"(.+)"$/, "$1"))
      .filter(
        (word) =>
          !/^(?:关键词|搜索词|相关词|keyword|keywords)$/iu.test(word.trim()),
      ),
    resourceCandidateLimit,
  );
}
export function mergeKeywordCandidates(
  ...groups: readonly KeywordCandidate[][]
) {
  const merged = new Map<string, KeywordCandidate>();
  for (const candidate of groups.flat()) {
    const key = discoveryWordKey(candidate.word);
    const previous = merged.get(key);
    if (!previous) {
      if (merged.size < resourceCandidateLimit) merged.set(key, candidate);
      continue;
    }
    merged.set(key, {
      word: previous.word,
      sources: [...new Set([...previous.sources, ...candidate.sources])],
      seeds: normalizeResourceKeywords(
        [...previous.seeds, ...candidate.seeds],
        resourceSeedLimit,
      ),
    });
  }
  return [...merged.values()];
}

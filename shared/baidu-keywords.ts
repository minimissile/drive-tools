import { z } from "zod";
import type { Keyword } from "./types";
import { websiteAccountIdSchema } from "./website-accounts";
import { keywordSchema } from "./schemas";

export const baiduKeywordSource = "百度营销 · 关键词规划师";

export const baiduKeywordInputSchema = z
  .object({
    accountId: websiteAccountIdSchema,
    seeds: z.array(z.string().trim().min(1).max(100)).max(10),
    mode: z.enum(["seed", "prompt", "url", "business"]).default("seed"),
    prompt: z.string().trim().max(2000).default(""),
    url: z
      .union([
        z.literal(""),
        z
          .url()
          .max(1024)
          .refine((s) => /^https?:\/\//i.test(s)),
      ])
      .default(""),
    business: z
      .object({
        businessPointId: z.number().int().positive(),
        businessPointName: z.string().trim().min(1).max(200),
      })
      .optional(),
    combinations: z.boolean().default(false),
    positiveWords: z
      .array(z.string().trim().min(1).max(100))
      .max(100)
      .default([]),
    negativeWords: z
      .array(z.string().trim().min(1).max(100))
      .max(100)
      .default([]),
    reasons: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
    competitions: z
      .array(z.union([z.literal(1), z.literal(2), z.literal(3)]))
      .max(3)
      .default([]),
    minimumMonthly: z.number().finite().nonnegative().optional(),
    regionExtend: z.boolean().default(false),
    removeDuplicate: z.boolean().default(false),
    regions: z
      .array(z.number().int().positive().max(1_000_000))
      .max(40)
      .default([]),
    device: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
    sort: z
      .enum(["averageMonthPv", "recommendPrice"])
      .default("averageMonthPv"),
    descending: z.boolean().default(true),
  })
  .refine(
    (v) =>
      v.mode === "seed"
        ? v.seeds.length > 0
        : v.mode === "prompt"
          ? !!v.prompt
          : v.mode === "url"
            ? !!v.url
            : !!v.business,
    { message: "请填写所选拓词方式的内容。" },
  );
export type BaiduKeywordInput = z.infer<typeof baiduKeywordInputSchema>;
export interface BaiduKeywordResult {
  id: string;
  accountUid: string;
  input: BaiduKeywordInput;
  keywords: Keyword[];
  total: number;
  fetchedAt: string;
  warning?: string;
  knowledge?: {
    indexed: number;
    refreshedBelowThreshold: number;
    minimumMonthlySearches: number;
  };
  knowledgeWarning?: string;
}
export const baiduKeywordResultSchema = z.object({
  id: z.string(),
  accountUid: z.string(),
  input: baiduKeywordInputSchema,
  keywords: z.array(keywordSchema).max(3000),
  total: z.number().int().nonnegative(),
  fetchedAt: z.string().datetime(),
  warning: z.string().optional(),
  knowledgeWarning: z.string().optional(),
  knowledge: z
    .object({
      indexed: z.number().int().nonnegative(),
      refreshedBelowThreshold: z.number().int().nonnegative().default(0),
      minimumMonthlySearches: z.number(),
    })
    .optional(),
});
export const baiduKeywordColumns = [
  ["averageMonthPv", "月均搜索量"],
  ["averageMonthPvMobile", "月均移动搜索量"],
  ["averageMonthPvPc", "月均计算机搜索量"],
  ["competition", "竞争激烈程度"],
  ["recommendPrice", "点击指导价"],
  ["recommendPriceMobile", "移动点击指导价"],
  ["recommendPricePc", "计算机点击指导价"],
  ["show", "预估月均展现"],
  ["click", "预估月均点击"],
  ["intention", "意图"],
  ["intentionLevel", "意图价值"],
  ["showReasons", "特色"],
  ["groupName", "关键词组合"],
  ["competitionPc", "计算机竞争程度"],
  ["competitionWise", "移动竞争程度"],
] as const;

type Contract<Args, Value> = { args: Args; value: Value };
export interface BaiduKeywordContract {
  "baiduKeywords.export": Contract<{accountId:string;resultId:string},string|null>;
  "baiduKeywords.query": Contract<BaiduKeywordInput, BaiduKeywordResult>;
  "baiduKeywords.latest": Contract<
    { accountId: string },
    BaiduKeywordResult | null
  >;
}

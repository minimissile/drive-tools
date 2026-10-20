import { z } from "zod";
import type { Keyword } from "./types";
import { websiteAccountIdSchema } from "./website-accounts";
import { keywordSchema } from "./schemas";

export const baiduTools = [
  ["keyword", "关键词拓词"],
  ["ranking", "关键词榜单"],
  ["grouping", "关键词分组"],
  ["flow", "流量查询"],
  ["mass", "海量拓词"],
  ["industry", "行业流量洞察"],
] as const;
export type BaiduTool = (typeof baiduTools)[number][0];
export const baiduToolSchema = z.enum([
  "keyword",
  "ranking",
  "grouping",
  "flow",
  "mass",
  "industry",
]);
const word = z.string().trim().min(1).max(100);
export const baiduDimensionSchema = z.object({
  type: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  dimensionName: z.string().trim().min(1).max(100),
  keywordRootList: z.array(word).min(1).max(20),
});
export const baiduResearchInputSchema = z
  .object({
    accountId: websiteAccountIdSchema,
    operation: z.enum([
      "businesses",
      "keywordBusinesses",
      "rankDate",
      "rank",
      "flow",
      "massList",
      "massCreate",
      "groupList",
      "groupCreate",
      "templates",
      "templateDetail",
      "templateCreate",
      "industryTree",
      "industryChildren",
      "industryTrend",
      "industryWords",
    ]),
    page: z.number().int().positive().max(100000).default(1),
    pageSize: z.number().int().min(1).max(1000).default(100),
    tab: z.enum(["cost", "conversion", "search"]).default("search"),
    businessId: z
      .string()
      .regex(/^\d[\d_]{0,79}$/)
      .optional(),
    businessSearch: z.string().trim().max(100).default(""),
    regions: z
      .array(z.number().int().positive().max(9999999))
      .max(40)
      .default([]),
    removeDuplicate: z.boolean().default(false),
    regionExtend: z.boolean().default(false),
    device: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
    words: z.array(word).max(1000).default([]),
    negativeWords: z.array(word).max(100).default([]),
    price: z.number().finite().positive().max(9999).optional(),
    match: z.enum(["auto", "1-1", "2-1", "3-1"]).default("auto"),
    bosKey: z.string().min(1).max(2000).optional(),
    fileName: z.string().min(1).max(200).optional(),
    outputUngroupedWords: z.boolean().default(true),
    dimensions: z.array(baiduDimensionSchema).max(7).default([]),
    templateName: z.string().trim().min(1).max(100).optional(),
    templateId: z
      .union([z.string().min(1).max(100), z.number().int().nonnegative()])
      .optional(),
    trades: z.array(z.string().trim().max(200)).max(5).default([]),
    category: z.enum(["trade", "business"]).default("trade"),
    industryDevice: z.enum(["all", "pc", "wise"]).default("all"),
    startDate: z.iso.date().optional(),
    endDate: z.iso.date().optional(),
    wordType: z.enum(["hotWord", "newWord", "boomingWord"]).default("hotWord"),
    geoGran: z.enum(["country", "province", "city"]).default("country"),
    geoTarget: z.array(z.string().min(1).max(100)).max(40).default([]),
  })
  .superRefine((v, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (["flow", "massCreate"].includes(v.operation) && !v.words.length)
      fail("请输入关键词。");
    if (v.operation === "flow" && v.words.some((s) => s.length > 40))
      fail("流量查询每词最多40字。");
    if (v.operation === "rank" && !v.businessId) fail("请选择推广业务。");
    if (
      v.operation === "groupCreate" &&
      (!v.bosKey || !v.fileName || !v.dimensions.length)
    )
      fail("请上传关键词表格并设置分组维度。");
    if (
      v.operation === "templateCreate" &&
      (!v.templateName || !v.dimensions.length)
    )
      fail("请填写模板名称和维度。");
    if (v.operation === "templateDetail" && v.templateId === undefined)
      fail("请选择模板。");
    if (
      ["industryTrend", "industryWords"].includes(v.operation) &&
      (!v.trades[0] || !v.startDate || !v.endDate || v.startDate > v.endDate)
    )
      fail("请选择行业和有效日期范围。");
  });
export type BaiduResearchInput = z.infer<typeof baiduResearchInputSchema>;
export type ResearchRow = Record<string, string | number | boolean | null>;
export interface BaiduResearchResult {
  id: string;
  accountUid: string;
  input: BaiduResearchInput;
  fetchedAt: string;
  rows: ResearchRow[];
  total: number;
  keywords: Keyword[];
  /** Validated JSON for trees/templates; credentials are excluded before persistence. */
  data: unknown;
  warning?: string;
  knowledge?: {
    indexed: number;
    refreshedBelowThreshold: number;
    minimumMonthlySearches: number;
  };
}
export const baiduResearchResultSchema = z.object({
  id: z.string().max(200),
  accountUid: z.string().regex(/^[1-9]\d{0,19}$/),
  input: baiduResearchInputSchema,
  fetchedAt: z.iso.datetime(),
  rows: z
    .array(
      z.record(
        z.string(),
        z.union([
          z.string().max(32767),
          z.number().finite(),
          z.boolean(),
          z.null(),
        ]),
      ),
    )
    .max(100000),
  total: z.number().int().nonnegative(),
  keywords: z.array(keywordSchema).max(100000),
  data: z.unknown().default(null),
  warning: z.string().optional(),
  knowledge: z
    .object({
      indexed: z.number().int().nonnegative(),
      refreshedBelowThreshold: z.number().int().nonnegative(),
      minimumMonthlySearches: z.number(),
    })
    .optional(),
});
export type BaiduWireResponse = {
  status: number;
  body: string;
  userId: string;
};
type Contract<A, V> = { args: A; value: V };
export interface BaiduResearchContract {
  "baiduResearch.run": Contract<BaiduResearchInput, BaiduResearchResult>;
  "baiduResearch.latest": Contract<
    { accountId: string; operation: BaiduResearchInput["operation"] },
    BaiduResearchResult | null
  >;
  "baiduResearch.open": Contract<{ accountId: string; tool: BaiduTool }, void>;
  "baiduResearch.upload": Contract<
    { accountId: string; name: string; base64: string },
    { bosKey: string; fileName: string }
  >;
  "baiduResearch.download": Contract<
    { accountId: string; resultId: string; row: number },
    string | null
  >;
  "baiduResearch.collectTask": Contract<
    { accountId: string; resultId: string; row: number },
    { indexed: number; refreshedBelowThreshold: number; received: number }
  >;
  "baiduResearch.export": Contract<
    { accountId: string; resultId: string },
    string | null
  >;
}

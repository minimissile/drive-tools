import { z } from "zod";
import { id, now } from "./database";
import { AppError } from "./errors";
import {
  baiduKeywordColumns,
  baiduKeywordSource,
  baiduKeywordInputSchema,
  type BaiduKeywordInput,
  type BaiduKeywordResult,
} from "../shared/baidu-keywords";

// Verified against Baidu's toolsCenter /Kr/Keyword and @baidu/winds-ajax sources.
export const baiduKeywordPath =
  "lightning/GET/KeywordSuggestService/getKeywordRecommendPassive";

export function buildBaiduKeywordRequest(input: BaiduKeywordInput) {
  const value = baiduKeywordInputSchema.parse(input);
  return {
    wordQuerys: undefined as string[] | undefined,
    querySessions: undefined as string[] | undefined,
    ...(value.mode === "seed"
      ? {
          wordQuerys: [...new Set(value.seeds)],
          querySessions: [...new Set(value.seeds)],
        }
      : value.mode === "prompt"
        ? { promptQuerys: [value.prompt] }
        : value.mode === "url"
          ? { urlQuerys: [value.url] }
          : { businessPoints: [value.business!] }),
    entryMessage: "kr_station",
    source: "web",
    addFrom: { seed: 181, url: 182, business: 183, prompt: 154 }[value.mode],
    queryBy: 0,
    pageNo: 1,
    pageSize: 3000,
    sortField: value.sort,
    isDesc: value.descending,
    keyWordRecommendFilter: {
      device: value.device,
      positiveWords: value.positiveWords,
      negativeWords: value.negativeWords,
      fieldFilters:
        value.minimumMonthly === undefined
          ? []
          : [
              {
                field: "averageMonthPv",
                operator: "gte",
                values: [value.minimumMonthly],
              },
            ],
      keywordRecommendReasons: value.reasons,
      ...(value.competitions.length ? { competition: value.competitions } : {}),
      searchRegions: value.regions.length ? value.regions.join(",") : "9999999",
      regionExtend: value.regionExtend,
      removeDuplicate: value.removeDuplicate,
      removeCampaignDuplicate: false,
    },
  };
}

const metricSchema = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.null(),
]);
const rowSchema = z
  .object({ keyword: z.string().trim().min(1).max(200) })
  .passthrough();
const envelopeSchema = z
  .object({
    status: z.number(),
    redirect: z.boolean().optional(),
    data: z.unknown().optional(),
    errors: z
      .array(
        z.object({ code: z.union([z.string(), z.number()]) }).passthrough(),
      )
      .optional(),
  })
  .passthrough();

export function parseBaiduKeywordResponse(
  input: BaiduKeywordInput,
  response: { status: number; body: string; userId: string },
): BaiduKeywordResult {
  if ([401, 403].includes(response.status))
    throw new AppError(
      "BAIDU_LOGIN_REQUIRED",
      "百度营销会话已失效，请打开登录窗口完成验证。",
    );
  if (response.status !== 200)
    throw new AppError(
      "BAIDU_HTTP_ERROR",
      `百度关键词查询返回 HTTP ${response.status}，请稍后重试。`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(response.body);
  } catch {
    throw new AppError(
      "BAIDU_RESPONSE_INVALID",
      "百度未返回有效数据，请打开登录窗口检查登录或安全验证。",
    );
  }
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success)
    throw new AppError(
      "BAIDU_SCHEMA_CHANGED",
      "百度返回格式发生变化，本次结果未保存，请检查接口。",
    );
  const result = envelope.data;
  if (
    result.redirect ||
    [700, 940].includes(result.status) ||
    result.errors?.some((e) => ["99959", "99945"].includes(String(e.code)))
  )
    throw new AppError(
      "BAIDU_LOGIN_REQUIRED",
      "请在百度营销登录窗口完成登录或安全验证后，再手动查询。",
    );
  if (result.status !== 0)
    throw new AppError(
      "BAIDU_QUERY_FAILED",
      `百度关键词查询未成功（状态 ${result.status}），请在百度页面核对后重试。`,
    );
  const data = z
    .object({
      keywordRecommendItems: z.array(rowSchema).max(3000),
      totalCount: z.number().int().nonnegative(),
    })
    .safeParse(result.data);
  if (!data.success)
    throw new AppError(
      "BAIDU_SCHEMA_CHANGED",
      "百度关键词字段发生变化，本次结果未保存，请检查接口。",
    );
  const fetchedAt = now();
  const keywords = [
    ...new Map(
      data.data.keywordRecommendItems.map((row) => {
        const metrics: Record<string, string | number | null> = {};
        for (const [field] of baiduKeywordColumns) {
          if (row[field] === undefined) continue;
          const rawMetric =
            field === "showReasons" && Array.isArray(row[field])
              ? (row[field] as unknown[])
                  .filter((x) => typeof x === "string")
                  .join("、")
              : row[field];
          const metric = metricSchema.safeParse(rawMetric);
          if (!metric.success)
            throw new AppError(
              "BAIDU_SCHEMA_CHANGED",
              `百度关键词字段 ${field} 的格式发生变化，未保存不完整结果。`,
            );
          metrics[field] = metric.data;
        }
        return [
          row.keyword,
          {
            id: id("baidu_kw"),
            word: row.keyword,
            source: baiduKeywordSource,
            platform: "baidu",
            metrics,
            sourceUpdatedAt: null,
            fetchedAt,
          },
        ] as const;
      }),
    ).values(),
  ];
  if (data.data.totalCount < keywords.length)
    throw new AppError(
      "BAIDU_SCHEMA_CHANGED",
      "百度结果总数与关键词列表不一致，未保存本次结果。",
    );
  return {
    id: id("baidu_query"),
    accountUid: response.userId,
    input,
    keywords,
    total: data.data.totalCount,
    fetchedAt,
  };
}

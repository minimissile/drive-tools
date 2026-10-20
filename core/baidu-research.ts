import { z } from "zod";
import { id, now } from "./database";
import { AppError } from "./errors";
import { cleanKnowledge } from "./traffic-knowledge";
import { baiduKeywordSource } from "../shared/baidu-keywords";
import {
  baiduResearchInputSchema,
  type BaiduResearchInput,
  type BaiduResearchResult,
  type BaiduWireResponse,
  type ResearchRow,
} from "../shared/baidu-research";

/** Fixed operations verified from official toolsCenter 1485/5933/6154 and CDP 77/108. */
export function buildBaiduResearchRequest(raw: BaiduResearchInput) {
  const v = baiduResearchInputSchema.parse(raw);
  const paging = { pageNo: v.page, pageSize: v.pageSize };
  const region = v.regions.length ? v.regions.join(",") : "9999999";
  const groupRules = v.dimensions;
  const industry = {
    ...Object.fromEntries(
      ["first", "second", "third", "fourth", "fifth"].map((p, i) => [
        `${p}TradeName`,
        v.trades[i] ?? "",
      ]),
    ),
    deviceSources:
      v.industryDevice === "all" ? ["pc", "wise"] : [v.industryDevice],
    dataSource: "search",
    dataCategory: v.category,
    startDate: v.startDate,
    endDate: v.endDate,
  };
  let path: string, params: object;
  switch (v.operation) {
    case "keywordBusinesses":
      path = "thunder/GET/BusinessPointService/getBusinessPointList";
      params = { parentId: 0, search: v.businessSearch, needPath: true };
      break;
    case "businesses":
      path = "aigc-boost/GET/KeywordsRankService/getBusinessPointList";
      params = {};
      break;
    case "rankDate":
      path = "aigc-boost/GET/KeywordsRankService/getReadyDate";
      params = {};
      break;
    case "rank":
      path = "aigc-boost/GET/KeywordsRankService/getKeywordList";
      params = {
        page: { pageNo: v.page, pageSize: v.pageSize },
        tab: v.tab,
        businesspointid: v.businessId,
        isInPurchaseWord: v.removeDuplicate,
        ...(v.regions.length ? { regionTarget: v.regions } : {}),
      };
      break;
    case "flow":
      path = "puppet/GET/PvSearchFunction/getPvSearch";
      params = {
        logid: -1,
        entry: "kr_station_bidestimate_tab",
        bidWordSource: "wordList",
        regions: v.regions.length
          ? v.regions
          : [
              1000, 2000, 3000, 4000, 5000, 200000, 8000, 9000, 10000, 11000,
              12000, 13000, 14000, 15000, 16000, 17000, 18000, 19000, 20000,
              21000, 22000, 23000, 24000, 25000, 26000, 27000, 28000, 29000,
              30000, 31000, 32000, 33000, 34000, 35000, 36000, 300000,
            ],
        device: v.device,
        limit: [(v.page - 1) * v.pageSize, v.pageSize],
        orderBy: "averageMonthPv",
        order: "desc",
        campaignId: null,
        adgroupId: null,
        keywordList: [...new Set(v.words)].map((keywordName) => ({
          keywordName,
          price: v.price ?? null,
          matchType: v.match === "auto" ? null : Number(v.match[0]),
          phraseType: v.match === "auto" ? null : Number(v.match[2]),
        })),
      };
      break;
    case "massList":
      path =
        "lightning/GET/KeywordSuggestAsynTaskService/getKeywordSuggestAsynTask";
      params = { source: "web", taskIds: [], ...paging };
      break;
    case "massCreate":
      path =
        "lightning/GET/KeywordSuggestAsynTaskService/addKeywordSuggestAsynTask";
      params = {
        source: "web",
        querys: [...new Set(v.words)],
        keyWordRecommendFilter: {
          negativeWords: v.negativeWords,
          searchRegions: region,
          removeDuplicate: v.removeDuplicate,
          regionExtend: v.regionExtend,
        },
      };
      break;
    case "groupList":
      path = "aigc-boost/MOD/KeywordGroupAsyncService/getKeywordGroupAsync";
      params = paging;
      break;
    case "groupCreate":
      path = "aigc-boost/MOD/KeywordGroupAsyncService/submitKeywordGroupTask";
      params = {
        outputUngroupedWords: v.outputUngroupedWords,
        bosKey: v.bosKey,
        fileName: v.fileName,
        groupRules,
      };
      break;
    case "templates":
      path = "aigc-boost/MOD/KeywordGroupTemplateService/getTemplateList";
      params = {};
      break;
    case "templateDetail":
      path = "aigc-boost/MOD/KeywordGroupTemplateService/getTemplateDetail";
      params = { templateId: v.templateId };
      break;
    case "templateCreate":
      path = "aigc-boost/MOD/KeywordGroupTemplateService/addTemplate";
      params = {
        templateName: v.templateName,
        items: v.dimensions.map((d) => ({
          dimensionName:
            (
              { 1: "region", 2: "businessPoint", 3: "keyword" } as Record<
                number,
                string
              >
            )[d.type] ?? d.dimensionName,
          keywordRootList: d.keywordRootList,
        })),
      };
      break;
    case "industryTree":
      path = "xinghe-insight/POST/IndustryTrafficService/getTradeNodeListV2";
      params = {};
      break;
    case "industryChildren":
      path = "xinghe-insight/POST/IndustryTrafficService/getSubTradeNodeListV2";
      params = {
        firstTradeName: v.trades[0] ?? "",
        secondTradeName: v.trades[1] ?? "",
      };
      break;
    case "industryTrend":
      path = "xinghe-insight/POST/IndustryTrafficService/getSearchTrend";
      params = {
        ...industry,
        geoGran: v.geoGran,
        geoGranO: v.geoGran,
        geoTarget: v.geoTarget,
      };
      break;
    case "industryWords":
      path = "xinghe-insight/POST/IndustryTrafficService/getSearchWord";
      params = { ...industry, type: v.wordType };
      break;
  }
  return {
    host: v.operation.startsWith("industry")
      ? "cdp.baidu.com"
      : "fengchao.baidu.com",
    path,
    params,
  };
}
export function parseBaiduData(response: BaiduWireResponse): unknown {
  if ([401, 403].includes(response.status))
    throw new AppError(
      "BAIDU_LOGIN_REQUIRED",
      "百度会话已失效，请在账号管理打开官方窗口完成验证。",
    );
  if (response.status !== 200)
    throw new AppError(
      "BAIDU_HTTP_ERROR",
      `百度返回 HTTP ${response.status}，请稍后手动重试。`,
    );
  let value: unknown;
  try {
    value = JSON.parse(response.body);
  } catch {
    throw new AppError(
      "BAIDU_RESPONSE_INVALID",
      "百度未返回有效数据，请打开官方窗口检查登录或安全验证。",
    );
  }
  const parsed = z
    .object({
      status: z.number(),
      redirect: z.boolean().optional(),
      errors: z
        .array(
          z.object({ code: z.union([z.string(), z.number()]) }).passthrough(),
        )
        .optional(),
      data: z.unknown().optional(),
    })
    .safeParse(value);
  if (!parsed.success)
    throw new AppError(
      "BAIDU_SCHEMA_CHANGED",
      "百度返回格式变化，本次未覆盖本地成功记录。",
    );
  const r = parsed.data;
  if (
    r.redirect ||
    [700, 940].includes(r.status) ||
    r.errors?.some((e) => ["99959", "99945"].includes(String(e.code)))
  )
    throw new AppError(
      "BAIDU_LOGIN_REQUIRED",
      "请在百度官方窗口完成登录或安全验证。",
    );
  if (r.status !== 0)
    throw new AppError(
      "BAIDU_QUERY_FAILED",
      `百度操作未成功（状态 ${r.status}），请在官方窗口核对后手动重试。`,
    );
  return cleanKnowledge(r.data);
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const scalar = (v: unknown) =>
  typeof v === "string" ||
  typeof v === "number" ||
  typeof v === "boolean" ||
  v === null
    ? v
    : undefined;
const wordValue = z.string().trim().min(1).max(200);
const taskRow = z
  .object({
    taskId: z.union([z.string().min(1), z.number().int().nonnegative()]),
    status: z.number().int().min(0).max(3),
  })
  .passthrough();
export function validateBaiduResearchData(
  operation: BaiduResearchInput["operation"],
  data: unknown,
) {
  const d = object(data);
  const rowSchemas: Partial<
    Record<BaiduResearchInput["operation"], z.ZodType>
  > = {
    rank: z.object({ wordName: wordValue }).passthrough(),
    flow: z.object({ keywordName: wordValue }).passthrough(),
    massList: taskRow,
    groupList: taskRow,
    industryWords: z.object({ word: wordValue }).passthrough(),
    industryTrend: z
      .object({
        statDate: z.union([z.string(), z.number()]),
        firstTrend: z.number().finite().nullable(),
      })
      .passthrough(),
  };
  const list =
    operation === "rank"
      ? d.pageData
      : operation === "flow"
        ? d.data
        : operation === "massList"
          ? d.keywordSuggestAsynTaskInfos
          : operation === "groupList"
            ? d.list
            : data;
  const rowSchema = rowSchemas[operation];
  let valid =
    !rowSchema || z.array(rowSchema).max(100000).safeParse(list).success;
  if (operation === "templates")
    valid = z
      .array(
        z.object({
          templateId: z.union([z.string(), z.number()]),
          templateName: z.string(),
        }),
      )
      .safeParse(data).success;
  if (operation === "templateDetail")
    valid = z
      .array(
        z.object({
          dimensionName: z.string(),
          keywordRoot: z.array(z.string()),
        }),
      )
      .safeParse(data).success;
  if (operation === "businesses")
    valid = z.array(z.record(z.string(), z.unknown())).safeParse(data).success;
  if (operation === "industryTree")
    valid = z
      .object({ tradeNodeList: z.array(z.unknown()) })
      .safeParse(data).success;
  if (!valid)
    throw new AppError(
      "BAIDU_SCHEMA_CHANGED",
      "百度业务字段发生变化，本次未覆盖本地成功记录。",
    );
}
export function parseBaiduResearchResponse(
  input: BaiduResearchInput,
  response: BaiduWireResponse,
): BaiduResearchResult {
  const data = parseBaiduData(response),
    d = object(data),
    op = input.operation;
  validateBaiduResearchData(op, data);
  const list =
    op === "rank"
      ? d.pageData
      : op === "flow"
        ? d.data
        : op === "massList"
          ? d.keywordSuggestAsynTaskInfos
          : op === "groupList"
            ? d.list
            : Array.isArray(data)
              ? data
              : undefined;
  const requiresRows = [
    "rank",
    "flow",
    "massList",
    "groupList",
    "industryTrend",
    "industryWords",
  ];
  if (requiresRows.includes(op) && !Array.isArray(list))
    throw new AppError(
      "BAIDU_SCHEMA_CHANGED",
      "百度列表字段发生变化，本次未覆盖本地成功记录。",
    );
  if (Array.isArray(list) && list.length > 100000)
    throw new AppError(
      "BAIDU_RESULT_TOO_LARGE",
      "百度返回数据过多，请缩小查询范围。",
    );
  const rows: ResearchRow[] = (Array.isArray(list) ? list : []).map((v) =>
    Object.fromEntries(
      Object.entries(object(v)).flatMap(([k, v]) => {
        if (/token|cookie|secret|password|authorization/i.test(k)) return [];
        const s = scalar(v);
        return s !== undefined
          ? [[k, s]]
          : Array.isArray(v) &&
              v.every((x) => typeof x === "string" || typeof x === "number")
            ? [[k, v.join("、")]]
            : [];
      }),
    ),
  );
  const fetchedAt = now();
  const keywords = rows.flatMap((row) => {
    const word = row.keywordName ?? row.wordName ?? row.word ?? row.keyword;
    if (typeof word !== "string" || !word.trim() || word.length > 200)
      return [];
    const metrics: Record<string, string | number | null> = {};
    for (const [key, v] of Object.entries(row))
      if (
        v !== null &&
        typeof v !== "boolean" &&
        !/^(?:keywordName|wordName|word|keyword|downloadUrl|resultUrl|url)$/.test(
          key,
        )
      )
        metrics[key] = v;
    if (op === "flow" && row.kwc !== undefined)
      metrics.competition = row.kwc as number;
    // Ranking pv/pay/cv and industry firstTrend/searchRate are NOT monthly searches.
    return [
      {
        id: id("baidu_kw"),
        word: word.trim(),
        source: baiduKeywordSource,
        platform: "baidu",
        metrics,
        sourceUpdatedAt: null,
        fetchedAt,
      },
    ];
  });
  const total = d.totalCount ?? d.total ?? rows.length;
  if (
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < rows.length
  )
    throw new AppError(
      "BAIDU_SCHEMA_CHANGED",
      "百度结果总数无效，本次未保存。",
    );
  return {
    id: id("baidu_research"),
    accountUid: response.userId,
    input,
    fetchedAt,
    rows,
    total,
    keywords,
    data,
  };
}

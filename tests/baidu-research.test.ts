import test from "node:test";
import assert from "node:assert/strict";
import { baiduResearchInputSchema as schema } from "../shared/baidu-research";
import {
  buildBaiduResearchRequest as build,
  parseBaiduResearchResponse as parse,
} from "../core/baidu-research";
import { buildBaiduKeywordRequest } from "../core/baidu-keywords";
import { baiduKeywordInputSchema } from "../shared/baidu-keywords";
import { baiduTaskKeywordChunks } from "../core/baidu-result-table";
import { xlsx } from "../core/export-formats";
import { fixture } from "./helpers";
import type { IpcMethod, IpcValue } from "../shared/ipc";

const input = (v: object) => schema.parse({ accountId: "web_test", ...v });
const response = (data: unknown, status = 0) => ({
  status: 200,
  userId: "123456",
  body: JSON.stringify({ status, data }),
});
test("Baidu seed, prompt, URL, business and combinations retain source-specific parameters", () => {
  for (const [mode, extra, field, addFrom] of [
    ["seed", { seeds: ["网盘"] }, "wordQuerys", 181],
    ["prompt", { seeds: [], prompt: "知识管理教程" }, "promptQuerys", 154],
    [
      "url",
      { seeds: [], url: "https://example.com/landing" },
      "urlQuerys",
      182,
    ],
    [
      "business",
      {
        seeds: [],
        business: { businessPointId: 200103, businessPointName: "户外娱乐" },
      },
      "businessPoints",
      183,
    ],
  ] as const) {
    const v = buildBaiduKeywordRequest(
      baiduKeywordInputSchema.parse({
        accountId: "web_test",
        mode,
        ...extra,
        combinations: true,
        positiveWords: ["教程"],
        negativeWords: ["免费"],
        minimumMonthly: 11,
        competitions: [3],
        regions: [1000],
        device: 2,
      }),
    );
    assert.equal(v.addFrom, addFrom);
    assert.ok(field in v);
    assert.deepEqual(v.keyWordRecommendFilter.fieldFilters, [
      { field: "averageMonthPv", operator: "gte", values: [11] },
    ]);
    assert.deepEqual(v.keyWordRecommendFilter.competition, [3]);
    assert.equal(v.keyWordRecommendFilter.searchRegions, "1000");
  }
  assert.throws(() =>
    baiduKeywordInputSchema.parse({
      accountId: "web_test",
      mode: "prompt",
      seeds: [],
      prompt: "",
    }),
  );
  assert.throws(() =>
    baiduKeywordInputSchema.parse({
      accountId: "web_test",
      mode: "url",
      seeds: [],
      url: "file:///etc/passwd",
    }),
  );
});
test("Baidu rank, flow and asynchronous tools use verified fixed paths and bounded fields", () => {
  const rank = build(
    input({
      operation: "rank",
      businessId: "2001_200103_0",
      tab: "conversion",
      page: 2,
      pageSize: 20,
      regions: [1000],
    }),
  );
  assert.equal(rank.path, "aigc-boost/GET/KeywordsRankService/getKeywordList");
  assert.deepEqual(rank.params, {
    page: { pageNo: 2, pageSize: 20 },
    tab: "conversion",
    businesspointid: "2001_200103_0",
    isInPurchaseWord: false,
    regionTarget: [1000],
  });
  const flow = build(
    input({
      operation: "flow",
      words: ["网盘", "网盘"],
      match: "2-1",
      price: 2,
      device: 1,
      page: 2,
      pageSize: 50,
    }),
  );
  assert.equal(flow.path, "puppet/GET/PvSearchFunction/getPvSearch");
  assert.deepEqual((flow.params as any).limit, [50, 50]);
  assert.deepEqual((flow.params as any).keywordList, [
    { keywordName: "网盘", price: 2, matchType: 2, phraseType: 1 },
  ]);
  const mass = build(
    input({
      operation: "massCreate",
      words: ["网盘"],
      negativeWords: ["免费"],
      removeDuplicate: true,
      regionExtend: true,
    }),
  );
  assert.deepEqual((mass.params as any).keyWordRecommendFilter, {
    negativeWords: ["免费"],
    searchRegions: "9999999",
    removeDuplicate: true,
    regionExtend: true,
  });
  const dimensions = [
    { type: 4, dimensionName: "需求", keywordRootList: ["教程", "下载"] },
  ];
  assert.deepEqual(
    build(
      input({
        operation: "groupCreate",
        bosKey: "file/key",
        fileName: "词.xlsx",
        dimensions,
      }),
    ).params,
    {
      outputUngroupedWords: true,
      bosKey: "file/key",
      fileName: "词.xlsx",
      groupRules: dimensions,
    },
  );
  assert.deepEqual(
    build(
      input({ operation: "templateCreate", templateName: "教程", dimensions }),
    ).params,
    {
      templateName: "教程",
      items: [{ dimensionName: "需求", keywordRootList: ["教程", "下载"] }],
    },
  );
  for (const value of [
    { operation: "flow", words: ["词".repeat(41)] },
    { operation: "massCreate", words: Array(1001).fill("词") },
    { operation: "rank" },
    { operation: "groupCreate", dimensions: [] },
    { operation: "flow", words: [] },
    {
      operation: "templateCreate",
      templateName: "模板",
      dimensions: Array(8).fill(dimensions[0]),
    },
  ])
    assert.throws(() => input(value));
});
test("Industry trends and TOP word types keep date/device/geography and never invent monthly volume", () => {
  const base = {
    trades: ["教育", "培训"],
    startDate: "2026-09-01",
    endDate: "2026-09-30",
    industryDevice: "wise",
    category: "trade",
  };
  const trend = build(
    input({
      operation: "industryTrend",
      ...base,
      geoGran: "province",
      geoTarget: ["北京"],
    }),
  );
  assert.equal(trend.host, "cdp.baidu.com");
  assert.equal(
    trend.path,
    "xinghe-insight/POST/IndustryTrafficService/getSearchTrend",
  );
  assert.deepEqual((trend.params as any).deviceSources, ["wise"]);
  assert.equal((trend.params as any).secondTradeName, "培训");
  assert.deepEqual((trend.params as any).geoTarget, ["北京"]);
  for (const wordType of ["hotWord", "newWord", "boomingWord"]) {
    const v = input({ operation: "industryWords", ...base, wordType }),
      r = parse(
        v,
        response([{ word: "网盘教程", trade: "教育", searchRate: 0.2 }]),
      );
    assert.equal((build(v).params as any).type, wordType);
    assert.equal(r.keywords[0].metrics.averageMonthPv, undefined);
    assert.equal(r.keywords[0].metrics.searchRate, 0.2);
  }
  const rank = parse(
    input({ operation: "rank", businessId: "2001_200103_0" }),
    response({
      pageData: [
        {
          rank: 1,
          wordName: "教程",
          pv: 9999,
          pay: 100,
          cv: 3,
          token: "redact",
        },
      ],
      total: 1,
    }),
  );
  assert.equal(rank.keywords[0].metrics.averageMonthPv, undefined);
  assert.equal(rank.keywords[0].metrics.pv, 9999);
  assert.ok(!JSON.stringify(rank).includes('"redact"'));
  assert.throws(() =>
    input({ operation: "industryTrend", ...base, startDate: "2026-10-01" }),
  );
});
test("Baidu task tables require a genuine monthly column and support stable replay plus <5", () => {
  const file = xlsx([
    ["关键词", "月均搜索量", "点击指导价"],
    ["网盘", "100", "2.5"],
    ["备份", "<5", "1.2"],
  ]);
  const a = baiduTaskKeywordChunks(
      "web_test",
      "123456",
      "3146570",
      "结果.xlsx",
      file,
    ),
    b = baiduTaskKeywordChunks(
      "web_test",
      "123456",
      "3146570",
      "结果.xlsx",
      file,
    );
  assert.equal(a.received, 2);
  assert.equal(a.chunks[0].id, b.chunks[0].id);
  assert.equal(a.chunks[0].keywords[1].metrics.averageMonthPv, "<5");
  const repeated=baiduTaskKeywordChunks("web_test","123456","same-word","结果.xlsx",xlsx([["关键词","月均搜索量"],["Ａ","20"],["a","30"]]));
  assert.equal(repeated.received,1);
  assert.equal(repeated.chunks[0].keywords[0].metrics.averageMonthPv,"30");
  assert.throws(
    () =>
      baiduTaskKeywordChunks(
        "web_test",
        "123456",
        "t",
        "结果.xlsx",
        xlsx([
          ["关键词", "搜索指数"],
          ["教程", "99999"],
        ]),
      ),
    { code: "BAIDU_TASK_MONTHLY_MISSING" },
  );
});
test("Malformed rows and template metadata are rejected before they can replace a successful result",()=>{
  for(const [v,data] of [
    [{operation:"rank",businessId:"2001_200103_0"},{pageData:[null],total:1}],
    [{operation:"flow",words:["网盘"]},{data:[{keywordName:""}],totalCount:1}],
    [{operation:"massList"},{keywordSuggestAsynTaskInfos:[{taskId:1}],totalCount:1}],
    [{operation:"templates"},[null]],
    [{operation:"templateDetail",templateId:1},[{dimensionName:"词性"}]],
    [{operation:"industryTree"},{changed:[]}],
  ] as const)assert.throws(()=>parse(input(v),response(data)),{code:"BAIDU_SCHEMA_CHANGED"});
});
test("Baidu research cache is local, account-isolated, durable ingestion is idempotent and failures retain prior result", async () => {
  const f = await fixture();
  const invoke = <M extends IpcMethod>(method: M, args?: unknown) =>
    f.app.invoke(method, args) as Promise<IpcValue<M>>;
  let calls = 0,
    uid = "123456",
    bad = false;
  const wire = response({
    data: [{ keywordName: "网盘", averageMonthPv: 1234, kwc: 1 }],
    totalCount: 1,
  });
  f.ports.websiteSessions = {
    isOpen: () => false,
    login: async () => {},
    clear: async () => {},
    invalidate: async () => {},
    status: async () => ({
      hasSession: true,
      uid,
      windowOpen: false,
      error: null,
    }),
  };
  f.ports.baiduKeywords = {
    query: async () => wire,
    run: async () => {
      calls++;
      return bad ? { ...wire, body: "{}" } : wire;
    },
    download: async () =>
      xlsx([
        ["关键词", "月均搜索量"],
        ["网盘", "<5"],
        ["新词", "11"],
        ["十次", "10"],
      ]),
  };
  try {
    const a = await invoke("websiteAccounts.add", {
        provider: "baidu-marketing",
      }),
      v = input({ accountId: a.id, operation: "flow", words: ["网盘"] });
    assert.equal(
      await invoke("baiduResearch.latest", {
        accountId: a.id,
        operation: "flow",
      }),
      null,
    );
    assert.equal(calls, 0);
    const r = await invoke("baiduResearch.run", v);
    assert.equal(calls, 1);
    assert.equal(r.knowledge?.indexed, 1);
    await invoke("baiduResearch.latest", {
      accountId: a.id,
      operation: "flow",
    });
    await invoke("baiduResearch.latest", {
      accountId: a.id,
      operation: "flow",
    });
    assert.equal(calls, 1);
    const before = await invoke("traffic.knowledge.list", {
      endpoint: "baidu-keywords",
    });
    assert.equal(before.total, 1);
    assert.equal(before.summary.observations, 1);
    bad = true;
    await assert.rejects(invoke("baiduResearch.run", v), {
      code: "BAIDU_SCHEMA_CHANGED",
    });
    assert.equal(
      (
        await invoke("baiduResearch.latest", {
          accountId: a.id,
          operation: "flow",
        })
      )?.id,
      r.id,
    );
    bad = false;
    f.ports.baiduKeywords.run = async () => {
      calls++;
      return response({
        keywordSuggestAsynTaskInfos: [
          {
            taskId: 1,
            status: 1,
            result: "https://example.bcebos.com/result.xlsx",
          },
        ],
        totalCount: 1,
      });
    };
    const tasks = await invoke(
      "baiduResearch.run",
      input({ accountId: a.id, operation: "massList" }),
    );
    for (let n = 0; n < 2; n++) {
      const stats = await invoke("baiduResearch.collectTask", {
        accountId: a.id,
        resultId: tasks.id,
        row: 0,
      });
      assert.equal(stats.indexed, 1);
      assert.equal(stats.refreshedBelowThreshold, 1);
    }
    const after = await invoke("traffic.knowledge.list", {
      endpoint: "baidu-keywords",
    });
    assert.equal(after.total, 2);
    assert.equal(after.summary.observations, 3);
    assert.equal(
      after.items.find((x) => x.word === "网盘")?.metrics.averageMonthPv,
      "<5",
    );
    assert.equal(
      after.items.some((x) => x.word === "十次"),
      false,
    );
    uid = "654321";
    assert.equal(
      await invoke("baiduResearch.latest", {
        accountId: a.id,
        operation: "flow",
      }),
      null,
    );
    await assert.rejects(
      invoke("baiduResearch.export", { accountId: a.id, resultId: r.id }),
      { code: "BAIDU_RESULT_MISSING" },
    );
  } finally {
    await f.cleanup();
  }
});

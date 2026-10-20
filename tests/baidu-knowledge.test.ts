import test from "node:test";
import assert from "node:assert/strict";
import {
  baiduKeywordInputSchema,
  type BaiduKeywordResult,
} from "../shared/baidu-keywords";
import { fixture } from "./helpers";
const input = baiduKeywordInputSchema.parse({
  accountId: "web_test",
  seeds: ["网盘"],
});
function result(
  id: string,
  date: string,
  values: [string, number | string | null][],
): BaiduKeywordResult {
  return {
    id,
    accountUid: "123456",
    input,
    total: values.length,
    fetchedAt: date,
    keywords: values.map(([word, pv], i) => ({
      id: `kw_${i}`,
      word,
      platform: "baidu",
      source: "百度营销 · 关键词规划师",
      metrics: { averageMonthPv: pv, recommendPrice: 1.25 },
      sourceUpdatedAt: null,
      fetchedAt: date,
    })),
  };
}
test("Baidu library admits only monthly volume >10, refreshes by source/word and preserves first seen/history", async () => {
  const f = await fixture();
  try {
    const k = f.app.traffic.knowledge;
    const first = result("run-1", "2026-10-20T01:00:00.000Z", [
      ["网盘", 11],
      ["边界", 10],
      ["零值", 0],
      ["未知", null],
      ["字符串", "1,200"],
      ["无效", "none"],
      ["AI", 12],
      ["ＡＩ", 13],
    ]);
    assert.deepEqual(k.ingestBaidu(first), {
      indexed: 3,
      refreshedBelowThreshold: 0,
      minimumMonthlySearches: 10,
    });
    let list = k.list({ endpoint: "baidu-keywords" });
    assert.equal(list.total, 3);
    assert.equal(list.summary.queries, 1);
    k.ingestBaidu(first);
    assert.equal(k.list({}).summary.observations, 3);
    const second = result("run-2", "2026-10-21T01:00:00.000Z", [
      ["网盘", 100],
      ["边界", 11],
      ["字符串", 0],
    ]);
    assert.deepEqual(k.ingestBaidu(second), {
      indexed: 2,
      refreshedBelowThreshold: 1,
      minimumMonthlySearches: 10,
    });
    list = k.list({ endpoint: "baidu-keywords" });
    assert.equal(list.total, 4);
    const word = list.items.find((w) => w.word === "网盘")!;
    assert.equal(word.metrics.averageMonthPv, 100);
    assert.equal(word.observations, 2);
    assert.equal(word.firstObservedAt, first.fetchedAt);
    assert.equal(word.observedAt, second.fetchedAt);
    assert.equal(
      list.items.find((w) => w.word === "字符串")?.metrics.averageMonthPv,
      0,
    );
    k.ingestBaidu(result("older", "2026-10-19T01:00:00.000Z", [["网盘", 999]]));
    assert.equal(
      k.list({ search: "网盘" }).items[0].metrics.averageMonthPv,
      100,
    );
    const other = k.begin("test", "longtail", "query", { keyword: "网盘" }, "");
    k.receive(
      other,
      { errcode: 0, data: { word: [{ keyword: "网盘", index: 888 }] } },
      200,
      "",
    );
    k.finish(other, "success");
    assert.equal(k.list({ search: "网盘" }).total, 2);
    assert.equal(
      k.list({ endpoint: "baidu-keywords", view: "queries" }).queries.length,
      3,
    );
    assert.match(k.export({ endpoint: "baidu-keywords" }), /百度营销/);
  } finally {
    await f.cleanup();
  }
});
test("Baidu cache backfill is local, idempotent, survives cache removal, and never becomes an unknown 5118 source", async () => {
  const f = await fixture();
  try {
    const r = result("cached", "2026-10-20T01:00:00.000Z", [
      ["持久词", 12],
      ["排除词", 10],
    ]);
    f.app.db.run(
      "INSERT INTO api_cache VALUES(?,?,?)",
      "baidu-keywords:latest:web_test",
      JSON.stringify(r),
      "2026-12-01T00:00:00Z",
    );
    f.app.db.run("DELETE FROM traffic_knowledge_meta");
    const k = f.app.traffic.knowledge;
    k.recoverLegacy();
    k.recoverBaidu();
    k.recoverBaidu();
    assert.equal(k.list({}).total, 1);
    assert.equal(k.list({}).summary.queries, 1);
    assert.equal(k.list({}).items[0].source, "百度营销 · 关键词规划师");
    f.app.db.run("DELETE FROM api_cache");
    assert.equal(k.list({}).total, 1);
  } finally {
    await f.cleanup();
  }
});
test("Successful Baidu query still returns data on archive failure; retrying the local cache archives without remote calls", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    f.ports.websiteSessions = {
      isOpen: () => false,
      login: async () => {},
      clear: async () => {},
      invalidate: async () => {},
      status: async () => ({
        hasSession: true,
        uid: "123456",
        windowOpen: false,
        error: null,
      }),
    };
    const account = f.app.websiteAccounts.add("baidu-marketing");
    f.ports.baiduKeywords = {
      query: async () => {
        calls++;
        return {
          status: 200,
          userId: "123456",
          body: JSON.stringify({
            status: 0,
            data: {
              keywordRecommendItems: [
                { keyword: "重试入库", averageMonthPv: 12 },
              ],
              totalCount: 1,
            },
          }),
        };
      },
    };
    const original = f.app.db.run.bind(f.app.db);
    f.app.db.run = (sql, ...values) => {
      if (sql.startsWith("INSERT INTO traffic_items")) throw Error("disk full");
      return original(sql, ...values);
    };
    let r: BaiduKeywordResult;
    try {
      r = (await f.app.invoke("baiduKeywords.query", {
        ...input,
        accountId: account.id,
      })) as BaiduKeywordResult;
    } finally {
      f.app.db.run = original;
    }
    assert.equal(r.keywords.length, 1);
    assert.match(r.knowledgeWarning!, /无需重新查询/);
    assert.equal(f.app.traffic.knowledge.list({}).total, 0);
    const retried = (await f.app.invoke("baiduKeywords.latest", {
      accountId: account.id,
    })) as BaiduKeywordResult;
    assert.equal(retried.knowledgeWarning, undefined);
    assert.equal(retried.knowledge?.indexed, 1);
    assert.equal(calls, 1);
    assert.equal(f.app.traffic.knowledge.list({}).total, 1);
  } finally {
    await f.cleanup();
  }
});

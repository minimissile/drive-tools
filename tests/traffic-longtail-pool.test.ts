import test from "node:test";
import assert from "node:assert/strict";
import { Database, databaseSchemaVersion } from "../core/database";
import { TrafficKnowledge } from "../core/traffic-knowledge";
import { keywordSchema } from "../shared/schemas";
import {
  knowledgeFilter,
  longtailKnowledgeEndpoints,
} from "../shared/traffic-knowledge";

function fixture() {
  const db = new Database(":memory:");
  return { db, knowledge: new TrafficKnowledge(db) };
}
function observe(
  db: Database,
  queryId: string,
  word: string,
  endpoint: string,
  patch: {
    source?: string;
    kind?: string;
    platform?: string;
    date?: string;
    metrics?: Record<string, unknown>;
  } = {},
) {
  const observationId = `${queryId}:${word}:${patch.kind ?? "word"}`;
  const date = patch.date ?? "2026-11-07T00:00:00.000Z";
  db.transaction(() => {
    db.run(
      "INSERT OR IGNORE INTO traffic_queries(id,endpoint,phase,request,seeds,platform,status,response,received_at) VALUES(?,?,'query','{}','[]',?,'success','{}',?)",
      queryId,
      endpoint,
      patch.platform ?? "baidu",
      date,
    );
    db.run(
      "INSERT INTO traffic_items(id,query_id,kind,word,normalized_word,platform,source,metrics,observed_at) VALUES(?,?,?,?,?,?,?,?,?)",
      observationId,
      queryId,
      patch.kind ?? "word",
      word,
      word.normalize("NFKC").trim().toLowerCase(),
      patch.platform ?? "baidu",
      patch.source ?? endpoint,
      JSON.stringify(patch.metrics ?? {}),
      date,
    );
  });
  return observationId;
}

test("long-tail pool is an explicit source-defined subset of keywords, independent of volume or phrase length", () => {
  const { db, knowledge } = fixture();
  try {
    assert.equal(knowledgeFilter.parse({ kind: "longtail" }).kind, "longtail");
    assert.deepEqual(longtailKnowledgeEndpoints, [
      "baidu-discovery",
      "longtail",
    ]);
    observe(db, "discovery", "百度扩词候选", "baidu-discovery", {
      metrics: { averageMonthPv: 10, averageMonthPvSource: "默认值（非实测）" },
    });
    observe(db, "longtail", "没有月量的长尾候选", "longtail");
    observe(db, "marketing", "同样默认10的营销词", "baidu-keywords", {
      metrics: { averageMonthPv: 10, averageMonthPvSource: "默认值（非实测）" },
    });
    observe(db, "suggest", "这是一句很长但不是长尾来源的搜索建议", "suggest");
    observe(db, "metrics", "搜索量词", "metrics", {
      metrics: { averageMonthPv: 100 },
    });
    observe(db, "unknown", "来源不明确的长句不能猜作长尾", "unknown");
    observe(db, "radar", "热点", "radar", { kind: "hotspot" });
    observe(db, "unusual", "旧长尾档案中的热点", "longtail", {
      kind: "hotspot",
    });
    const result = knowledge.list({ kind: "longtail" });
    assert.equal(result.total, 2);
    assert.deepEqual(
      new Set(result.items.map((item) => item.word)),
      new Set(["百度扩词候选", "没有月量的长尾候选"]),
    );
    assert.ok(result.items.every((item) => item.kind === "word"));
    assert.equal(
      knowledge.list({ kind: "word" }).total,
      6,
      "ordinary keyword view still includes the long-tail subset",
    );
    assert.equal(
      knowledge.list({ kind: "longtail", volume: "default" }).items[0].word,
      "百度扩词候选",
    );
    assert.equal(
      knowledge.list({ kind: "longtail", volume: "unknown" }).items[0].word,
      "没有月量的长尾候选",
    );
    assert.equal(
      knowledge.list({ kind: "longtail", volume: "measured" }).total,
      0,
    );
  } finally {
    db.close();
  }
});

test("long-tail feeds retain independent current records and histories for the same word", () => {
  const { db, knowledge } = fixture();
  try {
    const source = "保留旧接口历史的同一来源";
    observe(db, "old-marketing", "ＡＩ教程", "baidu-keywords", {
      source,
      date: "2026-10-01",
      metrics: {},
    });
    const defaultId = observe(db, "discovery", "ＡＩ教程", "baidu-discovery", {
      source,
      date: "2026-11-01",
      metrics: { averageMonthPv: 10, averageMonthPvSource: "默认值（非实测）" },
    });
    const longtailId = observe(db, "longtail", "AI教程", "longtail", {
      source,
      date: "2026-11-02",
      metrics: { averageMonthPv: 80 },
    });
    observe(db, "new-marketing", "ai教程", "baidu-keywords", {
      source,
      date: "2026-11-05",
      metrics: { averageMonthPv: 1000 },
    });
    observe(db, "another", "另一个长尾词", "longtail", {
      date: "2026-11-04",
      metrics: { averageMonthPv: 50 },
    });
    const current = knowledge.list({ kind: "longtail", sort: "monthly" });
    assert.equal(current.total, 3);
    assert.deepEqual(
      current.items.map((item) => item.metrics.averageMonthPv),
      [80, 50, 10],
    );
    const item = current.items[0];
    const all = knowledge.list({ search: "ai教程" }).items[0];
    assert.equal(item.id, longtailId);
    assert.equal(item.word, "AI教程");
    assert.equal(item.queryId, "longtail");
    assert.notEqual(item.entryId, all.entryId);
    assert.equal(item.firstObservedAt, "2026-11-02");
    assert.equal(item.observedAt, "2026-11-02");
    assert.equal(item.observations, 1);
    assert.equal(all.observations, 2);
    assert.equal(all.metrics.averageMonthPv, 1000);
    assert.equal(
      knowledge.list({ kind: "longtail", sort: "recent" }).items[0].word,
      "另一个长尾词",
    );
    assert.equal(
      knowledge.list({ kind: "longtail", volume: "default" }).total,
      1,
      "the discovery feed keeps its own default metric",
    );
    assert.equal(
      knowledge.list({ kind: "longtail", volume: "measured" }).total,
      2,
    );
    const onlyDiscovery = knowledge.list({
      kind: "longtail",
      endpoint: "baidu-discovery",
    }).items[0];
    assert.equal(onlyDiscovery.id, defaultId);
    assert.equal(onlyDiscovery.metrics.averageMonthPv, 10);
    assert.equal(onlyDiscovery.observations, 1);
    assert.equal(onlyDiscovery.firstObservedAt, "2026-11-01");
    assert.equal(
      knowledge
        .list({ kind: "longtail", endpoint: "longtail" })
        .items.find((entry) => entry.entryId === item.entryId)?.observations,
      1,
    );
    assert.equal(
      knowledge.history({ entryId: item.entryId }).total,
      1,
      "entry history contains only the matching feed",
    );
  } finally {
    db.close();
  }
});

test("long-tail type intersects source and platform filters without widening them", () => {
  const { db, knowledge } = fixture();
  try {
    observe(db, "discovery", "百度长尾", "baidu-discovery");
    observe(db, "longtail", "抖音长尾", "longtail", { platform: "douyin" });
    observe(db, "marketing", "百度营销", "baidu-keywords");
    assert.equal(
      knowledge.list({ kind: "longtail", endpoint: "baidu-discovery" }).total,
      1,
    );
    assert.equal(
      knowledge.list({ kind: "longtail", endpoint: "longtail" }).total,
      1,
    );
    assert.equal(
      knowledge.list({ kind: "longtail", platform: "douyin" }).items[0].word,
      "抖音长尾",
    );
    assert.equal(
      knowledge.list({
        kind: "longtail",
        endpoint: "baidu-discovery",
        platform: "douyin",
      }).total,
      0,
    );
    for (const endpoint of [
      "baidu-keywords",
      "suggest",
      "metrics",
      "radar",
    ] as const) {
      assert.equal(knowledge.list({ kind: "longtail", endpoint }).total, 0);
      assert.equal(
        knowledge.list({ kind: "longtail", endpoint, view: "queries" }).total,
        0,
      );
      assert.equal(
        knowledge.export({ kind: "longtail", endpoint }).trim().split("\n")
          .length,
        1,
      );
    }
  } finally {
    db.close();
  }
});

test("long-tail archive and CSV scopes include only matching keyword observations", () => {
  const { db, knowledge } = fixture();
  try {
    observe(db, "discovery", "默认长尾", "baidu-discovery", {
      metrics: { averageMonthPv: 10, averageMonthPvSource: "默认值（非实测）" },
    });
    observe(db, "discovery", "缺量长尾", "baidu-discovery");
    observe(db, "discovery", "同查询热点不进入池", "baidu-discovery", {
      kind: "hotspot",
    });
    observe(db, "longtail", "5118长尾", "longtail");
    observe(db, "marketing", "营销词不进入池", "baidu-keywords");
    observe(db, "hotspot-only", "无关键词的长尾档案", "longtail", {
      kind: "hotspot",
    });
    db.run(
      "INSERT INTO traffic_queries(id,endpoint,phase,request,seeds,status) VALUES('empty','longtail','query','{}','[]','success')",
    );
    const archives = knowledge.list({ kind: "longtail", view: "queries" });
    assert.deepEqual(
      new Set(archives.queries.map((query) => query.id)),
      new Set(["discovery", "longtail"]),
    );
    assert.equal(
      archives.queries.find((query) => query.id === "discovery")?.count,
      2,
    );
    for (const view of ["items", "queries"] as const) {
      const csv = knowledge.export({ kind: "longtail", view });
      assert.match(csv, /默认长尾/);
      assert.match(csv, /缺量长尾/);
      assert.match(csv, /5118长尾/);
      assert.doesNotMatch(
        csv,
        /同查询热点不进入池|营销词不进入池|无关键词的长尾档案/,
      );
      const onlyDefault = knowledge.export({
        kind: "longtail",
        view,
        volume: "default",
      });
      assert.match(onlyDefault, /默认长尾/);
      assert.doesNotMatch(onlyDefault, /缺量长尾|5118长尾|同查询热点不进入池/);
    }
    assert.equal(
      knowledge.list({ kind: "longtail", view: "queries", volume: "unknown" })
        .total,
      2,
    );
    assert.equal(
      knowledge.list({ kind: "longtail", view: "queries", volume: "measured" })
        .total,
      0,
    );
  } finally {
    db.close();
  }
});

test("long-tail pagination and historical exports are complete without duplicating entry identities", () => {
  const { db, knowledge } = fixture();
  try {
    for (let index = 0; index < 61; index++) {
      const endpoint = index % 2 ? "longtail" : "baidu-discovery";
      observe(
        db,
        `qualifying-${index}`,
        `长尾候选${String(index).padStart(3, "0")}`,
        endpoint,
      );
      observe(
        db,
        `other-${index}`,
        `普通候选${String(index).padStart(3, "0")}`,
        "baidu-keywords",
      );
    }
    observe(db, "older", "长尾候选000", "baidu-discovery", {
      date: "2026-11-01",
    });
    const first = knowledge.list({ kind: "longtail", sort: "word" });
    const second = knowledge.list({ kind: "longtail", sort: "word", page: 2 });
    assert.equal(first.total, 61);
    assert.equal(second.total, 61);
    assert.equal(first.items.length, 50);
    assert.equal(second.items.length, 11);
    assert.equal(
      new Set([...first.items, ...second.items].map((item) => item.entryId))
        .size,
      61,
    );
    assert.equal(
      first.items.find((item) => item.word === "长尾候选000")?.observations,
      2,
    );
    const queryIds: string[] = [];
    for (let page = 1; page <= 4; page++) {
      const result = knowledge.list({
        kind: "longtail",
        view: "queries",
        page,
      });
      assert.equal(result.total, 62);
      queryIds.push(...result.queries.map((query) => query.id));
    }
    assert.equal(new Set(queryIds).size, 62);
    const exported = knowledge.export({ kind: "longtail" });
    assert.equal(
      exported.trim().split("\n").length,
      63,
      "header plus every qualifying historical observation",
    );
    assert.doesNotMatch(exported, /普通候选/);
  } finally {
    db.close();
  }
});

test("long-tail working set preserves ordinary keyword snapshots and does not migrate or rewrite data", () => {
  const { db, knowledge } = fixture();
  try {
    const observationId = observe(
      db,
      "discovery",
      "可复用长尾",
      "baidu-discovery",
      {
        metrics: {
          averageMonthPv: 10,
          averageMonthPvSource: "默认值（非实测）",
        },
      },
    );
    const before = db.get<{ n: number }>("SELECT total_changes() n")!.n;
    const original = knowledge.list({ kind: "word" }).items[0];
    const longtail = knowledge.list({ kind: "longtail" }).items[0];
    assert.equal(longtail.kind, "word");
    assert.equal(longtail.id, observationId);
    assert.equal(longtail.entryId, original.entryId);
    assert.deepEqual(longtail.metrics, original.metrics);
    assert.equal(
      keywordSchema.parse({
        id: longtail.id,
        word: longtail.word,
        platform: longtail.platform,
        source: longtail.source,
        metrics: longtail.metrics,
        fetchedAt: longtail.observedAt,
        sourceUpdatedAt: longtail.sourceUpdatedAt,
      }).metrics.averageMonthPv,
      10,
    );
    assert.equal(db.get<{ n: number }>("SELECT total_changes() n")!.n, before);
    assert.equal(
      db.get<{ user_version: number }>("PRAGMA user_version")!.user_version,
      databaseSchemaVersion,
    );
    assert.equal(
      db.get<{ n: number }>(
        "SELECT count(*) n FROM traffic_entries WHERE kind='longtail'",
      )!.n,
      0,
    );
  } finally {
    db.close();
  }
});

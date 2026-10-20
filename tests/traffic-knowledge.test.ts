import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fixture, removeV8 } from "./helpers";
import { Database } from "../core/database";
import { TrafficService } from "../core/traffic";
import { TrafficKnowledge } from "../core/traffic-knowledge";
import { fetchJson } from "../core/http";
import type { Endpoint } from "../shared/types";
import type { IdeaContext } from "../shared/ideas";
import { inspectBackup, stageRestore } from "../core/backups";
async function enabled(
  f: Awaited<ReturnType<typeof fixture>>,
  endpoint: Endpoint,
) {
  await f.app.secrets.set(`5118:${endpoint}`, "private-5118-test-secret");
  f.app.db.run(
    "UPDATE api_plans SET enabled=1,daily_units=100,unit_price_micros=1000 WHERE endpoint=?",
    endpoint,
  );
}
const q = {
  endpoint: "longtail" as const,
  seeds: ["Obsidian"],
  pages: 1,
  useCache: true,
};

test("real attempts archive immutable full responses; refresh/key change/cache expiry cannot erase observations; AI recalls archive after cache deletion", async () => {
  const f = await fixture();
  try {
    await enabled(f, "longtail");
    let calls = 0;
    const service = new TrafficService(
      f.app.db,
      f.app.secrets,
      () => {},
      async () => ({
        errcode: 0,
        extra: { notNormalized: true, api_key: "private-5118-test-secret" },
        data: {
          page_count: 1,
          word: [
            {
              keyword: "Obsidian怎么用",
              index: ++calls,
              add_time: "2024-01-01",
              future_field: { details: "完整业务字段" },
              echo: "private-5118-test-secret",
            },
          ],
        },
      }),
    );
    await service.query(q);
    await service.query(q);
    assert.equal(calls, 1);
    assert.equal(service.knowledge.list({}).summary.queries, 1);
    await service.query({ ...q, useCache: false });
    f.app.db.setSetting("keyRevision:longtail", "new-key");
    await service.query(q);
    f.app.db.run("DELETE FROM api_cache");
    const result = service.knowledge.list({});
    assert.equal(result.summary.queries, 3);
    assert.equal(result.summary.observations, 3);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].observations, 3);
    assert.equal(result.items[0].metrics.index, 3);
    const archived = service.knowledge.detail(result.items[0].queryId);
    assert.match(archived.response!, /future_field|完整业务字段/);
    assert.doesNotMatch(archived.response!, /private-5118-test-secret/);
    assert.deepEqual(archived.query.seeds, ["Obsidian"]);
    const history = f.app.db
      .all<any>("SELECT metrics FROM traffic_items ORDER BY rowid")
      .map((r) => JSON.parse(r.metrics).index);
    assert.deepEqual(history, [1, 2, 3]);
    const ideas = (await f.app.invoke("ai.ideas.preview", {
      seeds: ["Obsidian"],
      resourceId: null,
    })) as IdeaContext;
    assert.ok(
      ideas.references.some(
        (r) => r.word === "Obsidian怎么用" && r.id.startsWith("archive:"),
      ),
    );
    assert.equal(calls, 3);
  } finally {
    await f.cleanup();
  }
});

test("all pages retained before later timeout and budget failures; empty/schema-error/remote-error observations are honest", async () => {
  const f = await fixture();
  try {
    await enabled(f, "longtail");
    let calls = 0;
    const service = new TrafficService(
      f.app.db,
      f.app.secrets,
      () => {},
      async () => {
        calls++;
        if (calls === 2) throw new Error("timeout");
        return {
          errcode: 0,
          data: { page_count: 2, word: [{ keyword: "课程怎么学", index: 5 }] },
        };
      },
    );
    await assert.rejects(service.query({ ...q, pages: 2 }), /timeout/);
    let list = service.knowledge.list({ view: "queries" });
    assert.equal(list.summary.queries, 2);
    assert.equal(list.summary.observations, 1);
    const failed = list.queries.find((r) => r.status === "uncertain")!;
    assert.equal(service.knowledge.detail(failed.id).response, null);
    for (const response of [
      { errcode: 0, data: { word: [] } },
      { errcode: 0, data: {} },
      {
        errcode: 100101,
        errmsg: "额度不足",
        data: { word: [{ keyword: "错误响应不能当成功词条" }] },
      },
    ]) {
      const next = new TrafficService(
        f.app.db,
        f.app.secrets,
        () => {},
        async () => response,
      );
      try {
        await next.query({ ...q, useCache: false });
      } catch {}
    }
    list = service.knowledge.list({ view: "queries" });
    assert.equal(list.summary.queries, 5);
    assert.equal(list.summary.responses, 4);
    assert.equal(list.summary.observations, 1);
    f.app.db.run(
      "UPDATE api_plans SET daily_units=0 WHERE endpoint='longtail'",
    );
    await assert.rejects(service.query({ ...q, seeds: ["new"] }), {
      code: "API_BUDGET_EXCEEDED",
    });
    assert.equal(service.knowledge.list({}).summary.queries, 5);
  } finally {
    await f.cleanup();
  }
});

test("suggestion pending/resume and metrics submit/pending/poll keep every exchange and originating seeds", async () => {
  const f = await fixture();
  try {
    await enabled(f, "suggest");
    await enabled(f, "metrics");
    let suggestions = 0,
      metrics = 0;
    const service = new TrafficService(
      f.app.db,
      f.app.secrets,
      () => {},
      async (url) =>
        url.includes("keywordparam")
          ? ++metrics === 1
            ? { errcode: 0, data: { taskid: "remote-task" } }
            : metrics === 2
              ? { errcode: 200104 }
              : {
                  errcode: 0,
                  data: {
                    keyword_param: [
                      {
                        keyword: "Obsidian对比",
                        bidword_pcpv: 23,
                        new_metric: 7,
                      },
                    ],
                  },
                }
          : ++suggestions === 1
            ? { errcode: 200104, detail: "正在分析" }
            : {
                errcode: 0,
                data: [{ promote_word: "Obsidian安装教程", index: 9 }],
              },
    );
    const suggestion = await service.query({
      ...q,
      endpoint: "suggest",
      platform: "baidu",
    });
    f.app.db.run(
      "UPDATE suggestion_queries SET last_requested_at='2020-01-01'",
    );
    await service.resumeSuggestion(suggestion.pendingSuggestions![0]);
    const m = await service.query({ ...q, endpoint: "metrics" });
    f.app.db.run("UPDATE async_queries SET created_at='2020-01-01'");
    await service.query({ ...q, endpoint: "metrics", taskId: m.taskId });
    f.app.db.run("UPDATE async_queries SET last_polled_at='2020-01-01'");
    await service.query({ ...q, endpoint: "metrics", taskId: m.taskId });
    const result = service.knowledge.list({ view: "queries" });
    assert.equal(result.summary.queries, 5);
    assert.equal(result.summary.observations, 2);
    assert.equal(
      result.queries.filter((r) => r.status === "pending").length,
      2,
    );
    assert.deepEqual(
      result.queries
        .filter((r) => r.endpoint === "metrics")
        .map((r) => r.seeds),
      [["Obsidian"], ["Obsidian"], ["Obsidian"]],
    );
    assert.equal(result.seeds[0].queries, 3);
    assert.equal(result.seeds[0].results, 2);
    assert.equal(
      service.knowledge.list({ platform: "baidu" }).items[0].word,
      "Obsidian安装教程",
    );
  } finally {
    await f.cleanup();
  }
});

test("radar archives full event chains with historical metrics and offers local filtered export", async () => {
  const f = await fixture();
  try {
    await enabled(f, "radar");
    let times = 0;
    const service = new TrafficService(
      f.app.db,
      f.app.secrets,
      () => {},
      async () => ({
        errcode: 0,
        data: {
          type_name: "科技",
          list: [
            {
              hot_id: "h1",
              hot_name: "AI办公热点",
              event_hot_exp: ++times,
              event_vein: [
                { title: "起因", date: "2024-10-01", content: "完整事件内容" },
              ],
            },
          ],
        },
      }),
    );
    await service.query({
      ...q,
      endpoint: "radar",
      seeds: ["AI办公"],
      useCache: false,
    });
    await service.query({
      ...q,
      endpoint: "radar",
      seeds: ["AI办公"],
      useCache: false,
    });
    f.app.db.run("DELETE FROM api_cache");
    const r = service.knowledge.list({ endpoint: "radar", search: "热点" });
    assert.equal(r.summary.hotspots, 1);
    assert.equal(r.items[0].observations, 2);
    assert.match(
      service.knowledge.detail(r.items[0].queryId).response!,
      /完整事件内容/,
    );
    const context = f.app.ideas.preview({
      resourceId: null,
      seeds: ["AI办公"],
    });
    assert.ok(
      context.references.some(
        (r) => r.word === "AI办公热点" && r.source.includes("热点雷达"),
      ),
    );
    const csv = service.knowledge.export({ search: "热点" });
    assert.match(csv, /AI办公热点/);
    assert.equal(csv.split("\r\n").length, 4);
    assert.equal(service.knowledge.list({ search: "不存在" }).total, 0);
  } finally {
    await f.cleanup();
  }
});

test("HTTP observer archives non-JSON and HTTP error responses before transport throws, with no credential leaks", async () => {
  const f = await fixture(),
    original = globalThis.fetch;
  try {
    await enabled(f, "longtail");
    const service = new TrafficService(
      f.app.db,
      f.app.secrets,
      () => {},
      fetchJson,
    );
    const responses = [
      new Response("<html>bad gateway private-5118-test-secret</html>", {
        status: 502,
      }),
      new Response(
        JSON.stringify({
          errcode: 0,
          api_key: "another-secret",
          data: { word: [{ keyword: "不应入词库" }] },
        }),
        { status: 403 },
      ),
    ];
    globalThis.fetch = async () => responses.shift()!;
    await assert.rejects(service.query({ ...q, useCache: false }), {
      code: "INVALID_RESPONSE",
    });
    await assert.rejects(service.query({ ...q, useCache: false }), {
      code: "HTTP_ERROR",
    });
    const list = service.knowledge.list({ view: "queries" });
    assert.equal(list.summary.responses, 2);
    assert.equal(list.summary.observations, 0);
    for (const row of list.queries) {
      const d = service.knowledge.detail(row.id);
      assert.ok([502, 403].includes(d.query.httpStatus!));
      assert.doesNotMatch(
        d.response!,
        /private-5118-test-secret|another-secret/,
      );
    }
  } finally {
    globalThis.fetch = original;
    await f.cleanup();
  }
});

test("legacy surviving raw pages and normalized async/suggestion results recover offline and idempotently with unknown dates kept unknown", async () => {
  const f = await fixture();
  try {
    f.app.db.run("DELETE FROM traffic_knowledge_meta");
    f.app.db.run(
      "INSERT INTO api_cache VALUES(?,?,?)",
      "expired",
      JSON.stringify({
        data: {
          word: [
            {
              keyword: "旧词怎么用",
              extra: "历史字段",
              add_time: "2019-01-01",
            },
          ],
        },
        _panxuFetchedAt: "2020-01-01",
      }),
      "2020-01-02",
    );
    const result = JSON.stringify({
      keywords: [
        { word: "异步旧词", source: "5118 搜索量 v2", metrics: { index: 5 } },
      ],
      hotspots: [],
    });
    f.app.db.run(
      "INSERT INTO async_queries(task_id,endpoint,seeds,created_at,status,result) VALUES('old','metrics','[\"旧词\"]','2020','completed',?)",
      result,
    );
    const k = new TrafficKnowledge(f.app.db);
    k.recoverLegacy();
    k.recoverLegacy();
    f.app.db.run("DELETE FROM traffic_knowledge_meta");
    k.recoverLegacy();
    assert.equal(k.list({}).summary.queries, 2);
    assert.equal(k.list({}).summary.observations, 2);
    assert.equal(k.list({ search: "异步" }).items[0].observedAt, null);
    assert.equal(
      k.list({ search: "旧词怎么" }).items[0].observedAt,
      "2020-01-01",
    );
    assert.equal(k.list({}).seeds.length, 0);
    f.app.db.run("DELETE FROM api_cache");
    assert.equal(k.list({}).summary.words, 2);
  } finally {
    await f.cleanup();
  }
});

test("knowledge pagination scans complete library, keeps distinct platform snapshots, exports all filtered rows and escapes spreadsheet formulas", async () => {
  const f = await fixture();
  try {
    const k = f.app.traffic.knowledge,
      aid = k.begin("test", "longtail", "query", { keyword: "教程" }, "");
    k.receive(
      aid,
      {
        errcode: 0,
        data: {
          word: Array.from({ length: 121 }, (_, i) => ({
            keyword: i === 0 ? "=SUM(1,2)" : `教程怎么学${i}`,
            index: i,
          })),
        },
      },
      200,
      "",
    );
    k.finish(aid, "success");
    assert.equal(k.list({}).total, 121);
    assert.equal(k.list({ page: 3 }).items.length, 21);
    assert.equal(k.list({ search: "怎么学120" }).items.length, 1);
    assert.match(k.export({}), /'=SUM/);
    assert.equal(k.export({view:"queries",search:"教程"}).split("\r\n").length,123);
    assert.equal(k.export({view:"items",search:"教程"}).split("\r\n").length,122);
    assert.equal(k.export({}).split("\r\n").length, 123);
    assert.equal(
      k.list({}).patterns.find((p) => p.name === "教程 / 操作步骤")?.count,
      120,
    );
    await assert.rejects(f.app.invoke("traffic.knowledge.list", { page: -1 }));
  } finally {
    await f.cleanup();
  }
});

test("v7 migration backs up once and durable knowledge survives backup/restore without settings, cache or credentials", async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, "v7.db");
    const initial = new Database(path);
    initial.close();
    const old = new DatabaseSync(path);
    old.exec(removeV8 + "PRAGMA user_version=7;");
    old.close();
    new Database(path).close();
    new Database(path).close();
    const names = (await readdir(f.dir)).filter((n) =>
      n.startsWith("v7.db.before-v8-"),
    );
    assert.equal(names.length, 1);
    assert.equal((await stat(join(f.dir, names[0]))).mode & 0o777, 0o600);
    const k = f.app.traffic.knowledge,
      aid = k.begin("test", "longtail", "query", { keyword: "备份" }, "");
    k.receive(
      aid,
      { errcode: 0, data: { word: [{ keyword: "备份怎么恢复" }] } },
      200,
      "",
    );
    k.finish(aid, "success");
    f.app.db.run(
      "INSERT INTO api_cache VALUES(?,?,?)",
      "current-cache",
      JSON.stringify({
        keywords: [
          { word: "备份怎么恢复", source: "5118 长尾词 v2", metrics: {} },
        ],
        hotspots: [],
      }),
      "2099",
    );
    const backup = join(f.dir, "backup");
    await mkdir(backup);
    f.ports.chooseDirectory = async () => backup;
    const exported = (await f.app.invoke("system.backup")) as string;
    const info = await inspectBackup(exported);
    const staged = await stageRestore(exported, f.dir, info.databaseSha256);
    const db = new Database(join(staged.dataPath, "panxu.db"));
    try {
      const restored = new TrafficKnowledge(db);
      restored.recoverLegacy();
      assert.equal(restored.list({}).summary.words, 1);
      assert.equal(restored.list({}).summary.queries, 1);
      assert.equal(restored.detail(aid).query.seeds[0], "备份");
      assert.equal(db.get<any>("SELECT COUNT(*) n FROM secrets")?.n, 0);
    } finally {
      db.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("complete responses index beyond display limits and malformed business fields cannot discard the envelope", async () => {
  const f = await fixture();
  try {
    const k = f.app.traffic.knowledge,
      aid = k.begin("test", "longtail", "query", { keyword: "批量" }, "");
    k.receive(
      aid,
      {
        errcode: 0,
        data: {
          word: [
            ...Array.from({ length: 5005 }, (_, i) => ({
              keyword: `批量资料${i}`,
              index: i,
            })),
            { keyword: { unexpected: true } },
            {
              keyword: "坏字段仍保留",
              platform: { bad: 1 },
              source: { bad: 1 },
              fetchedAt: { bad: 1 },
              add_time: { bad: 1 },
            },
          ],
        },
      },
      200,
      "",
    );
    assert.equal(k.list({}).summary.observations, 5006);
    assert.equal(k.list({ search: "批量资料5004" }).total, 1);
    assert.match(k.detail(aid).response!, /unexpected/);
    const after = f.app.ideas.preview({
      resourceId: null,
      seeds: ["批量资料"],
    });
    assert.ok(after.references.length > 1);
  } finally {
    await f.cleanup();
  }
});

test("an echoed current API key is hidden in archive, fee messages and surfaced errors", async () => {
  const f = await fixture();
  try {
    await enabled(f, "longtail");
    const service = new TrafficService(
      f.app.db,
      f.app.secrets,
      () => {},
      async () => ({
        errcode: 999,
        errmsg: "bad private-5118-test-secret",
        data: { arbitrary: "private-5118-test-secret" },
      }),
    );
    await assert.rejects(service.query(q), (error) => {
      assert.doesNotMatch(String(error), /private-5118-test-secret/);
      return true;
    });
    const query = service.knowledge.list({ view: "queries" }).queries[0];
    assert.doesNotMatch(
      JSON.stringify(service.knowledge.detail(query.id)),
      /private-5118-test-secret/,
    );
    assert.doesNotMatch(
      JSON.stringify(f.app.repo.calls()),
      /private-5118-test-secret/,
    );
  } finally {
    await f.cleanup();
  }
});

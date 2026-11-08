import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import { Database } from "../core/database";
import { TrafficKnowledge } from "../core/traffic-knowledge";
import {
  packTrafficArchive,
  unpackTrafficArchive,
} from "../core/traffic-knowledge-store";

test("raw archive marker collisions round-trip once without guessing that raw text is stored data", () => {
  const marker = "panxu:gzip:v1:";
  const collision = marker + gzipSync("这不是原响应").toString("base64");
  const rawBodies = [
    "普通短响应",
    "完整响应".repeat(1000),
    collision,
    marker + "invalid gzip",
    marker + gzipSync(collision).toString("base64"),
  ];
  for (const raw of rawBodies) {
    const stored = packTrafficArchive(raw);
    assert.equal(unpackTrafficArchive(stored), raw);
    if (raw.startsWith(marker)) assert.notEqual(stored, raw);
  }
  const db = new Database(":memory:");
  try {
    const k = new TrafficKnowledge(db);
    const query = k.begin(
      "marker-response",
      "longtail",
      "query",
      { keyword: "原文" },
      "",
    );
    k.receive(query, collision, 200, "");
    const stored = db.get<{ response: string }>(
      "SELECT response FROM traffic_queries WHERE id=?",
      query,
    )!.response;
    for (let i = 0; i < 3; i++) {
      assert.equal(k.detail(query).response, collision);
      k.receive(query, collision, 200, "");
      assert.equal(
        db.get<{ response: string }>(
          "SELECT response FROM traffic_queries WHERE id=?",
          query,
        )!.response,
        stored,
      );
    }
  } finally {
    db.close();
  }
});

function observation(
  db: Database,
  id: string,
  word: string,
  date: string | null,
  metrics: Record<string, unknown>,
  patch: {
    endpoint?: string;
    source?: string;
    platform?: string;
    kind?: string;
  } = {},
) {
  db.transaction(() => {
    db.run(
      "INSERT INTO traffic_queries(id,endpoint,phase,request,seeds,platform,status,response,received_at) VALUES(?,?,'query','{}','[\"起始词\"]',?,'success',?,?)",
      id,
      patch.endpoint ?? "baidu-discovery",
      patch.platform ?? "baidu",
      packTrafficArchive(
        JSON.stringify({ word, metrics, extra: "完整历史证据" }),
      ),
      date,
    );
    db.run(
      "INSERT INTO traffic_items(id,query_id,kind,word,normalized_word,platform,source,metrics,data,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      `obs_${id}`,
      id,
      patch.kind ?? "word",
      word,
      word.normalize("NFKC").trim().toLowerCase(),
      patch.platform ?? "baidu",
      patch.source ?? "百度批量扩词",
      JSON.stringify(metrics),
      JSON.stringify({ word, metrics }),
      date,
    );
  });
}

function downgradeTrafficToV33(db: Database) {
  db.db.exec(`
    DROP VIEW traffic_items;
    DROP TABLE traffic_observations;
    DROP TABLE traffic_entries;
    DROP INDEX traffic_queries_endpoint;
    ALTER TABLE traffic_queries DROP COLUMN item_count;
    ALTER TABLE traffic_queries DROP COLUMN legacy_items;
    CREATE TABLE traffic_items(id TEXT PRIMARY KEY,query_id TEXT NOT NULL REFERENCES traffic_queries(id),kind TEXT NOT NULL,word TEXT NOT NULL,normalized_word TEXT NOT NULL,platform TEXT,source TEXT NOT NULL,metrics TEXT NOT NULL,data TEXT NOT NULL,observed_at TEXT,source_updated_at TEXT);
    CREATE INDEX traffic_items_word ON traffic_items(normalized_word,platform,observed_at DESC);
    CREATE INDEX traffic_items_query ON traffic_items(query_id);
    PRAGMA user_version=33;
  `);
}

test("stable entries retain exact observation history, independent sources and filtered snapshots", () => {
  const db = new Database(":memory:");
  try {
    observation(db, "a", "ＡＩ教程", "2026-11-01", {
      averageMonthPv: 10,
      averageMonthPvSource: "默认值（非实测）",
    });
    const k = new TrafficKnowledge(db);
    const first = k.list({}).items[0];
    observation(db, "b", "AI教程", "2026-11-02", { averageMonthPv: "1,200" });
    observation(db, "c", "AI教程 入门", "2026-11-03", {});
    observation(
      db,
      "d",
      "AI教程",
      "2026-10-31",
      { averageMonthPv: 25 },
      { endpoint: "baidu-keywords" },
    );
    observation(
      db,
      "e",
      "AI教程",
      "2026-11-03",
      { index: 8 },
      { source: "5118 长尾词 v2", endpoint: "longtail" },
    );
    const current = k.list({ search: "AI教程", endpoint: "baidu-discovery" });
    assert.equal(current.total, 2);
    const entry = current.items.find((item) => item.word === "AI教程")!;
    assert.equal(entry.entryId, first.entryId);
    assert.equal(entry.metrics.averageMonthPv, "1,200");
    assert.equal(entry.observations, 2);
    assert.equal(
      k.list({ search: "AI教程", endpoint: "baidu-keywords" }).items[0].metrics
        .averageMonthPv,
      25,
    );
    const history = k.history({ entryId: first.entryId });
    assert.equal(history.total, 2);
    assert.deepEqual(
      history.items.map((item) => item.queryId),
      ["b", "a"],
    );
    assert.equal(history.items[1].word, "ＡＩ教程");
    assert.ok(history.items.every((item) => item.entryId === first.entryId));
    assert.equal(db.get<any>("SELECT count(*) n FROM traffic_entries")?.n, 4);
    assert.equal(
      db.get<any>("SELECT count(*) n FROM traffic_observations")?.n,
      5,
    );
    assert.equal(
      db
        .all<any>("PRAGMA table_info(traffic_observations)")
        .some((row) => row.name === "data"),
      false,
    );
  } finally {
    db.close();
  }
});

test("volume filters, monthly sorting, exact history pagination and metadata cache follow local writes", () => {
  const db = new Database(":memory:");
  try {
    const k = new TrafficKnowledge(db);
    assert.equal(k.overview().summary.words, 0);
    observation(db, "default", "默认词", "2026-11-01", {
      averageMonthPv: 10,
      averageMonthPvSource: "默认值（非实测）",
    });
    observation(db, "measured", "实测词", "2026-11-02", {
      averageMonthPv: "1,200",
    });
    observation(db, "unknown", "未知词", null, {});
    observation(
      db,
      "hotspot",
      "热点",
      "2026-11-03",
      {},
      { kind: "hotspot", endpoint: "radar" },
    );
    assert.equal(k.list({ volume: "default" }).items[0].word, "默认词");
    assert.equal(k.list({ volume: "measured" }).items[0].word, "实测词");
    assert.equal(
      k.list({ volume: "unknown", kind: "word" }).items[0].word,
      "未知词",
    );
    assert.deepEqual(
      k.list({ sort: "monthly", kind: "word" }).items.map((item) => item.word),
      ["实测词", "默认词", "未知词"],
    );
    assert.equal(k.list({ kind: "hotspot" }).total, 1);
    for (let i = 0; i < 22; i++)
      observation(db, `later_${i}`, "默认词", "2026-11-04", {
        averageMonthPv: i,
      });
    const entry = k.list({ search: "默认词" }).items[0];
    const page1 = k.history({ entryId: entry.entryId });
    const page2 = k.history({ entryId: entry.entryId, page: 2 });
    assert.equal(page1.total, 23);
    assert.equal(page1.items.length, 20);
    assert.equal(page2.items.length, 3);
    assert.equal(
      new Set([...page1.items, ...page2.items].map((item) => item.id)).size,
      23,
    );
    assert.equal(page1.items[0].queryId, "later_21");
    assert.equal(k.overview().summary.observations, 26);
    assert.equal(k.overview().seeds[0].results, 26);
    db.run("DELETE FROM traffic_items WHERE id=?", page1.items[0].id);
    assert.equal(
      k.list({ search: "默认词" }).items[0].metrics.averageMonthPv,
      20,
    );
  } finally {
    db.close();
  }
});

test("invalid monthly values stay unknown, while finite quantities and explicit bounds are measured", () => {
  const db = new Database(":memory:");
  try {
    const unknown: unknown[] = [
      "",
      "unknown",
      "NaN",
      "Infinity",
      "1e999",
      -1,
      "-1",
      "1..2",
      null,
      false,
      {},
      [],
      "<unknown",
      "<-1",
    ];
    unknown.forEach((value, i) =>
      observation(db, `invalid_${i}`, `无效${i}`, "2026-11-01", {
        averageMonthPv: value,
      }),
    );
    const measured: unknown[] = [0, "0", 10, "10", "1,200", "1e3", "<5", "<10"];
    measured.forEach((value, i) =>
      observation(db, `valid_${i}`, `有效${i}`, "2026-11-01", {
        averageMonthPv: value,
      }),
    );
    observation(db, "bad_default", "无效默认", "2026-11-01", {
      averageMonthPv: "unknown",
      averageMonthPvSource: "默认值（非实测）",
    });
    const k = new TrafficKnowledge(db);
    assert.equal(k.list({ volume: "unknown" }).total, unknown.length + 1);
    assert.equal(k.list({ volume: "measured" }).total, measured.length);
    assert.equal(k.list({ volume: "default" }).total, 0);
    assert.equal(
      k.list({ endpoint: "baidu-discovery", volume: "unknown" }).total,
      unknown.length + 1,
    );
  } finally {
    db.close();
  }
});

test("v33 migration backs up once, preserves archives and observations, and detects writes on another connection", async () => {
  const folder = await mkdtemp(join(tmpdir(), "panxu-traffic-migration-"));
  const path = join(folder, "panxu.db");
  const raw = JSON.stringify({
    data: {
      word: [
        { keyword: "历史词", index: 9, detail: "完整业务字段".repeat(2000) },
      ],
    },
  });
  let db = new Database(path);
  try {
    downgradeTrafficToV33(db);
    db.run(
      "INSERT INTO traffic_queries(id,endpoint,phase,request,seeds,status,response) VALUES('old','longtail','query','{}','[]','success',?)",
      raw,
    );
    const collision =
      "panxu:gzip:v1:" + gzipSync("旧响应中的标记正文").toString("base64");
    db.run(
      "INSERT INTO traffic_queries(id,endpoint,phase,request,seeds,status,response) VALUES('marker','longtail','query','{}','[]','success',?)",
      collision,
    );
    db.run(
      "INSERT INTO traffic_items(id,query_id,kind,word,normalized_word,source,metrics,data,observed_at) VALUES('old_obs','old','word','历史词','历史词','5118 长尾词 v2','{\"index\":9}',?,'2026-11-01')",
      JSON.stringify({
        keyword: "历史词",
        detail: "完整业务字段".repeat(2000),
      }),
    );
    db.run(
      "INSERT INTO traffic_queries(id,endpoint,phase,request,seeds,status) VALUES('missing_response','unknown','legacy','{}','[]','recovered')",
    );
    db.run(
      "INSERT INTO traffic_items(id,query_id,kind,word,normalized_word,source,metrics,data,observed_at) VALUES('sole_observation','missing_response','word','仅存逐条证据','仅存逐条证据','旧记录','{}',?,'2026-10-01')",
      JSON.stringify({
        soleEvidence: "响应缺失但逐条业务证据仍须保留".repeat(1000),
      }),
    );
    db.close();
    db = new Database(path);
    const k = new TrafficKnowledge(db);
    const item = k.list({ search: "历史词" }).items[0];
    assert.equal(item.id, "old_obs");
    assert.equal(item.observations, 1);
    assert.equal(k.detail("old").response, raw);
    assert.equal(k.detail("marker").response, collision);
    const storedMarker = db.get<{ response: string }>(
      "SELECT response FROM traffic_queries WHERE id='marker'",
    )!.response;
    const missing = k.detail("missing_response");
    assert.equal(missing.response, null);
    assert.match(
      missing.recoveredObservations!,
      /响应缺失但逐条业务证据仍须保留/,
    );
    assert.equal(
      JSON.parse(missing.recoveredObservations!)[0].observationId,
      "sole_observation",
    );
    assert.ok(
      db.get<any>(
        "SELECT length(response) n FROM traffic_queries WHERE id='old'",
      )!.n <
        raw.length / 5,
    );
    assert.match(k.export({}), /历史词/);
    const other = new Database(path);
    try {
      observation(other, "other", "另一个词", "2026-11-02", {});
    } finally {
      other.close();
    }
    assert.equal(k.overview().summary.words, 3);
    db.close();
    db = new Database(path);
    assert.equal(new TrafficKnowledge(db).detail("marker").response, collision);
    assert.equal(
      db.get<{ response: string }>(
        "SELECT response FROM traffic_queries WHERE id='marker'",
      )!.response,
      storedMarker,
    );
    assert.equal(
      new TrafficKnowledge(db).list({ search: "历史词" }).items[0].entryId,
      item.entryId,
    );
    assert.equal(
      (await readdir(folder)).filter((name) => name.includes("before-v34"))
        .length,
      1,
    );
  } finally {
    db.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("failed migration rolls back atomically and leaves a readable original backup", async () => {
  const folder = await mkdtemp(join(tmpdir(), "panxu-traffic-rollback-"));
  const path = join(folder, "panxu.db");
  const db = new Database(path);
  try {
    downgradeTrafficToV33(db);
    db.db.exec("PRAGMA foreign_keys=OFF");
    db.run(
      "INSERT INTO traffic_items(id,query_id,kind,word,normalized_word,source,metrics,data) VALUES('orphan','absent','word','待修复记录','待修复记录','旧记录','{}','{}')",
    );
  } finally {
    db.close();
  }
  try {
    assert.throws(() => new Database(path), /FOREIGN KEY/);
    const original = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(
        original.prepare("PRAGMA user_version").get()!.user_version,
        33,
      );
      assert.equal(
        original
          .prepare("SELECT type FROM sqlite_master WHERE name='traffic_items'")
          .get()!.type,
        "table",
      );
      assert.equal(
        original.prepare("SELECT count(*) n FROM traffic_items").get()!.n,
        1,
      );
    } finally {
      original.close();
    }
    const backups = (await readdir(folder)).filter((name) =>
      name.includes("before-v34"),
    );
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(folder, backups[0]), {
      readOnly: true,
    });
    try {
      assert.equal(
        backup.prepare("SELECT count(*) n FROM traffic_items").get()!.n,
        1,
      );
    } finally {
      backup.close();
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("100k observations list by current entries and index without ranking history", () => {
  const db = new Database(":memory:");
  try {
    db.run(
      "INSERT INTO traffic_queries(id,endpoint,phase,request,seeds,status,response) VALUES('scale','baidu-discovery','query','{}','[]','success','{}')",
    );
    const insert = db.db.prepare(
      "INSERT INTO traffic_items(id,query_id,kind,word,normalized_word,platform,source,metrics,data,observed_at) VALUES(?,'scale','word',?,?,'baidu','百度批量扩词','{\"averageMonthPv\":10}','{}',?)",
    );
    db.transaction(() => {
      for (let i = 0; i < 100000; i++) {
        const word = `教程词${i % 10000}`;
        insert.run(
          `scale_${i}`,
          word,
          word,
          `2026-11-${String(1 + Math.floor(i / 10000)).padStart(2, "0")}T00:00:00Z`,
        );
      }
    });
    const k = new TrafficKnowledge(db);
    const start = performance.now();
    assert.equal(k.list({}).total, 10000);
    const coldMs = performance.now() - start;
    const warm = performance.now();
    assert.equal(k.list({ page: 2 }).items.length, 50);
    const warmMs = performance.now() - warm;
    const sourceStart = performance.now();
    assert.equal(k.list({ endpoint: "baidu-discovery" }).total, 10000);
    const sourceMs = performance.now() - sourceStart;
    const searchedStart = performance.now();
    assert.equal(
      k.list({ endpoint: "baidu-discovery", search: "教程词99" }).total,
      111,
    );
    const searchedMs = performance.now() - searchedStart;
    const absentStart = performance.now();
    assert.equal(k.list({ endpoint: "radar" }).total, 0);
    const absentMs = performance.now() - absentStart;
    const sourcePlan = db
      .all<any>(
        `EXPLAIN QUERY PLAN SELECT e.id FROM traffic_entries e JOIN traffic_observations i ON i.seq=e.latest_observation_seq WHERE e.endpoint=? AND instr(e.normalized_word,?)>0 ORDER BY e.last_observed_at DESC,e.seq DESC LIMIT 50`,
        "baidu-discovery",
        "教程词99",
      )
      .map((row) => row.detail)
      .join("\n");
    assert.match(sourcePlan, /SEARCH e USING INDEX traffic_entries_source/);
    assert.doesNotMatch(sourcePlan, /SCAN i\b|CORRELATED|TEMP B-TREE/);
    const plan = db
      .all<any>(
        "EXPLAIN QUERY PLAN SELECT e.id,i.metrics FROM traffic_entries e JOIN traffic_observations i ON i.seq=e.latest_observation_seq ORDER BY e.last_observed_at DESC,e.seq DESC LIMIT 50",
      )
      .map((row) => row.detail)
      .join("\n");
    assert.match(plan, /traffic_entries_recent/);
    assert.doesNotMatch(plan, /TEMP B-TREE|SCAN i/);
    console.log(
      JSON.stringify({
        trafficScale: {
          observations: 100000,
          entries: 10000,
          coldListMs: Math.round(coldMs),
          warmPageMs: Math.round(warmMs),
          sourceMs: Math.round(sourceMs),
          sourceSearchMs: Math.round(searchedMs),
          absentSourceMs: Math.round(absentMs),
          plan,
          sourcePlan,
        },
      }),
    );
  } finally {
    db.close();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../core/database";
import { Repository } from "../core/repository";
import { TrafficKnowledge } from "../core/traffic-knowledge";
import {
  migrateTrafficKnowledge,
  packTrafficArchive,
} from "../core/traffic-knowledge-store";

async function legacyFixture() {
  const directory = await mkdtemp(join(tmpdir(), "panxu-traffic-v35-review-"));
  const path = join(directory, "panxu.db");
  const db = new Database(path);
  db.db.exec(`
    DROP VIEW traffic_items;
    DROP TRIGGER traffic_queries_revision_insert;
    DROP TRIGGER traffic_queries_revision_update;
    DROP TRIGGER traffic_queries_revision_delete;
    DROP TABLE traffic_knowledge_state;
    DROP TABLE traffic_observations;
    DROP TABLE traffic_entries;
    DROP INDEX traffic_queries_endpoint;
    ALTER TABLE traffic_queries DROP COLUMN item_count;
    ALTER TABLE traffic_queries DROP COLUMN legacy_items;
    CREATE TABLE traffic_items(id TEXT PRIMARY KEY,query_id TEXT NOT NULL REFERENCES traffic_queries(id),kind TEXT NOT NULL,word TEXT NOT NULL,normalized_word TEXT NOT NULL,platform TEXT,source TEXT NOT NULL,metrics TEXT NOT NULL,data TEXT NOT NULL,observed_at TEXT,source_updated_at TEXT);
    CREATE INDEX traffic_items_word ON traffic_items(normalized_word,platform,observed_at DESC);
    CREATE INDEX traffic_items_query ON traffic_items(query_id);
  `);
  db.transaction(() => {
    migrateTrafficKnowledge(db.db);
    db.db.exec("PRAGMA user_version=34");
  });
  return { directory, path, db };
}

function observe(
  db: Database,
  observationId: string,
  endpoint: string,
  source: string,
  word: string,
  date: string | null,
  monthly: number,
  kind = "word",
) {
  const queryId = `query_${observationId}`;
  db.run(
    "INSERT INTO traffic_queries(id,endpoint,phase,request,seeds,platform,status,response,received_at) VALUES(?,?,'query','{}','[\"原种子词\"]','baidu','success',?,?)",
    queryId,
    endpoint,
    packTrafficArchive(
      JSON.stringify({ evidence: `原始证据${observationId}`.repeat(100) }),
    ),
    date,
  );
  db.run(
    "INSERT INTO traffic_items(id,query_id,kind,word,normalized_word,platform,source,metrics,observed_at,source_updated_at) VALUES(?,?,?,?,?,'baidu',?,?,?,?)",
    observationId,
    queryId,
    kind,
    word,
    word.normalize("NFKC").trim().toLowerCase(),
    source,
    JSON.stringify({ averageMonthPv: monthly, original: observationId }),
    date,
    `原时间-${observationId}`,
  );
}

const observationProjection =
  "SELECT seq,id,query_id,endpoint,word,metrics,observed_at,source_updated_at FROM traffic_observations ORDER BY seq";

test("v35 splits mixed source histories without changing observation bytes, single-source IDs, query archives or frozen pools", async () => {
  const f = await legacyFixture();
  let db: Database | null = f.db;
  try {
    observe(
      db,
      "single_old",
      "baidu-discovery",
      "百度批量扩词",
      "单来源教程",
      null,
      10,
    );
    observe(
      db,
      "single_new",
      "baidu-discovery",
      "百度批量扩词",
      "单来源教程",
      "2026-11-03",
      10,
    );
    observe(
      db,
      "mixed_bd_old",
      "baidu-discovery",
      "同名自定义来源",
      "ＡＩ教程",
      null,
      10,
    );
    observe(
      db,
      "mixed_bd_new",
      "baidu-discovery",
      "同名自定义来源",
      "AI教程",
      "2026-11-01",
      25,
    );
    observe(
      db,
      "mixed_tail_old",
      "longtail",
      "同名自定义来源",
      "AI教程",
      "2026-11-02",
      50,
    );
    observe(
      db,
      "mixed_tail_new",
      "longtail",
      "同名自定义来源",
      "AI教程",
      "2026-11-02",
      80,
    );
    observe(
      db,
      "other_custom",
      "longtail",
      "不同自定义来源",
      "AI教程",
      "2026-11-04",
      200,
    );
    observe(
      db,
      "hotspot",
      "longtail",
      "同名自定义来源",
      "AI教程",
      "2026-11-05",
      300,
      "hotspot",
    );
    const observations = db.all<any>(observationProjection);
    const queries = db.all<any>("SELECT * FROM traffic_queries ORDER BY id");
    const single = db.get<any>(
      "SELECT rowid seq,* FROM traffic_entries WHERE id='entry_single_old'",
    )!;
    const mixed = db.get<any>(
      "SELECT rowid seq,* FROM traffic_entries WHERE id='entry_mixed_bd_old'",
    )!;
    const frozen = JSON.stringify([
      { id: "manual-id", word: "手工词", metrics: {} },
      { id: "mixed_bd_new", word: "AI教程", metrics: { averageMonthPv: 25 } },
    ]);
    db.run(
      "INSERT INTO pools(id,name,resource_id,keywords,created_at) VALUES('frozen_pool','冻结词池',NULL,?,'2026-11-07')",
      frozen,
    );
    db.close();
    db = new Database(f.path);
    assert.deepEqual(db.all(observationProjection), observations);
    assert.deepEqual(
      db.all("SELECT * FROM traffic_queries ORDER BY id"),
      queries,
    );
    assert.equal(
      db.get<any>("SELECT seq FROM traffic_entries WHERE id=?", single.id)?.seq,
      single.seq,
    );
    assert.equal(
      db.get<any>("SELECT endpoint FROM traffic_entries WHERE id=?", mixed.id)
        ?.endpoint,
      "longtail",
    );
    const knowledge = new TrafficKnowledge(db);
    const baidu = knowledge.list({
      search: "AI教程",
      endpoint: "baidu-discovery",
    }).items[0];
    const tail = knowledge.list({
      search: "AI教程",
      endpoint: "longtail",
      kind: "word",
    }).items;
    assert.notEqual(baidu.entryId, mixed.id);
    assert.equal(baidu.id, "mixed_bd_new");
    assert.equal(baidu.metrics.averageMonthPv, 25);
    assert.equal(baidu.observations, 2);
    const mixedTail = tail.find((item) => item.source === "同名自定义来源")!;
    assert.equal(mixedTail.entryId, mixed.id);
    assert.equal(mixedTail.id, "mixed_tail_new");
    assert.equal(mixedTail.metrics.averageMonthPv, 80);
    assert.equal(mixedTail.observations, 2);
    assert.equal(tail.length, 2);
    assert.equal(knowledge.list({ kind: "longtail" }).total, 4);
    assert.deepEqual(
      knowledge
        .history({ entryId: baidu.entryId })
        .items.map((item) => item.id),
      ["mixed_bd_new", "mixed_bd_old"],
    );
    assert.deepEqual(
      knowledge
        .resolve({
          observationIds: ["mixed_bd_old", "mixed_tail_new", "single_old"],
        })
        .items.map((item) => item.entryId),
      [baidu.entryId, mixed.id, single.id],
    );
    assert.equal(
      db.get<any>("SELECT keywords FROM pools WHERE id='frozen_pool'")
        ?.keywords,
      frozen,
    );
    assert.deepEqual(
      new Repository(db).getPool("frozen_pool")?.keywords,
      JSON.parse(frozen),
    );
    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
    const backups = (await readdir(f.directory)).filter((name) =>
      name.includes("before-v35-"),
    );
    assert.equal(backups.length, 1);
    assert.equal(
      (await stat(join(f.directory, backups[0]))).mode & 0o777,
      0o600,
    );
    const backup = new DatabaseSync(join(f.directory, backups[0]), {
      readOnly: true,
    });
    try {
      assert.equal(
        backup.prepare("PRAGMA user_version").get()?.user_version,
        34,
      );
      assert.deepEqual(
        backup.prepare(observationProjection).all(),
        observations,
      );
      assert.equal(
        backup
          .prepare("SELECT keywords FROM pools WHERE id='frozen_pool'")
          .get()?.keywords,
        frozen,
      );
    } finally {
      backup.close();
    }
    db.close();
    db = new Database(f.path);
    assert.equal(
      (await readdir(f.directory)).filter((name) =>
        name.includes("before-v35-"),
      ).length,
      1,
    );
    assert.equal(
      new TrafficKnowledge(db).list({
        search: "AI教程",
        endpoint: "baidu-discovery",
      }).items[0].entryId,
      baidu.entryId,
    );
  } finally {
    db?.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("v35 failed migration rolls back the original v34 schema and retains its readable backup", async () => {
  const f = await legacyFixture();
  try {
    observe(
      f.db,
      "orphan_query",
      "longtail",
      "5118 长尾词 v2",
      "原始记录",
      "2026-11-01",
      10,
    );
    f.db.db.exec("PRAGMA foreign_keys=OFF");
    f.db.run(
      "UPDATE traffic_observations SET query_id='absent-query' WHERE id='orphan_query'",
    );
    f.db.close();
    assert.throws(() => new Database(f.path), /FOREIGN KEY/);
    const original = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.equal(
        original.prepare("PRAGMA user_version").get()?.user_version,
        34,
      );
      assert.equal(
        original.prepare("SELECT count(*) n FROM traffic_observations").get()
          ?.n,
        1,
      );
      assert.equal(
        original
          .prepare("SELECT latest_observation_id FROM traffic_entries")
          .get()?.latest_observation_id,
        "orphan_query",
      );
      assert.equal(
        original
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='traffic_entries_v34'",
          )
          .get(),
        undefined,
      );
    } finally {
      original.close();
    }
    const backups = (await readdir(f.directory)).filter((name) =>
      name.includes("before-v35-"),
    );
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(f.directory, backups[0]), {
      readOnly: true,
    });
    try {
      assert.equal(
        backup.prepare("PRAGMA user_version").get()?.user_version,
        34,
      );
      assert.equal(
        backup.prepare("SELECT query_id FROM traffic_observations").get()
          ?.query_id,
        "absent-query",
      );
    } finally {
      backup.close();
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("v35 refuses orphan entry references instead of silently dropping an original observation", async () => {
  const f = await legacyFixture();
  try {
    observe(
      f.db,
      "orphan_entry",
      "longtail",
      "5118 长尾词 v2",
      "不可丢弃的原始记录",
      "2026-11-01",
      10,
    );
    f.db.db.exec("PRAGMA foreign_keys=OFF");
    f.db.run(
      "UPDATE traffic_observations SET entry_id='absent-entry' WHERE id='orphan_entry'",
    );
    f.db.close();
    let upgraded: Database | undefined;
    try {
      assert.throws(() => {
        upgraded = new Database(f.path);
      }, /FOREIGN KEY|观察|记录|完整/);
    } finally {
      upgraded?.close();
    }
    const original = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.equal(
        original.prepare("PRAGMA user_version").get()?.user_version,
        34,
      );
      assert.equal(
        original.prepare("SELECT id FROM traffic_observations").get()?.id,
        "orphan_entry",
      );
    } finally {
      original.close();
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

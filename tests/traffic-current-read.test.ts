import test from "node:test";
import assert from "node:assert/strict";
import { Database } from "../core/database";
import { TrafficKnowledge } from "../core/traffic-knowledge";

function insert(db: Database, i: number, monthly: number | null = null) {
  db.run(
    "INSERT INTO traffic_queries(id,endpoint,phase,request,seeds,status,response,received_at) VALUES(?,'longtail','query','{}','[\"起词\"]','success','{}','2026-11-07')",
    `q${i}`,
  );
  db.run(
    "INSERT INTO traffic_items(id,query_id,kind,word,normalized_word,source,metrics,observed_at) VALUES(?,?,'word',?,?,'5118 长尾词 v2',?,'2026-11-07')",
    `o${i}`,
    `q${i}`,
    `教程${String(i).padStart(3, "0")}`,
    `教程${String(i).padStart(3, "0")}`,
    JSON.stringify(monthly === null ? {} : { averageMonthPv: monthly }),
  );
}

test("cursor pages preserve tied recent, monthly including unknown, and word order without duplicates", () => {
  const db = new Database(":memory:");
  try {
    db.transaction(() => {
      for (let i = 0; i < 133; i++) insert(db, i, i % 3 === 0 ? null : i % 4);
    });
    const k = new TrafficKnowledge(db);
    for (const sort of ["recent", "monthly", "word"] as const) {
      const ids: string[] = [];
      let cursor: string | null = null;
      let reads = 0;
      do {
        const page = k.list({ sort, kind: "longtail", cursor });
        assert.equal(page.total, 133);
        assert.equal(page.summary, undefined);
        assert.equal(page.seeds, undefined);
        assert.equal(page.patterns, undefined);
        ids.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
        reads++;
        assert.ok(reads <= 3);
      } while (cursor);
      const numeric = [1, 2, 3].flatMap((page) =>
        k.list({ sort, kind: "longtail", page }).items.map((item) => item.id),
      );
      assert.equal(ids.length, 133);
      assert.equal(new Set(ids).size, 133);
      assert.deepEqual(ids, numeric, sort);
    }
    const first = k.list({ cursor: null });
    assert.ok(first.nextCursor);
    assert.throws(() => k.list({ cursor: first.nextCursor, sort: "word" }), {
      code: "INVALID_CURSOR",
    });
    assert.throws(() => k.list({ cursor: "invalid" }), {
      code: "INVALID_CURSOR",
    });
  } finally {
    db.close();
  }
});

test("traffic revision caches overview across unrelated writes and invalidates on contributing traffic changes", () => {
  const db = new Database(":memory:");
  try {
    const k = new TrafficKnowledge(db);
    const empty = k.overview();
    db.setSetting("traffic-read-test", { changed: true });
    assert.equal(k.overview(), empty);
    insert(db, 0, 10);
    const populated = k.overview();
    assert.notEqual(populated, empty);
    assert.equal(populated.summary.observations, 1);
    assert.equal(populated.seeds[0].queries, 1);
    db.setSetting("unrelated-log-state", 2);
    assert.equal(k.overview(), populated);
    db.run("UPDATE traffic_queries SET phase='poll' WHERE id='q0'");
    const polled = k.overview();
    assert.notEqual(polled, populated);
    assert.equal(polled.summary.observations, 1);
    assert.equal(polled.seeds.length, 0);
    db.run("UPDATE traffic_queries SET message='结果已整理' WHERE id='q0'");
    assert.equal(k.overview(), polled);
    db.run("DELETE FROM traffic_items WHERE id='o0'");
    assert.equal(k.overview().summary.observations, 0);
  } finally {
    db.close();
  }
});

test("observation resolution keeps frozen metrics and input order while recovering current source entry identity", () => {
  const db = new Database(":memory:");
  try {
    const k = new TrafficKnowledge(db);
    insert(db, 1, 10);
    db.run(
      "INSERT INTO traffic_items(id,query_id,kind,word,normalized_word,source,metrics,observed_at) VALUES('new','q1','word','教程001','教程001','5118 长尾词 v2','{\"averageMonthPv\":200}','2026-11-08')",
    );
    const current = k.list({}).items[0];
    const result = k.resolve({
      observationIds: ["missing", "o1", "new", "o1"],
    });
    assert.deepEqual(result.missingIds, ["missing"]);
    assert.deepEqual(
      result.items.map((item) => item.id),
      ["o1", "new"],
    );
    assert.equal(result.items[0].metrics.averageMonthPv, 10);
    assert.equal(result.items[1].metrics.averageMonthPv, 200);
    assert.ok(result.items.every((item) => item.entryId === current.entryId));
    assert.equal(result.items[0].observedAt, "2026-11-07");
    assert.deepEqual(k.resolve({ observationIds: [] }), {
      items: [],
      missingIds: [],
    });
    assert.throws(() => k.resolve({ observationIds: Array(1001).fill("o1") }));
  } finally {
    db.close();
  }
});

test("explicit stable feed keys tolerate display-label changes while compatibility custom sources stay distinct", () => {
  const db = new Database(":memory:");
  try {
    insert(db, 0, 10);
    const k = new TrafficKnowledge(db);
    const original = k.list({}).items[0];
    db.run(
      "INSERT INTO traffic_items(id,query_id,kind,word,normalized_word,source,source_key,metrics,observed_at) VALUES('renamed','q0','word','教程000','教程000','长尾词新版显示名','longtail','{}','2026-11-08')",
    );
    const renamed = k.list({}).items[0];
    assert.equal(renamed.entryId, original.entryId);
    assert.equal(renamed.observations, 2);
    assert.equal(renamed.source, "长尾词新版显示名");
    for (const source of ["人工导入A", "人工导入B"]) {
      db.run(
        "INSERT INTO traffic_items(id,query_id,kind,word,normalized_word,source,metrics,observed_at) VALUES(?, 'q0','word','教程000','教程000',?,'{}','2026-11-09')",
        source,
        source,
      );
    }
    assert.equal(k.list({}).total, 3);
    assert.equal(
      new Set(k.list({}).items.map((item) => item.sourceKey)).size,
      3,
    );
  } finally {
    db.close();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { Database } from "../core/database";
import { Repository } from "../core/repository";
import { queryMethods } from "../shared/ipc";
import type { Keyword, Pool, PoolSummary } from "../shared/types";
import { fixture } from "./helpers";

function keyword(index: number): Keyword {
  return {
    id: `provider-keyword-${index}`,
    word: `完整关键词 ${index}`,
    source: "手工、AI与供应商来源均保留原始ID",
    platform: "baidu",
    metrics: { averageMonthPv: 10, detail: "冻结指标".repeat(40) },
    sourceUpdatedAt: null,
    fetchedAt: "2026-11-07T00:00:00.000Z",
    intent: "选择后用于内容复用",
  };
}

test("app snapshots contain bounded pool summaries while single-pool reads preserve complete frozen keywords", () => {
  const db = new Database(":memory:");
  const repo = new Repository(db);
  try {
    const keywords = Array.from({ length: 1000 }, (_, index) => keyword(index));
    const serialized = JSON.stringify(keywords);
    for (let index = 0; index < 24; index++) {
      db.run(
        "INSERT INTO pools(id,name,resource_id,keywords,created_at) VALUES(?,?,NULL,?,?)",
        `pool-${String(index).padStart(2, "0")}`,
        `词池 ${index}`,
        serialized,
        "2026-11-07T00:00:00.000Z",
      );
    }
    const summaries = repo.snapshot(() => false, ":memory:").pools;
    assert.equal(summaries.length, 24);
    assert.ok(summaries.every((pool) => pool.keywordCount === 1000));
    assert.ok(summaries.every((pool) => pool.preview.length === 5));
    assert.deepEqual(
      summaries[0].preview,
      keywords.slice(0, 5).map(({ id, word }) => ({ id, word })),
    );
    assert.deepEqual(
      summaries.map((pool) => pool.id),
      [...summaries.map((pool) => pool.id)].sort(),
    );
    assert.ok(summaries.every((pool) => !("keywords" in pool)));
    assert.doesNotMatch(
      JSON.stringify(summaries),
      /冻结指标|metrics|fetchedAt/,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(summaries)) < 20_000);
    assert.deepEqual(repo.poolSummaries(), summaries);
    assert.deepEqual(repo.getPool("pool-00")?.keywords, keywords);
    assert.equal(repo.getPool("missing"), undefined);
    assert.equal(
      db.get<{ keywords: string }>(
        "SELECT keywords FROM pools WHERE id='pool-00'",
      )?.keywords,
      serialized,
    );
  } finally {
    db.close();
  }
});

test("pool summaries safely handle legacy malformed JSON without loading metric payloads", () => {
  const db = new Database(":memory:");
  const repo = new Repository(db);
  try {
    for (const [id, words] of [
      ["invalid", "{broken"],
      ["object", '{"word":"不是数组"}'],
      ["null", "null"],
      ["empty", "[]"],
      [
        "mixed",
        '[null,"旧版文本",7,{"id":"valid","word":"有效词","metrics":{"large":"不得进入预览"}},{"id":8,"word":"无效ID"}]',
      ],
    ]) {
      db.run(
        "INSERT INTO pools(id,name,resource_id,keywords,created_at) VALUES(?,?,NULL,?,'2026-11-07')",
        id,
        id,
        words,
      );
    }
    const summaries = repo.poolSummaries();
    assert.equal(summaries.length, 5);
    for (const id of ["invalid", "object", "null", "empty"]) {
      assert.equal(summaries.find((pool) => pool.id === id)?.keywordCount, 0);
      assert.deepEqual(summaries.find((pool) => pool.id === id)?.preview, []);
    }
    assert.equal(
      summaries.find((pool) => pool.id === "mixed")?.keywordCount,
      5,
    );
    assert.deepEqual(summaries.find((pool) => pool.id === "mixed")?.preview, [
      { id: "valid", word: "有效词" },
    ]);
  } finally {
    db.close();
  }
});

test("pool list/get are local read queries and preserve manually saved words for search import", async () => {
  const f = await fixture();
  try {
    f.app.repo.pools = () => {
      throw new Error("A by-ID pool operation must not read every pool.");
    };
    assert.ok(queryMethods.includes("pool.get"));
    assert.ok(queryMethods.includes("pool.list"));
    const saved = (await f.app.invoke("pool.manual", {
      name: "用于跨平台复用的词池",
      resourceId: null,
      words: Array.from(
        { length: 8 },
        (_, index) => `手工复用词 ${index}`,
      ).join("\n"),
    })) as Pool;
    const pools = (await f.app.invoke("pool.list")) as PoolSummary[];
    assert.equal(pools.length, 1);
    assert.equal(pools[0].keywordCount, 8);
    assert.equal(pools[0].preview.length, 5);
    assert.equal("keywords" in pools[0], false);
    const detail = (await f.app.invoke("pool.get", { id: saved.id })) as Pool;
    assert.deepEqual(detail, saved);
    const imported = (await f.app.invoke("search.importPool", {
      poolId: detail.id,
      keywordIds: [detail.keywords[7].id],
      platform: "csdn",
    })) as { created: number };
    assert.equal(imported.created, 1);
    assert.equal(
      f.app.search.list({ query: "手工复用词 7" }).items[0].keywordId,
      detail.keywords[7].id,
    );
    assert.equal(f.app.repo.calls().length, 0);
    assert.equal(
      f.app.db.get<{ count: number }>(
        "SELECT COUNT(*) count FROM traffic_observations",
      )?.count,
      0,
    );
    await assert.rejects(f.app.invoke("pool.get", { id: "missing" }), {
      code: "NOT_FOUND",
    });
    await assert.rejects(f.app.invoke("pool.get", { id: "" }));
  } finally {
    await f.cleanup();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { lookupResourceKeywordBatch } from "../core/resource-keywords";
import type { KeywordBatch } from "../shared/resource-keywords";
import { fixture } from "./helpers";

test("批量拓词三路来源重叠工作，同一浏览器串行；相同搜索词只查一次且各资源结果独立", async () => {
  const batch: KeywordBatch = {
    id: randomUUID(),
    status: "running",
    items: ["表格", "预算", "表格"].map((seed, i) => ({
      id: randomUUID(),
      title: `资源${i}`,
      seeds: [seed],
      status: "pending",
    })),
  };
  const running = new Map<string, number>(),
    counts = new Map<string, number>();
  let peak = 0,
    total = 0;
  const read = async (channel: string, source: string, seed: string) => {
    assert.equal(running.get(channel) || 0, 0, "共享来源不能交叉导航");
    running.set(channel, 1);
    total++;
    peak = Math.max(peak, total);
    counts.set(`${source}:${seed}`, (counts.get(`${source}:${seed}`) || 0) + 1);
    await delay(5);
    running.set(channel, 0);
    total--;
    return [`${seed}${source}词`];
  };
  const progress: number[] = [];
  await lookupResourceKeywordBatch(
    batch,
    {
      baiduDiscovery: {
        read: (_source, seed) => read("baidu", "suggest", seed),
        readSearchWords: async (seed) => ({
          related: await read("baidu", "related", seed),
          people: [],
        }),
        open: async () => {},
        close: () => {},
        isOpen: () => false,
      },
      read5118PublicKeywords: (seed) => read("5118", "5118", seed),
    },
    (words) => read("marketing", "marketing", words[0]),
    () =>
      progress.push(
        batch.items.filter((item) => item.status === "completed").length,
      ),
  );
  assert.equal(batch.status, "completed");
  assert.ok(peak >= 2);
  for (const count of counts.values()) assert.equal(count, 1);
  assert.ok(progress.includes(1));
  for (const item of batch.items) {
    assert.equal(item.status, "completed");
    assert.ok(item.result!.candidates.length);
    assert.ok(
      item.result!.candidates.every((word) =>
        word.word.startsWith(item.seeds[0]),
      ),
    );
  }
});
test("来源失败不丢其他来源结果，已完成结果可在查询期间读取，旧任务中断可恢复查看", async () => {
  const f = await fixture();
  let resolve!: (words: string[]) => void;
  const gate = {
    promise: new Promise<string[]>((done) => {
      resolve = done;
    }),
    resolve: (words: string[]) => resolve(words),
  };
  let entered = false;
  f.ports.read5118PublicKeywords = async () => {
    entered = true;
    return gate.promise;
  };
  try {
    const id = randomUUID(),
      resourceId = randomUUID();
    const pending = f.app.invoke("resource.keywordBatch", {
      id,
      items: [{ id: resourceId, title: "表格资源", seeds: ["表格"] }],
    }) as Promise<KeywordBatch>;
    while (!entered) await delay(1);
    const status = (await f.app.invoke("resource.keywordBatchStatus", {
      id,
    })) as KeywordBatch;
    assert.equal(status.status, "running");
    assert.equal(status.items[0].status, "running");
    await assert.rejects(
      () => f.app.invoke("resource.keywordLookup", { seeds: ["其他"] }),
      /已有流量词检索/,
    );
    gate.resolve(["表格清单"]);
    const result = await pending;
    assert.equal(result.items[0].result!.candidates[0].word, "表格清单");
    assert.ok(
      result.items[0].result!.issues.length,
      "不可用百度来源应有提示，不丢5118结果",
    );
    const saved = (await f.app.invoke("resource.keywordBatchStatus", {
      id,
    })) as KeywordBatch;
    assert.equal(saved.status, "completed");
    const oldId = randomUUID();
    f.app.db.setSetting(`resource-keyword-batch:${oldId}`, {
      ...saved,
      id: oldId,
      status: "running",
    });
    assert.equal(
      (
        (await f.app.invoke("resource.keywordBatchStatus", {
          id: oldId,
        })) as KeywordBatch
      ).status,
      "interrupted",
    );
  } finally {
    gate.resolve([]);
    await f.cleanup();
  }
});

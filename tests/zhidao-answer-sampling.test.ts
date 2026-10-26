import test from "node:test";
import assert from "node:assert/strict";
import { sampledQuestions } from "../core/zhidao/workers/answer-questions";
import type { ZhidaoQuestionPage } from "../core/zhidao/client";

function seededRandom() {
  let seed = 23;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

test("自动答题先汇总多页再抽题，随机跳页不重复且遵守题库边界", async () => {
  const loaded: number[] = [];
  const source = sampledQuestions(async (base) => {
    loaded.push(base);
    return {
      items: Array.from({ length: 8 }, (_, i) => ({
        qid: `q-${base + i}`,
        question: `问题${base + i}`,
      })),
      nextBase: base + 8,
      hasMore: true,
      total: 1600,
    };
  }, seededRandom());
  const first = await source.next();
  assert.equal(first.done, false);
  assert.ok(loaded.length >= 3 && loaded.length <= 5);
  assert.equal(new Set(loaded).size, loaded.length);
  assert.ok(loaded.every((base) => base >= 0 && base < 1600 && base % 8 === 0));
  assert.ok(
    loaded.some((base, i) => i > 0 && Math.abs(base - loaded[i - 1]) > 8),
  );
  const batch = [first.value!.qid];
  for (let i = 1; i < loaded.length * 8; i++)
    batch.push((await source.next()).value!.qid);
  assert.notDeepEqual(
    batch,
    loaded.flatMap((base) =>
      Array.from({ length: 8 }, (_, i) => `q-${base + i}`),
    ),
  );
  assert.equal(new Set(batch).size, batch.length);
  await source.return(undefined);
  assert.equal(loaded.length * 8, batch.length);
});

test("小题库只读取有效页，同页和跨页重复题只进入候选一次", async () => {
  const loaded: number[] = [];
  const result = [];
  for await (const q of sampledQuestions(async (base) => {
    loaded.push(base);
    return {
      items: [
        { qid: "duplicate", question: "重复问题" },
        { qid: `q-${base}`, question: "问题" },
      ],
      nextBase: base + 8,
      hasMore: base < 16,
      total: 17,
    };
  }, seededRandom()))
    result.push(q.qid);
  assert.deepEqual(new Set(loaded), new Set([0, 8, 16]));
  assert.equal(result.filter((id) => id === "duplicate").length, 1);
  assert.equal(result.length, 4);
});

test("缺少总量时先翻多页再打乱，失效或循环游标正常结束", async () => {
  for (const end of [NaN, -1, 16]) {
    const loaded: number[] = [];
    const result = [];
    for await (const q of sampledQuestions(
      async (base): Promise<ZhidaoQuestionPage> => {
        loaded.push(base);
        return {
          items: [{ qid: `q-${base}`, question: "问题" }],
          nextBase: base < 16 ? base + 8 : end,
          hasMore: true,
        };
      },
      seededRandom(),
    ))
      result.push(q.qid);
    assert.deepEqual(loaded, [0, 8, 16]);
    assert.equal(result.length, 3);
  }
});

test("大量空页的随机读取有上限，不会无限翻页", async () => {
  const loaded: number[] = [];
  for await (const _ of sampledQuestions(async (base) => {
    loaded.push(base);
    return { items: [], nextBase: base + 8, hasMore: true, total: 1_000_000 };
  }, seededRandom()))
    assert.fail("空页不应产生题目");
  assert.equal(loaded.length, 50);
  assert.equal(new Set(loaded).size, 50);
});

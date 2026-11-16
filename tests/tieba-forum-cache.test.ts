import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { Database } from "../core/database";
import { TiebaForumCache } from "../core/tieba/forum-cache";
import type { TiebaAnalysisForumPage } from "../shared/tieba-analysis";

const now = Date.parse("2026-11-13T13:00:00Z");
const date = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
const post = (id: string, views: number | null, hours: number) => ({
  id,
  title: id,
  forum: "网盘资源",
  author: "作者",
  publishedAt: date(hours),
  repliedAt: date(hours / 2),
  views,
  replies: 0,
  shares: null,
  likes: null,
  url: `https://tieba.baidu.com/p/${id}`,
});
const threads = {
  published: [
    Array.from({ length: 10 }, (_, i) => post(String(100 + i), i + 1, 48)),
    [post("110", 300, 200)],
  ],
  replied: [[post("110", null, 200), post("111", 200, 2)]],
};
const result = (
  name: string,
  page: number,
  list: "published" | "replied" | "featured" = "published",
): TiebaAnalysisForumPage => {
  const pages = list === "featured" ? [] : threads[list];
  return {
    name,
    id: "123",
    url: "https://tieba.baidu.com/f?kw=资源",
    page,
    hasMore: page < pages.length,
    threads: pages[page - 1] ?? [],
  };
};
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await wait(5);
  }
  assert.fail("读取状态未在期限内更新");
}

test("整吧缓存逐页写入，暂停可接续，两个公开列表合并后全局排序", async () => {
  const db = new Database(":memory:");
  const calls: string[] = [];
  let pause = true;
  const cache = new TiebaForumCache(
    db,
    () => {},
    async ({ name, page, list }) => {
      calls.push(`${list}:${page}`);
      return result(name, page, list);
    },
    async (signal) => {
      if (pause) await wait(1000, undefined, { signal });
    },
    () => now,
  );
  try {
    cache.control("网盘资源", "start");
    await until(() => cache.page("网盘资源", 1, "views").total === 10);
    cache.control("网盘资源", "pause");
    assert.equal(cache.page("网盘资源", 1, "views").status, "paused");
    pause = false;
    cache.control("网盘资源", "start");
    await until(() => cache.page("网盘资源", 1, "views").status === "complete");
    assert.deepEqual(calls, ["published:1", "published:2", "replied:1"]);
    const saved = cache.page("网盘资源", 1, "views");
    assert.equal(saved.total, 12);
    assert.deepEqual(
      saved.threads.slice(0, 2).map(({ id, views }) => [id, views]),
      [
        ["110", 300],
        ["111", 200],
      ],
    );
    assert.equal(saved.threads[0].shares, null);
    assert.equal(cache.page("网盘资源", 1, "exposure").threads[0].id, "111");
    assert.equal(cache.page("网盘资源", 1, "replied").threads[0].id, "111");
    assert.equal(cache.page("网盘资源", 2, "views").threads.length, 2);
    const reopened = new TiebaForumCache(db, () => {});
    assert.equal(reopened.page("网盘资源", 1, "views").total, 12);
    assert.equal(reopened.page("网盘资源", 1, "views").status, "complete");
    reopened.dispose();
  } finally {
    cache.dispose();
    db.close();
  }
});

test("重复页暂停并保留断点，重试后可以完成", async () => {
  const db = new Database(":memory:");
  let repeat = true;
  const cache = new TiebaForumCache(
    db,
    () => {},
    async ({ name, page, list }) => {
      if (page === 2 && repeat) return { ...result(name, 1, list), page: 2 };
      return result(name, page, list);
    },
    async () => {},
  );
  try {
    cache.control("网盘资源", "start");
    await until(() => cache.page("网盘资源", 1, "views").status === "error");
    const failed = cache.page("网盘资源", 1, "views");
    assert.equal(failed.total, 10);
    assert.equal(failed.scannedPages, 1);
    repeat = false;
    cache.control("网盘资源", "start");
    await until(() => cache.page("网盘资源", 1, "views").status === "complete");
    assert.equal(cache.page("网盘资源", 1, "views").total, 12);
  } finally {
    cache.dispose();
    db.close();
  }
});

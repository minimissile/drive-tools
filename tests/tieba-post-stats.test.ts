import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../core/database";
import { TiebaPostStats } from "../core/tieba-post-stats/service";
import { tiebaBodyDriveLinks } from "../core/tieba-post-stats/links";
import type { WebsiteAccounts } from "../core/website-accounts";
import type { BrowserEnvironments } from "../core/browser-environments";
import type { BrowserEnvironmentQueue } from "../core/browser-environment-queue";
import type { TiebaPostStatsReading } from "../shared/tieba-post-stats";
import type { TiebaPublicationRef } from "../shared/tieba-insights";

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "tieba-post-stats-"));
  const db = new Database(join(folder, "data.db"));
  const account = {
    id: "web_stats",
    provider: "tieba" as const,
    uid: "111",
    alias: "测试",
    status: "connected" as const,
    createdAt: "",
    updatedAt: "",
  };
  db.run(
    "INSERT INTO website_accounts(id,provider,alias,uid,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    account.id,
    account.provider,
    account.alias,
    account.uid,
    account.status,
    "",
    "",
  );
  let time = Date.parse("2026-11-07T03:00:00Z"),
    count = 0,
    failure: Error | null = null;
  let during: (() => void) | undefined;
  const stamp = { revision: 1 };
  let list = { threadIds: ["1000"], nextPage: null as number | null };
  let reading: TiebaPostStatsReading = {
    threadId: "1000",
    uid: "111",
    forumId: "100",
    forumName: "办公技巧",
    title: "办公资料整理",
    url: "https://tieba.baidu.com/p/1000",
    links: ["https://pan.baidu.com/s/1abc"],
    views: 100,
    replies: 4,
    likes: null,
    checkedAt: "",
    message: "官网未提供获赞",
  };
  const publications: TiebaPublicationRef[] = [
    {
      id: "tiebapublishing_test",
      kind: "topic",
      accountId: account.id,
      uid: "111",
      forumId: "100",
      forumName: "办公技巧",
      title: reading.title,
      body: "本人整理的公开办公资料 https://pan.baidu.com/s/1abc",
      threadId: "1000",
      postId: "10001",
      url: reading.url,
      submittedAt: new Date(time).toISOString(),
      submissionStatus: "verified",
    },
  ];
  const dependencies = {
    db,
    accounts: {
      get: () => ({ ...account }),
      list: () => [{ ...account }],
      verify: async () => ({ ...account }),
    } as unknown as WebsiteAccounts,
    environments: {
      stamp: () => ({ ...stamp }),
      assertStamp: (_: unknown, original: typeof stamp) => {
        if (original.revision !== stamp.revision) throw new Error("环境变化");
      },
    } as unknown as BrowserEnvironments,
    queue: {
      schedule: async (
        _: unknown,
        _label: unknown,
        run: () => Promise<unknown>,
      ) => run(),
    } as unknown as BrowserEnvironmentQueue,
    browser: {
      listOwnThreads: async () => list,
      readThread: async () => {
        count++;
        during?.();
        if (failure) throw failure;
        return {
          ...structuredClone(reading),
          checkedAt: reading.checkedAt || new Date(time).toISOString(),
        };
      },
    },
    publications: () => publications,
    changed: () => {},
    clock: () => time,
  };
  const service = new TiebaPostStats(dependencies);
  return {
    db,
    service,
    account,
    stamp,
    publications,
    dependencies,
    get reads() {
      return count;
    },
    set reading(value: Partial<TiebaPostStatsReading>) {
      reading = { ...reading, ...value };
    },
    set list(value: typeof list) {
      list = value;
    },
    set failure(value: Error | null) {
      failure = value;
    },
    set during(value: (() => void) | undefined) {
      during = value;
    },
    advance() {
      time += 60000;
    },
    async close() {
      service.dispose();
      db.close();
      await rm(folder, { recursive: true, force: true });
    },
  };
}
test("网盘链接按现有分享解析白名单，域名提及/假host/外部凭据/正文外链接不作分享", () => {
  assert.deepEqual(
    tiebaBodyDriveLinks(
      "资料 https://pan.baidu.com/s/1abc?pwd=1234 以及 https://pan.quark.cn/s/def",
    ),
    ["https://pan.baidu.com/s/1abc", "https://pan.quark.cn/s/def"],
  );
  for (const text of [
    "pan.baidu.com",
    "https://pan.baidu.com.evil.invalid/s/abc",
    "https://pan.baidu.com@evil.invalid/s/abc",
    "https://evil@pan.baidu.com/s/abc",
    "https://pan.baidu.com/",
    "https://pan.baidu.com:8080/s/abc",
  ])
    assert.deepEqual(tiebaBodyDriveLinks(text), []);
  assert.deepEqual(
    tiebaBodyDriveLinks("点击资料", [
      'javascript:alert("https://pan.baidu.com/s/1abc")',
    ]),
    [],
  );
  assert.deepEqual(
    tiebaBodyDriveLinks("点击资料", ["https://drive.uc.cn/s/abc"]),
    ["https://drive.uc.cn/s/abc"],
  );
});
test("本地快照不访问官网；首次建立基线保持未知，第二次真实差值，下降不编负增长", async () => {
  const f = await fixture();
  try {
    assert.equal(f.service.snapshot().summary.views, null);
    assert.equal(f.reads, 0);
    const first = await f.service.refresh({ accountId: f.account.id });
    assert.equal(first.posts.length, 1);
    assert.equal(first.posts[0].deltaViews, null);
    assert.equal(first.summary.likes, null);
    f.advance();
    f.reading = { views: 130, replies: 6, likes: 3 };
    const next = await f.service.refresh({ accountId: f.account.id });
    assert.equal(next.summary.deltaViews, 30);
    assert.equal(next.posts[0].deltaReplies, 2);
    assert.equal(next.posts[0].deltaLikes, null);
    assert.equal(next.posts[0].history.length, 2);
    f.advance();
    f.reading = { views: 120 };
    assert.equal(
      (await f.service.refresh({ accountId: f.account.id })).posts[0]
        .deltaViews,
      null,
    );
  } finally {
    await f.close();
  }
});
test("官网读取失败不改旧数字与checkedAt；重启保留历史且不启动读取", async () => {
  const f = await fixture();
  try {
    const first = await f.service.importThread({
      accountId: f.account.id,
      url: "https://tieba.baidu.com/p/1000",
    });
    f.advance();
    f.failure = new Error("官网验证中");
    const failed = await f.service.refresh({ accountId: f.account.id });
    assert.deepEqual(failed.posts, first.posts);
    assert.equal(failed.refreshResult?.failed.length, 1);
    f.service.dispose();
    const restored = new TiebaPostStats(f.dependencies);
    assert.deepEqual(restored.snapshot().posts, first.posts);
    assert.equal(f.reads, 2);
    restored.dispose();
  } finally {
    await f.close();
  }
});
test("wrong UID、主题、未来时间、负值与非法分享回执不能污染记录", async () => {
  const f = await fixture();
  try {
    for (const patch of [
      { uid: "222" },
      { threadId: "2000" },
      { views: -1 },
      { views: 0.5 },
      { checkedAt: "2099-01-01T00:00:00Z" },
      { links: ["https://evil.invalid/s/a"] },
    ]) {
      f.reading = {
        uid: "111",
        threadId: "1000",
        views: 100,
        checkedAt: "",
        links: ["https://pan.baidu.com/s/1abc"],
        ...patch,
      };
      const result = await f.service.importThread({
        accountId: f.account.id,
        url: "https://tieba.baidu.com/p/1000",
      });
      assert.equal(result.posts.length, 0);
      assert.equal(result.refreshResult?.failed.length, 1);
    }
    assert.equal(f.service.snapshot().summary.lastRefreshedAt, null);
  } finally {
    await f.close();
  }
});
test("已有资源帖移除链接后不计入当前范围，原历史保留供恢复后比对", async () => {
  const f = await fixture();
  try {
    await f.service.importThread({
      accountId: f.account.id,
      url: "https://tieba.baidu.com/p/1000",
    });
    f.advance();
    f.reading = { links: [] };
    const removed = await f.service.refresh({ accountId: f.account.id });
    assert.equal(removed.posts.length, 0);
    assert.equal(removed.refreshResult?.excluded.length, 1);
    f.advance();
    f.reading = { links: ["https://pan.baidu.com/s/1abc"], views: 110 };
    const restored = await f.service.importThread({
      accountId: f.account.id,
      url: "https://tieba.baidu.com/p/1000",
    });
    assert.equal(restored.posts[0].history.length, 3);
  } finally {
    await f.close();
  }
});
test("扫描使用本人列表分页，非范围帖子不纳入，空页明确空结果", async () => {
  const f = await fixture();
  try {
    f.list = { threadIds: ["1000"], nextPage: 2 };
    let result = await f.service.discover({ accountId: f.account.id });
    assert.equal(result.discoveryResult?.nextPage, 2);
    assert.equal(result.posts.length, 1);
    f.list = { threadIds: [], nextPage: null };
    result = await f.service.discover({ accountId: f.account.id, page: 2 });
    assert.equal(result.discoveryResult?.found, 0);
    assert.equal(result.posts.length, 1);
    f.list = { threadIds: [], nextPage: 99 };
    await assert.rejects(
      f.service.discover({ accountId: f.account.id }),
      /分页/,
    );
  } finally {
    await f.close();
  }
});
test("账号或环境在读取途中变化以及退出后不保存；未知主题不能用刷新接口偷换范围", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.service.refresh({ accountId: f.account.id, threadIds: ["9999"] }),
      /扫描或导入/,
    );
    assert.equal(f.reads, 0);
    f.during = () => {
      f.stamp.revision++;
    };
    const changed = await f.service.refresh({ accountId: f.account.id });
    assert.equal(changed.posts.length, 0);
    assert.equal(changed.refreshResult?.failed.length, 1);
    f.during = () => {
      f.service.dispose();
    };
    await assert.rejects(
      f.service.refresh({ accountId: f.account.id }),
      /已停止/,
    );
  } finally {
    await f.close();
  }
});
test("超过20帖不静默截断刷新；显式批次不会扩大目标", async () => {
  const f = await fixture();
  try {
    const original = f.publications[0];
    for (let n = 1; n <= 20; n++)
      f.publications.push({
        ...original,
        id: `extra${n}`,
        threadId: String(1000 + n),
      });
    await assert.rejects(
      f.service.refresh({ accountId: f.account.id }),
      /超过20/,
    );
    assert.equal(f.reads, 0);
    const result = await f.service.refresh({
      accountId: f.account.id,
      threadIds: ["1000"],
    });
    assert.equal(result.posts.length, 1);
    assert.equal(f.reads, 1);
  } finally {
    await f.close();
  }
});

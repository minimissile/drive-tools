import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Database } from "../core/database";
import {
  TiebaResourceDiscovery,
  type TiebaDiscoveryReaders,
} from "../core/tieba-resource-discovery/service";
import {
  discoveryInterval,
  potentialSignals,
  resourceEvidence,
  observeViews,
} from "../core/tieba-resource-discovery/rules";

test("资源信号区分分享与求资源，空值、计数回落不产生增长", () => {
  assert.equal(
    resourceEvidence("求一份百度网盘资源", "https://pan.baidu.com/s/abcde", []),
    undefined,
  );
  assert.equal(resourceEvidence("这里讨论网盘限速", "", []), undefined);
  assert.equal(resourceEvidence("资料合集 百度网盘", "", [])?.linked, false);
  assert.equal(
    resourceEvidence("资料合集", "https://pan.baidu.com/s/abcde", [])?.linked,
    true,
  );
  const at = Date.parse("2026-11-12T01:00:00Z");
  const base = { baseline: { at, views: 35 }, growth: null, streak: 1 };
  assert.equal(observeViews(base, at + 3600000, 12).growth, null);
  assert.equal(observeViews(base, at + 3600000, null).baseline, null);
  assert.equal(observeViews(base, at + 300000, 45), base);
});

test("两轮扫描走完种子到作者再到新贴吧的路径，并用两次读数识别上涨", async () => {
  const db = new Database(":memory:");
  const start = Date.parse("2026-11-12T03:00:00Z");
  let clock = start;
  const requests: string[] = [];
  const thread = (
    id: string,
    authorId: string,
    forum: string,
    views: number,
    keys = [id],
  ) => ({
    id,
    authorId,
    author: authorId === "101" ? "作者甲" : "作者乙",
    title: `网盘资源 ${id}`,
    url: `https://tieba.baidu.com/p/${id}`,
    forum,
    publishedAt: new Date(start - 3 * 3600000).toISOString(),
    views,
    likes: null,
    shares: null,
    replies: null,
    resource: { linked: false, keys },
  });
  const readers: TiebaDiscoveryReaders = {
    forum: async ({ name }) => {
      requests.push(name);
      const extra = clock > start ? 1 : 0;
      const threads =
        name === "网盘资源"
          ? [
              thread("111", "101", name, 25 + 50 * extra),
              thread("112", "101", name, 20 + 5 * extra),
              thread("113", "102", name, 15 + 6 * extra),
              thread("114", "103", name, 15 + 5 * extra),
            ]
          : [thread("115", "104", name, 11, ["111"])];
      return {
        id: "1",
        name,
        url: `https://tieba.baidu.com/f?kw=${name}`,
        page: 1,
        hasMore: false,
        threads,
      };
    },
    user: async () => ({
      uid: "101",
      profileId: null,
      author: "作者甲",
      threads: [thread("121", "101", "资料分享", 30)],
    }),
    followed: async () => ({ visibility: "restricted" }),
    views: async () => null,
  };
  const service = new TiebaResourceDiscovery(
    db,
    () => {},
    readers,
    () => clock,
  );
  async function cycle() {
    service.scan();
    for (let i = 0; i < 100 && service.isBusy; i++) await sleep(5);
    assert.equal(service.isBusy, false);
    return service.snapshot();
  }
  try {
    const first = await cycle();
    assert.equal(first.trending.length, 0);
    assert.equal(first.watching.length, 3);
    assert.equal(first.potentialCount, 1);
    const [original] = service.potential(1).items;
    assert.equal(original.id, "111");
    assert.equal(original.first.views, 25);
    assert.equal(original.first.comparedInteractions, false);
    assert.deepEqual(first.sources[1]?.path, [
      "网盘资源",
      "作者甲",
      "资料分享",
    ]);
    clock += 3600000;
    const second = await cycle();
    assert.deepEqual(requests, ["网盘资源", "网盘资源", "资料分享"]);
    assert.deepEqual(
      second.trending.map((item) => [
        item.id,
        item.growth?.delta,
        item.rank?.place,
        item.copies,
      ]),
      [["111", 50, 1, 2]],
    );
    assert.deepEqual(second.trending[0].paths, [
      ["网盘资源"],
      ["网盘资源", "作者甲", "资料分享"],
    ]);
    const [updated] = service.potential(1).items;
    assert.equal(second.potentialCount, 1);
    assert.equal(updated.views, 75);
    assert.deepEqual(updated.first, original.first);
    assert.equal(updated.confirmedAt, clock);
    const restored = new TiebaResourceDiscovery(
      db,
      () => {},
      readers,
      () => clock,
    );
    assert.equal(restored.snapshot().trending.length, 1);
    assert.equal(restored.setAuto(true).nextAt, clock + 3600000);
    assert.equal(restored.setAuto(false).nextAt, null);
    restored.dispose();
    clock += 2 * 24 * discoveryInterval;
    assert.equal((await cycle()).potentialCount, 1);
    assert.equal(service.potential(1).items[0].active, false);
  } finally {
    service.dispose();
    db.close();
  }
});

test("首轮按同吧同期的有效样本排名，互动可以提升名次，未知不填零", () => {
  const at = Date.parse("2026-11-12T03:00:00Z");
  const peers = [30, 25, 20, 15, 14, 13, 12, 11].map((views, index) => ({
    id: String(index),
    forum: "网盘资源",
    keys: [String(index)],
    publishedAt: new Date(at - discoveryInterval).toISOString(),
    views,
    replies: index === 1 ? 5 : 0,
    likes: null,
    shares: null,
  }));
  const results = potentialSignals(
    [
      ...peers,
      { ...peers[1], id: "转帖", views: 10 },
      { ...peers[0], id: "其他吧", forum: "资料分享", views: 1_000 },
      {
        ...peers[0],
        id: "早期贴",
        publishedAt: new Date(at - 9 * discoveryInterval).toISOString(),
        views: 1_000,
      },
    ],
    at,
  );
  assert.deepEqual([...results.keys()], ["0", "1"]);
  assert.deepEqual(results.get("1")?.rank, { place: 1, sample: 8 });
  assert.equal(results.get("1")?.likes, null);
  assert.deepEqual(results.get("1")?.viewRank, { place: 2, sample: 8 });
  assert.equal(results.get("1")?.comparedInteractions, true);
  assert.equal(potentialSignals(peers.slice(0, 3), at).size, 0);
  assert.equal(
    potentialSignals(
      peers.map((post) => ({ ...post, views: 8, replies: null })),
      at,
    ).size,
    0,
  );
});

test("潜力帖移出贴吧列表后优先占用自动复查名额，并更新原入库记录", async (t) => {
  const db = new Database(":memory:");
  const at = Date.parse("2026-11-12T03:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: at });
  const forum = "网盘资源";
  const checked: string[] = [];
  const service = new TiebaResourceDiscovery(db, () => {}, {
    forum: async () => ({
      id: "1",
      name: forum,
      page: 1,
      hasMore: false,
      url: "https://tieba.baidu.com/f?kw=网盘资源",
      threads:
        Date.now() - at >= discoveryInterval
          ? []
          : Array.from({ length: 24 }, (_, index) => ({
              id: String(100 + index),
              title: `网盘资源 ${index}`,
              url: `https://tieba.baidu.com/p/${100 + index}`,
              forum,
              author: "",
              publishedAt: new Date(at - discoveryInterval).toISOString(),
              views: index === 23 ? 99 : 10,
              replies: 0,
              likes: null,
              shares: null,
              resource: { linked: true, keys: [String(index)] },
            })),
    }),
    user: async () => assert.fail("没有可查询作者"),
    followed: async () => assert.fail("没有可查询作者"),
    views: async (id) => {
      checked.push(id);
      return id === "123" ? 120 : 11;
    },
  });
  async function advance(ms: number) {
    t.mock.timers.tick(ms);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(service.isBusy, false);
  }
  try {
    service.setAuto(true);
    await advance(1);
    assert.equal(service.potential(1).total, 1);
    await advance(discoveryInterval);
    assert.equal(checked.length, 20);
    assert.equal(checked[0], "123");
    const [post] = service.potential(1).items;
    assert.equal(post.first.views, 99);
    assert.equal(post.views, 120);
    assert.equal(post.replies, 0);
    assert.equal(post.shares, null);
    assert.equal(service.potential(2).page, 1);
  } finally {
    service.dispose();
    db.close();
  }
});

test("自动扫描遇到网络故障后继续调度，重开工作台后复查列表缺失的浏览量", async (t) => {
  const db = new Database(":memory:");
  const start = Date.parse("2026-11-12T03:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: start });
  const forum = "网盘资源";
  let calls = 0;
  const readers: TiebaDiscoveryReaders = {
    forum: async () => {
      if (++calls === 1) throw new Error("网络断开");
      return {
        id: "1",
        name: forum,
        url: `https://tieba.baidu.com/f?kw=${encodeURIComponent(forum)}`,
        page: 1,
        hasMore: false,
        threads: ["111", "112", "113", "114"].map((id) => ({
          id,
          title: `网盘资源 ${id}`,
          author: "",
          forum,
          url: `https://tieba.baidu.com/p/${id}`,
          publishedAt: new Date(start - discoveryInterval).toISOString(),
          views: null,
          likes: null,
          shares: null,
          replies: null,
          resource: { linked: false, keys: [id] },
        })),
      };
    },
    user: async () => assert.fail("帖子没有可查询的作者 ID"),
    followed: async () => assert.fail("帖子没有可查询的作者 ID"),
    views: async (id) => (calls === 2 ? 20 : id === "111" ? 70 : 25),
  };
  const open = () => new TiebaResourceDiscovery(db, () => {}, readers);
  let service = open();
  async function advance(ms: number) {
    t.mock.timers.tick(ms);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(service.isBusy, false);
    return service.snapshot();
  }

  try {
    assert.equal(service.snapshot().auto, false);
    service.setAuto(true);
    const failed = await advance(1);
    assert.equal(failed.lastRun?.forums, 0);
    assert.match(failed.lastRun?.warnings[0] ?? "", /网络断开/);

    const recovered = await advance(discoveryInterval);
    assert.equal(recovered.lastRun?.forums, 1);
    assert.deepEqual(recovered.lastRun?.warnings, []);
    assert.deepEqual(
      recovered.watching.map((post) => post.views),
      [20, 20, 20, 20],
    );
    assert.equal(recovered.trending.length, 0);

    service.dispose();
    service = open();
    assert.equal(service.snapshot().auto, true);
    assert.equal(service.snapshot().nextAt, recovered.nextAt);
    const rechecked = await advance(discoveryInterval);
    assert.deepEqual(
      rechecked.trending.map((post) => post.growth?.delta),
      [50],
    );

    service.setAuto(false);
    service.dispose();
    service = open();
    assert.equal((await advance(discoveryInterval)).nextAt, null);
    assert.equal(calls, 3);
  } finally {
    service.dispose();
    db.close();
  }
});

test("候选贴吧按实际发帖扩展，新增量跟上核验能力并保留复查位置", async (t) => {
  const db = new Database(":memory:");
  const start = Date.parse("2026-11-12T03:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: start });
  const seed = "网盘资源";
  const scanned: string[] = [];
  const thread = (id: string, authorId: string, forum: string) => ({
    id,
    authorId,
    author: `作者${authorId}`,
    title: `网盘资源 ${id}`,
    url: `https://tieba.baidu.com/p/${id}`,
    forum,
    publishedAt: new Date(start - discoveryInterval).toISOString(),
    views: 20,
    likes: null,
    shares: null,
    replies: null,
    resource: { linked: true, keys: [id] },
  });
  let followedCalls = 0;
  const service = new TiebaResourceDiscovery(db, () => {}, {
    forum: async ({ name }) => {
      scanned.push(name);
      const hour = Math.floor((Date.now() - start) / discoveryInterval);
      return {
        id: "1",
        name,
        url: `https://tieba.baidu.com/f?kw=${encodeURIComponent(name)}`,
        page: 1,
        hasMore: false,
        threads:
          name === seed
            ? Array.from({ length: 4 }, (_, index) => {
                const uid = String(100 + hour * 10 + index);
                return [
                  thread(`${uid}1`, uid, seed),
                  thread(`${uid}2`, uid, seed),
                ];
              }).flat()
            : [],
      };
    },
    user: async ({ target }) => {
      const uid = target.slice(5);
      return {
        uid,
        profileId: null,
        author: `作者${uid}`,
        threads: uid.endsWith("0")
          ? []
          : [thread(`${uid}3`, uid, `资料分享${uid}`)],
      };
    },
    followed: async () => {
      followedCalls++;
      return {
        visibility: "public",
        hasMore: false,
        forums: [
          {
            id: "1",
            name: "泛兴趣",
            url: "https://tieba.baidu.com/f?kw=泛兴趣",
            level: null,
          },
        ],
      };
    },
    views: async () => 20,
  });
  async function next(ms: number) {
    scanned.length = 0;
    t.mock.timers.tick(ms);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(service.isBusy, false);
    return service.snapshot();
  }

  try {
    service.setAuto(true);
    const first = await next(1);
    assert.equal(first.lastRun?.added, 3);
    assert.deepEqual(
      first.sources.map((source) => source.name),
      [seed, "资料分享101", "资料分享102", "资料分享103"],
    );
    assert.equal(followedCalls, 0);
    await next(discoveryInterval);
    assert.deepEqual(scanned, [
      seed,
      "资料分享101",
      "资料分享102",
      "资料分享103",
    ]);
    await next(discoveryInterval);
    assert.deepEqual(scanned, [
      seed,
      "资料分享111",
      "资料分享112",
      "资料分享113",
    ]);
    const fourth = await next(discoveryInterval);
    assert.deepEqual(scanned, [
      seed,
      "资料分享101",
      "资料分享121",
      "资料分享122",
    ]);
    assert(
      fourth.sources.filter((source) => source.scannedAt === null).length <= 6,
    );
    assert.equal(followedCalls, 0);
  } finally {
    service.dispose();
    db.close();
  }
});

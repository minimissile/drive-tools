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

const discoveryExpansionInterval = 5 * 60_000;
const fixedTimingDiscovery = (
  db: Database,
  readers?: TiebaDiscoveryReaders,
  now = Date.now,
) =>
  new TiebaResourceDiscovery(
    db,
    () => {},
    readers,
    now,
    () => 0.5,
  );

test("两种随机间隔独立保存，重开接续并保留简短扫描日志", async (t) => {
  const db = new Database(":memory:");
  const at = Date.parse("2026-11-12T03:00:00Z");
  const minute = 60_000;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: at });
  db.setSetting("tieba.resourceDiscovery.v1", {
    seeds: ["网盘资源"],
    sources: [
      { name: "网盘资源", path: ["网盘资源"], status: "seed", scannedAt: at },
      {
        name: "资料分享",
        path: ["网盘资源", "作者", "资料分享"],
        status: "watch",
        scannedAt: null,
      },
    ],
    posts: [],
    authors: {},
    lastRun: { at, forums: 1, authors: 1, added: 1, warnings: [] },
  });
  const scanned: string[] = [];
  const readers: TiebaDiscoveryReaders = {
    forum: async ({ name }) => {
      scanned.push(name);
      return { id: "1", name, url: "", page: 1, hasMore: false, threads: [] };
    },
    user: async () => assert.fail("没有作者待查"),
    followed: async () => assert.fail("没有作者待查"),
    views: async () => assert.fail("没有帖子待复查"),
  };
  const draws = [0.15, 0.85];
  let service = new TiebaResourceDiscovery(
    db,
    () => {},
    readers,
    Date.now,
    () => draws.shift()!,
  );
  async function advance(ms: number) {
    t.mock.timers.tick(ms);
    await new Promise<void>((resolve) => setImmediate(resolve));
    return service.snapshot();
  }
  try {
    const scheduled = service.setAuto(true);
    const expansionAt = at + 6.4 * minute;
    assert.equal(scheduled.nextMode, "expand");
    assert.equal(scheduled.nextAt, expansionAt);
    assert.match(scheduled.logs?.at(-1)?.message ?? "", /下一批扩散约 7 分钟/);
    assert.deepEqual(draws, []);
    service.dispose();

    let redrawn = 0;
    service = new TiebaResourceDiscovery(
      db,
      () => {},
      readers,
      Date.now,
      () => {
        redrawn++;
        return 0.95;
      },
    );
    assert.equal(service.snapshot().nextAt, expansionAt);
    assert.deepEqual(service.snapshot().logs, scheduled.logs);
    assert.equal(redrawn, 0);
    await advance(expansionAt - at - 1);
    assert.deepEqual(scanned, []);
    const expanded = await advance(1);
    assert.deepEqual(scanned, ["资料分享"]);
    assert.equal(expanded.nextAt, at + 53 * minute);
    assert.equal(expanded.nextMode, "survey");
    assert(
      expanded.logs?.some((entry) => entry.message === "正在扫描「资料分享」"),
    );
    assert.match(
      expanded.logs?.at(-2)?.message ?? "",
      /本批结束，读到 1 个贴吧/,
    );
    assert.equal(redrawn, 0);

    const surveyed = await advance(53 * minute - (expansionAt - at));
    assert.deepEqual(scanned, ["资料分享", "网盘资源"]);
    assert.equal(surveyed.nextAt, at + (53 + 69) * minute);
    assert.equal(redrawn, 1);
    assert.equal(service.setAuto(false).nextAt, null);
    assert.equal(service.setAuto(true).nextAt, surveyed.nextAt);
    assert.equal(redrawn, 1);
  } finally {
    service.dispose();
    db.close();
  }
});

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
  const service = fixedTimingDiscovery(db, readers, () => clock);
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
    const restored = fixedTimingDiscovery(db, readers, () => clock);
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

test("首轮按同吧同期的浏览速度评分，较新的帖子可排在总浏览量更高的帖子之前", () => {
  const at = Date.parse("2026-11-12T03:00:00Z");
  const peers = [30, 25, 20, 15, 14, 13, 12, 11].map((views, index) => ({
    id: String(index),
    forum: "网盘资源",
    keys: [String(index)],
    publishedAt: new Date(
      at - (index === 1 ? 0.6 : 1) * discoveryInterval,
    ).toISOString(),
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
  assert.deepEqual(results.get("1")?.viewRank, { place: 1, sample: 8 });
  assert.equal(results.get("1")?.score, 100);
  assert.equal(
    potentialSignals(
      peers.map((post) => ({ ...post, replies: 999, shares: 999 })),
      at,
    ).get("1")?.score,
    100,
  );
  assert.equal(results.get("1")?.comparedInteractions, false);
  assert.equal(potentialSignals(peers.slice(0, 3), at).size, 0);
  assert.deepEqual(
    [
      ...potentialSignals(peers, at, {
        lookbackHours: 48,
        potentialThreshold: 100,
        trafficThreshold: 10_000,
      }).keys(),
    ],
    ["1"],
  );
  assert.equal(
    potentialSignals(peers, at + discoveryInterval, {
      lookbackHours: 1,
      potentialThreshold: 75,
      trafficThreshold: 10_000,
    }).size,
    0,
  );
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
  const service = fixedTimingDiscovery(db, {
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
    assert.deepEqual(checked, ["123"]);
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

test("历史高流量帖直接入库，潜力帖达到门槛后转入且停止详情复查", async (t) => {
  const db = new Database(":memory:");
  const at = Date.parse("2026-11-12T03:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: at });
  const seed = "网盘资源";
  const scanned: [string, number][] = [];
  const checked: string[] = [];
  const probed: string[] = [];
  const post = (
    id: string,
    views: number,
    ageHours: number,
    authorId?: string,
    forum = seed,
  ) => ({
    id,
    title: `网盘资源 ${id}`,
    forum,
    views,
    authorId,
    author: "作者",
    replies: 0,
    likes: 0,
    shares: null,
    publishedAt: new Date(at - ageHours * discoveryInterval).toISOString(),
    url: `https://tieba.baidu.com/p/${id}`,
    resource: { linked: true, keys: [id] },
  });
  const service = fixedTimingDiscovery(db, {
    forum: async ({ name, page }) => {
      scanned.push([name, page]);
      const round = Math.floor((Date.now() - at) / discoveryInterval);
      const recent = [
        post("101", 99, 1),
        post("102", 8, 1),
        post("103", 7, 1),
        post("104", 6, 1),
      ];
      const threads =
        name !== seed
          ? []
          : page < 4
            ? round === 0
              ? recent
              : recent.slice(1)
            : page === 4
              ? [post("201", 11_000, 10 * 24, "1234")]
              : [post("202", 12_000, 12 * 24)];
      return {
        id: "1",
        name,
        page,
        hasMore: name === seed && page < 5,
        url: `https://tieba.baidu.com/f?kw=${name}`,
        threads,
      };
    },
    views: async (id) => {
      checked.push(id);
      return 10_000;
    },
    user: async ({ target }) => {
      probed.push(target);
      return {
        uid: "1234",
        profileId: null,
        author: "作者",
        threads: [post("203", 50, 1, "1234", "新资源")],
      };
    },
    followed: async () => ({ visibility: "restricted" }),
  });
  async function advance(ms: number) {
    t.mock.timers.tick(ms);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(service.isBusy, false);
  }
  try {
    const initialRules = {
      lookbackHours: 24,
      potentialThreshold: 90,
      trafficThreshold: 11_000,
    };
    assert.deepEqual(service.saveRules(initialRules).rules, initialRules);
    service.setAuto(true);
    await advance(1);
    assert.deepEqual(
      service.potential(1).items.map((item) => item.id),
      ["101"],
    );
    assert.deepEqual(
      service.traffic(1).items.map((item) => [item.id, item.fromPotential]),
      [["201", false]],
    );
    assert.deepEqual(probed, ["UID: 1234"]);
    assert.deepEqual(service.snapshot().sources[1]?.path, [
      seed,
      "作者",
      "新资源",
    ]);
    const changed = { ...initialRules, trafficThreshold: 10_000 };
    service.saveRules(changed);
    await advance(discoveryExpansionInterval);
    assert(scanned.some(([name, page]) => name === "新资源" && page === 1));
    assert.equal(service.snapshot().lastRun?.mode, "expand");
    await advance(discoveryInterval - discoveryExpansionInterval);
    assert(scanned.some(([name, page]) => name === seed && page === 5));
    assert.equal(service.potential(1).total, 0);
    assert.deepEqual(
      service.traffic(1).items.map((item) => [item.id, item.fromPotential]),
      [
        ["202", false],
        ["101", true],
        ["201", false],
      ],
    );
    assert.equal(
      db.get<{ count: number }>(
        "SELECT count(*) AS count FROM tieba_discovery_potential",
      )?.count,
      1,
    );
    await advance(discoveryInterval);
    assert.deepEqual(checked, ["101"]);
    assert.equal(service.traffic(1).total, 3);
    service.dispose();
    const reopened = fixedTimingDiscovery(db);
    assert.deepEqual(reopened.snapshot().rules, changed);
    assert.equal(reopened.traffic(1).total, 3);
    reopened.dispose();
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
    views: async (id) =>
      calls === 2 ? (id === "111" ? 35 : 20) : id === "111" ? 85 : 25,
  };
  const open = () => fixedTimingDiscovery(db, readers);
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
      [20, 20, 20],
    );
    assert.equal(recovered.trending.length, 0);

    service.dispose();
    service = open();
    assert.equal(service.snapshot().auto, true);
    assert.equal(service.snapshot().nextAt, recovered.nextAt);
    const rechecked = await advance(discoveryInterval);
    assert.equal(rechecked.potentialCount, 1);
    assert.equal(service.potential(1).items[0].views, 85);

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
  const service = fixedTimingDiscovery(db, {
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
            : name === "资料分享101"
              ? [thread("2011", "201", name), thread("2012", "201", name)]
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
    const expansion = await next(discoveryExpansionInterval);
    assert.equal(expansion.lastRun?.mode, "expand");
    assert.deepEqual(scanned, ["资料分享101", "资料分享102", "资料分享103"]);
    assert.deepEqual(expansion.sources.at(-1)?.path, [
      seed,
      "作者101",
      "资料分享101",
      "作者201",
      "资料分享201",
    ]);
    assert.equal(expansion.queuedForums, 1);
    const deeper = await next(discoveryExpansionInterval);
    assert.deepEqual(scanned, ["资料分享201"]);
    assert.equal(deeper.queuedForums, 0);
    assert.equal(deeper.nextMode, "survey");
    assert.equal(deeper.nextAt, first.lastRun!.at + discoveryInterval);
    await next(discoveryInterval - 2 * discoveryExpansionInterval);
    assert.deepEqual(scanned, [seed]);
    await next(discoveryExpansionInterval);
    assert.deepEqual(scanned, ["资料分享111", "资料分享112", "资料分享113"]);
    await next(discoveryInterval - discoveryExpansionInterval);
    assert.deepEqual(scanned, [seed]);
    await next(discoveryExpansionInterval);
    const later = await next(discoveryInterval - discoveryExpansionInterval);
    assert(scanned.includes("资料分享101"));
    assert(later.queuedForums! <= 6);
    assert.equal(followedCalls, 0);
  } finally {
    service.dispose();
    db.close();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Database } from "../core/database";
import { AppError } from "../core/errors";
import { defaultTiebaDiscoveryRules } from "../shared/tieba-resource-discovery";
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
import {
  isOldResource,
  oldResourceEvidence,
} from "../core/tieba-resource-discovery/old-resource";
import { TiebaFilterAudit } from "../core/tieba-resource-discovery/filter-audit";
import { scanForumResourcePage } from "../core/tieba-resource-discovery/forum-scan";
import { recordRecycledPosts } from "../core/tieba-resource-discovery/recycled";
import { fixture } from "./helpers";

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

test("主工作台可读取同时运行的巡查和老帖扫描，并在任务结束时移除", async () => {
  const db = new Database(":memory:");
  let finishSurvey!: () => void;
  let finishHistory!: () => void;
  const survey = new Promise<void>((resolve) => { finishSurvey = resolve; });
  const history = new Promise<void>((resolve) => { finishHistory = resolve; });
  const forumPage = {
    id: "1", page: 1, url: "", name: "网盘资源", hasMore: false, threads: [],
  };
  const states: ReturnType<TiebaResourceDiscovery["activeTasks"]>[] = [];
  const service = new TiebaResourceDiscovery(db, () => states.push(service.activeTasks()), {
    forum: async () => {
      await survey;
      return forumPage;
    },
    oldForum: async () => {
      await history;
      return forumPage;
    },
    views: async () => assert.fail("空列表不复查浏览量"),
    user: async () => assert.fail("空列表不检查作者"),
    followed: async () => assert.fail("空列表不检查关注"),
  });
  try {
    assert.deepEqual(service.activeTasks(), []);
    service.scan();
    service.scanOldForum();
    assert.deepEqual(service.activeTasks(), [
      { kind: "survey", forum: "网盘资源" },
      { kind: "history", forum: "网盘资源", page: 1 },
    ]);
    finishHistory();
    for (let i = 0; i < 50 && service.activeTasks().length > 1; i++) await sleep(5);
    assert.deepEqual(service.activeTasks(), [{ kind: "survey", forum: "网盘资源" }]);
    finishSurvey();
    for (let i = 0; i < 50 && service.isBusy; i++) await sleep(5);
    assert.deepEqual(service.activeTasks(), []);
    assert.deepEqual(states.at(-1), []);
  } finally {
    service.dispose();
    finishSurvey();
    finishHistory();
    db.close();
  }
});

test("筛查抽查只收开始后的不同帖子，保留前 100 条并跨服务恢复", () => {
  const db = new Database(":memory:");
  const audit = new TiebaFilterAudit(db);
  const reject = (id: string) => ({
    post: {
      id, title: `帖子 ${id}`, url: `https://tieba.baidu.com/p/${id}`,
      forum: "网盘资源", publishedAt: "2026-11-01T00:00:00Z", views: 10,
    },
    reason: { kind: "oldResource" as const },
  });
  try {
    audit.record([reject("900")], 1);
    assert.equal(audit.summary(), null);
    assert.equal(audit.start(2), true);
    audit.record([reject("1"), reject("1"), reject("2")], 3);
    assert.equal(audit.start(4), false);
    const resumed = new TiebaFilterAudit(db);
    resumed.record(Array.from({ length: 120 }, (_, index) => reject(String(index + 3))), 5);
    resumed.record([reject("901")], 6);
    assert.deepEqual(resumed.summary(), { batch: 1, startedAt: 2, count: 100 });
    assert.equal(resumed.page(1).items[0].number, "SC-1-001");
    assert.equal(resumed.page(1).items[1].post.id, "2");
    assert.equal(resumed.page(11).page, 10);
    assert.equal(resumed.page(10).items.at(-1)?.post.id, "100");
    assert.equal(resumed.page(10).items.at(-1)?.number, "SC-1-100");
    assert.equal(resumed.start(7), true);
    assert.equal(resumed.page(1).total, 0);
    resumed.record([reject("901")], 8);
    assert.equal(resumed.page(1).items[0].number, "SC-2-001");
  } finally {
    db.close();
  }
});

test("抽查 IPC 无需参数，满 100 条后可开始新一轮", async () => {
  const { app, cleanup } = await fixture();
  const read = () => app.invoke("tieba.discovery.filterAudit", { page: 1 });
  const start = () => app.invoke("tieba.discovery.startFilterAudit");
  try {
    await start();
    assert.deepEqual(await read(), { batch: 1, page: 1, total: 0, items: [] });

    const audit = new TiebaFilterAudit(app.db);
    audit.record(Array.from({ length: 100 }, (_, index) => ({
      post: {
        id: String(index + 1), title: "样本帖子", forum: "网盘资源",
        url: `https://tieba.baidu.com/p/${index + 1}`,
        publishedAt: "2026-11-01T00:00:00Z", views: 10,
      },
      reason: { kind: "recentResource" },
    })), Date.now());
    await assert.rejects(app.invoke("tieba.discovery.startFilterAudit", { batch: 2 }), { name: "ZodError" });
    assert.equal(audit.summary()?.count, 100);
    await start();
    assert.deepEqual(await read(), { batch: 2, page: 1, total: 0, items: [] });
  } finally {
    await cleanup();
  }
});

test("抽查 IPC 对整轮样本排序后分页，缺失浏览量始终排在末尾", async () => {
  const { app, cleanup } = await fixture();
  const now = Date.parse("2026-11-20T00:00:00Z");
  try {
    await app.invoke("tieba.discovery.startFilterAudit");
    const audit = new TiebaFilterAudit(app.db);
    for (let index = 0; index < 13; index++) {
      const id = String(index + 1);
      audit.record([{
        post: {
          id, title: `样本 ${id}`, forum: "网盘资源",
          url: `https://tieba.baidu.com/p/${id}`,
          publishedAt: new Date(now - index * discoveryInterval).toISOString(),
          views: index === 5 ? null : index * 10,
        },
        reason: { kind: "recentResource" },
      }], now + index);
    }
    const read = async (sort: "sampledAt" | "publishedAt" | "views", direction: "asc" | "desc", page = 1) => {
      const result = await app.invoke("tieba.discovery.filterAudit", { page, sort, direction }) as ReturnType<TiebaFilterAudit["page"]>;
      return result.items.map(({ number }) => number);
    };
    assert.equal((await read("views", "desc"))[0], "SC-1-013");
    assert.deepEqual(await read("views", "desc", 2), ["SC-1-002", "SC-1-001", "SC-1-006"]);
    assert.deepEqual(await read("views", "asc", 2), ["SC-1-012", "SC-1-013", "SC-1-006"]);
    assert.equal((await read("sampledAt", "asc"))[0], "SC-1-001");
    assert.equal((await read("sampledAt", "desc"))[0], "SC-1-013");
    assert.equal((await read("publishedAt", "desc"))[0], "SC-1-001");
    assert.equal((await read("publishedAt", "asc"))[0], "SC-1-013");
    await assert.rejects(app.invoke("tieba.discovery.filterAudit", { page: 1, sort: "unknown" }), { name: "ZodError" });
  } finally {
    await cleanup();
  }
});

test("筛查抽查记录真实过滤原因，命中资源和读取失败不计入", async () => {
  const db = new Database(":memory:");
  const now = Date.parse("2026-11-13T12:00:00Z");
  const post = (id: string, age: number, views: number | null) => ({
    id, forum: "网盘资源", title: `帖子 ${id}`, author: "", authorId: null,
    url: `https://tieba.baidu.com/p/${id}`,
    publishedAt: new Date(now - age * 24 * discoveryInterval).toISOString(),
    views, replies: 0, likes: null, shares: null,
  });
  const forum = (threads: ReturnType<typeof post>[]) =>
    ({ id: "1", page: 1, url: "", name: "网盘资源", hasMore: false, threads });
  const service = fixedTimingDiscovery(db, {
    forum: async () => forum([post("500", 1, 100)]),
    oldForum: async () => forum([
      post("501", 10, 80), post("502", 10, 1000),
      post("503", 10, 1000), post("504", 10, null),
    ]),
    oldResource: async (id) => ({
      linkSources: [], keywords: id === "503" ? ["链接"] : id === "502" ? ["资源"] : [],
    }),
    views: async () => null,
    user: async () => assert.fail("样本无作者"),
    followed: async () => assert.fail("样本无作者"),
  }, () => now);
  try {
    service.startFilterAudit();
    service.scan();
    for (let i = 0; i < 100 && service.isBusy; i++) await sleep(5);
    service.scanOldForum();
    for (let i = 0; i < 150 && service.snapshot().oldResourcePending !== 1; i++) await sleep(10);
    const items = service.filterAuditPage(1).items;
    assert.deepEqual(items.map(({ post, reason }) => [post.id, reason.kind]), [
      ["500", "recentResource"], ["501", "oldTraffic"], ["502", "oldResource"],
    ]);
    assert.deepEqual(items[1].reason, {
      kind: "oldTraffic", dailyViews: 8, minViews: 1000, minDailyViews: 10,
    });
    assert.equal(service.oldTraffic(1, "screened").items[0]?.id, "503");
  } finally {
    service.dispose();
    db.close();
  }
});

test("回收贴 IPC 分页保留最新 500 个不同帖子，恢复入库后移出回收贴", async () => {
  const { app, cleanup } = await fixture();
  const makePost = (id: string) => ({
    id, title: `样本 ${id}`, forum: "网盘资源", url: `https://tieba.baidu.com/p/${id}`,
    publishedAt: "2026-11-01T00:00:00Z", views: 10,
  });
  try {
    recordRecycledPosts(app.db, Array.from({ length: 502 }, (_, index) => ({
      post: makePost(String(index + 1)), source: "pending", reason: "belowThreshold",
    })), 1);
    const read = async (page: number) => await app.invoke("tieba.discovery.recycled", { page }) as ReturnType<TiebaResourceDiscovery["recycledPage"]>;
    assert.equal((await read(1)).total, 500);
    assert.equal((await read(1)).items[0].post.id, "502");
    assert.equal((await read(51)).items.at(-1)?.post.id, "3");
    recordRecycledPosts(app.db, [{ post: makePost("3"), source: "traffic", reason: "resource" }], 2, ["4"]);
    assert.equal((await read(1)).total, 499);
    assert.equal((await read(1)).items[0].source, "traffic");
    assert.equal((await read(1)).items[0].post.id, "3");
    const filtered = await app.invoke("tieba.discovery.recycled", {
      page: 50, source: "traffic", reason: "resource", minViews: 10, sort: "views",
    }) as Awaited<ReturnType<typeof read>>;
    assert.deepEqual([filtered.page, filtered.total, filtered.items[0]?.post.id], [1, 1, "3"]);
    const noMatch = await app.invoke("tieba.discovery.recycled", { page: 1, minViews: 11 }) as Awaited<ReturnType<typeof read>>;
    assert.equal(noMatch.total, 0);
  } finally {
    await cleanup();
  }
});

test("超期待观察帖先重新读取流量，按读数恢复、回收或保留待复查", async () => {
  const db = new Database(":memory:");
  const day = 24 * discoveryInterval;
  const now = Date.parse("2026-11-24T00:00:00Z");
  const checked: string[] = [];
  const service = fixedTimingDiscovery(db, {
    forum: async ({ name, page }) => ({ id: "1", name, page, url: "", hasMore: false, threads: [] }),
    user: async () => assert.fail("没有楼主可扩散"),
    followed: async () => assert.fail("无需读取关注"),
    views: async (id) => {
      checked.push(id);
      return id === "101" ? 2000 : id === "102" ? 75 : null;
    },
    oldResource: async (id) => {
      assert.equal(id, "101");
      return { linkSources: ["正文"], keywords: [] };
    },
  }, () => now);
  try {
    const initial = now - 7 * day;
    db.setSetting("tieba.resourceDiscovery.v1", {
      ...db.setting("tieba.resourceDiscovery.v1", { seeds: ["网盘资源"], sources: [], authors: {}, lastRun: null }),
      posts: ["101", "102", "103"].map((id) => ({
        id, title: `待观察帖 ${id}`, author: "", uid: null, forum: "网盘资源", url: `https://tieba.baidu.com/p/${id}`,
        publishedAt: new Date(now - 8 * day).toISOString(), checkedAt: initial,
        pendingSince: initial, views: 15, baseline: { at: initial, views: 15 }, growth: null, streak: 0, keys: [], linked: true,
      })),
    });
    service.scan();
    for (let i = 0; i < 100 && service.isBusy; i++) await sleep(5);
    assert.deepEqual(checked, ["101", "102", "103"]);
    assert.deepEqual(service.trafficPosts(1, "all", "all").items.map(({ id, views }) => [id, views]), [["101", 2000]]);
    assert.deepEqual(service.pending(1).items.map(({ id, views }) => [id, views]), [["103", 15]]);
    assert.deepEqual(service.recycledPage(1).items.map(({ post, source, reason }) => [post.id, post.views, post.checkedAt, source, reason]),
      [["102", 75, now, "pending", "belowThreshold"]]);
  } finally {
    service.dispose();
    db.close();
  }
});

test("复查已有回收贴时恢复达标帖，更新未达标读数并保留读取失败项", async () => {
  const db = new Database(":memory:");
  const now = Date.parse("2026-11-24T00:00:00Z");
  const service = fixedTimingDiscovery(db, {
    forum: async () => assert.fail("无需扫描吧列表"),
    user: async () => assert.fail("无需读取楼主"),
    followed: async () => assert.fail("无需读取关注"),
    views: async () => assert.fail("详情已包含读数"),
    details: async (id) => ({ views: id === "101" ? 2000 : id === "102" ? 100 : null, resource: { keywords: ["网盘"], linkSources: [] } }),
  }, () => now);
  try {
    const recycledAt = now - discoveryInterval;
    recordRecycledPosts(db, ["101", "102", "103"].map((id) => ({
      post: { id, title: `测试帖 ${id}`, forum: "网盘资源", url: `https://tieba.baidu.com/p/${id}`, publishedAt: "2026-11-14T00:00:00Z", views: 14 },
      source: "pending", reason: "observationExpired",
    })), recycledAt);
    assert.deepEqual(await service.refresh({ kind: "recycled", ids: ["101", "102", "103"] }), { updated: 2, failed: 1, restored: 1 });
    assert.equal(service.trafficPosts(1, "all", "all").items[0]?.id, "101");
    assert.deepEqual(service.recycledPage(1).items.map(({ post, reason, recycledAt }) => [post.id, post.views, post.checkedAt, reason, recycledAt]), [
      ["103", 14, undefined, "observationExpired", recycledAt],
      ["102", 100, now, "belowThreshold", recycledAt],
    ]);
  } finally {
    service.dispose();
    db.close();
  }
});

test("SC-1-003：达到累计浏览门槛的帖子按详情里的回复链接收录", async () => {
  const db = new Database(":memory:");
  const now = Date.parse("2026-11-19T15:31:16.640Z");
  const post = {
    id: "11211312025",
    title: "泰剧fool in love&你却爱着一个他 更13集",
    url: "https://tieba.baidu.com/p/11211312025",
    forum: "网盘资源",
    author: "",
    authorId: null,
    publishedAt: "2026-11-19T13:34:32.000Z",
    views: 792,
    replies: 2,
    likes: 1,
    shares: null,
  };
  const checked: string[] = [];
  const service = fixedTimingDiscovery(db, {
    forum: async () => ({
      id: "1", page: 1, url: "", name: "网盘资源", hasMore: false,
      threads: [post, { ...post, id: "501" }, { ...post, id: "502" },
        { ...post, id: "503", views: 199 }, { ...post, id: "504", title: "求资源链接" }],
    }),
    details: async (id) => {
      checked.push(id);
      if (id === "502") throw new AppError("TIEBA_ANALYSIS_NETWORK", "暂时断网");
      return { views: 792, resource: {
        linkSources: id === post.id ? ["回复"] : [],
        keywords: ["链接"],
      } };
    },
    views: async () => assert.fail("列表及详情已有浏览量"),
    user: async () => assert.fail("样本无作者"),
    followed: async () => assert.fail("样本无作者"),
  }, () => now);
  try {
    service.saveRules({ ...defaultTiebaDiscoveryRules, trafficThreshold: 200 });
    service.startFilterAudit();
    service.scan();
    for (let i = 0; i < 100 && service.isBusy; i++) await sleep(5);
    assert.equal(service.isBusy, false);
    assert.deepEqual(checked, [post.id, "501", "502"]);
    assert.deepEqual(service.traffic(1).items.map(({ id, views, resource }) => ({
      id, views, linkSources: resource?.linkSources,
    })), [{ id: post.id, views: 792, linkSources: ["回复"] }]);
    assert.deepEqual(service.filterAuditPage(1).items.map(({ post, reason }) => [post.id, reason.kind]), [
      ["503", "recentResource"], ["504", "recentResource"], ["501", "recentDetailLink"],
    ]);
  } finally {
    service.dispose();
    db.close();
  }
});

test("历史扫描可按30天累计浏览收录资源帖，且保留资源核验", async () => {
  const db = new Database(":memory:");
  const now = Date.parse("2026-11-20T04:00:00Z");
  const post = (id: string, age: number) => ({
    id, title: `帖子 ${id}`, forum: "网盘资源", author: "", authorId: null,
    url: `https://tieba.baidu.com/p/${id}`,
    publishedAt: new Date(now - age * 24 * discoveryInterval).toISOString(),
    views: 560, replies: 0, likes: null, shares: null,
  });
  const checked: string[] = [];
  const service = fixedTimingDiscovery(db, {
    forum: async () => assert.fail("只运行历史扫描"),
    oldForum: async () => ({
      id: "1", page: 1, url: "", name: "网盘资源", hasMore: false,
      threads: [
        post("501", 7.47), post("502", 30), post("503", 30 + 1 / 24),
        post("504", 8),
      ],
    }),
    oldResource: async (id) => {
      checked.push(id);
      return { linkSources: id === "504" ? [] : ["正文"], keywords: [] };
    },
    views: async () => assert.fail("列表已有浏览量"),
    user: async () => assert.fail("样本无作者"),
    followed: async () => assert.fail("样本无作者"),
  }, () => now);
  try {
    service.saveRules({
      ...defaultTiebaDiscoveryRules, trafficThreshold: 200,
      oldTrafficMinTotalViews: 800, oldTrafficMinLifetimeDailyViews: 2,
    });
    service.startFilterAudit();
    service.scanOldForum();
    for (let i = 0; i < 150 && service.filterAuditPage(1).total < 2; i++) await sleep(10);
    assert.deepEqual(checked.sort(), ["501", "502", "504"]);
    assert.deepEqual(service.traffic(1).items.map(({ id }) => id).sort(), ["501", "502"]);
    assert.equal(service.oldTraffic(1, "screened").total, 0);
    assert.deepEqual(service.filterAuditPage(1).items.map(({ post, reason }) => [post.id, reason.kind]), [
      ["503", "oldTraffic"], ["504", "oldResource"],
    ]);
  } finally {
    service.dispose();
    db.close();
  }
});

test("手动入库优先收录满七天的老帖，再判断高流量和潜力帖", async () => {
  const db = new Database(":memory:");
  let now = Date.parse("2026-11-13T12:00:00Z");
  const hour = 3_600_000;
  const items: Record<string, [hours: number, views: number, linked: boolean]> = {
    "101": [200, 10000, false],
    "102": [30, 150, false],
    "103": [1, 6, false],
    "104": [168, 12000, true],
    "105": [240, 12000, false],
    "106": [1, 5, false],
    "107": [240, 2000, false],
    "108": [72, 500, true],
  };
  const publishedAt = now;
  const checked: string[] = [];
  const discovery = fixedTimingDiscovery(db, {
    forum: async () => assert.fail("手动入库不扫描贴吧"),
    user: async () => assert.fail("手动入库不扫描作者"),
    followed: async () => assert.fail("手动入库不扫描作者"),
    views: async () => assert.fail("详情已带最新浏览量"),
    oldResource: async (id) => {
      checked.push(id);
      return { linkSources: items[id][2] ? ["正文"] : [], keywords: [] };
    },
    thread: async (id) => {
      const [hours, views] = items[id];
      return {
        views,
        title: `帖子 ${id}`, forum: "网盘资源", author: "作者", uid: "1234",
        publishedAt: new Date(publishedAt - hours * hour).toISOString(),
        replies: 0, likes: 0, shares: null,
      };
    },
  }, () => now);
  try {
    assert.deepEqual(await discovery.importPost("101"), { kind: "traffic", already: false });
    assert.deepEqual(await discovery.importPost("101"), { kind: "traffic", already: true });
    assert.deepEqual(await discovery.importPost("102"), { kind: "potential", already: false });
    assert.deepEqual(await discovery.importPost("103"), { kind: "pending", already: false });
    assert.deepEqual(await discovery.importPost("104"), { kind: "oldTraffic", already: false });
    assert.deepEqual(await discovery.importPost("104"), { kind: "oldTraffic", already: true });
    assert.deepEqual(await discovery.importPost("105"), { kind: "traffic", already: false });
    await assert.rejects(discovery.importPost("106"), { code: "TIEBA_DISCOVERY_BELOW_THRESHOLD" });
    await assert.rejects(discovery.importPost("107"), { code: "TIEBA_DISCOVERY_NO_RESOURCE" });
    assert.equal((await discovery.importPost("108")).kind, "growthWatch");
    assert.equal(discovery.traffic(1).total, 2);
    assert.equal(discovery.potential(1).total, 1);
    assert.equal(discovery.pending(1).items[0]?.id, "103");
    assert.equal(discovery.oldTraffic(1, "screened").items[0]?.id, "104");
    now += 24 * hour;
    items["103"][1] = 100;
    assert.deepEqual(await discovery.importPost("103"), { kind: "potential", already: false });
    assert.equal(discovery.pending(1).total, 0);
    assert.equal(discovery.potential(1).total, 2);
    discovery.deleteOldResource("104");
    await assert.rejects(discovery.importPost("104"), { code: "TIEBA_DISCOVERY_DELETED" });
    assert.equal(discovery.oldTraffic(1, "screened").total, 0);
    assert.deepEqual(checked, ["101", "101", "104", "105", "107"]);
  } finally {
    discovery.dispose();
    db.close();
  }
});

test("流量帖合并分页，去重后刷新两类记录且不会重新显示手动删除的帖子", async () => {
  const db = new Database(":memory:");
  const now = Date.parse("2026-11-14T01:00:00Z");
  const day = 86_400_000;
  const discovery = fixedTimingDiscovery(db, {
    forum: async () => assert.fail("刷新本页不扫描贴吧"),
    user: async () => assert.fail("刷新本页不扫描作者"),
    followed: async () => assert.fail("刷新本页不扫描作者"),
    views: async () => assert.fail("刷新使用详情中的浏览量"),
    details: async (id) => ({
      views: 20_000 + Number(id), resource: { linkSources: ["正文"], keywords: [] },
    }),
  }, () => now);
  const reading = (id: string) => ({
    id, title: `帖子 ${id}`, forum: "网盘资源", url: `https://tieba.baidu.com/p/${id}`,
    publishedAt: new Date(now - 10 * day).toISOString(), checkedAt: now - day,
    author: "作者", views: 15_000, replies: 1, likes: 2, shares: 3, fromPotential: false,
  });
  try {
    for (let n = 101; n <= 112; n++) {
      const post = reading(String(n));
      db.run("INSERT INTO tieba_discovery_traffic VALUES (?, ?, ?, ?)",
        post.id, now - day + n, post.views, JSON.stringify(post));
    }
    const post = reading("112");
    db.run(`INSERT INTO tieba_discovery_old_traffic
      (thread_id, post, last_at, last_views, next_check_at, daily_added)
      VALUES (?, ?, ?, ?, ?, ?)`, post.id, JSON.stringify(post), now - 1000, post.views, now + day, 35);
    db.run(`INSERT INTO tieba_discovery_old_resource
      (thread_id, evidence, status, checked_at, admitted) VALUES (?, ?, 'linked', ?, 1)`,
      post.id, '{"linkSources":["正文"],"keywords":[]}', now - 1000);
    const first = discovery.trafficPosts(1, "all", "all");
    const second = discovery.trafficPosts(2, "all", "all");
    assert.equal(first.total, 12);
    assert.equal(first.items.length, 10);
    assert.equal(second.items.length, 2);
    assert.equal(new Set([...first.items, ...second.items].map(({ id }) => id)).size, 12);
    assert.deepEqual(first.items.slice(0, 2).map(({ id, kind }) => [id, kind]), [["112", "old"], ["111", "high"]]);
    assert.equal(discovery.trafficPosts(1, "high", "all").total, 11);
    assert.equal(discovery.trafficPosts(1, "qualified", "linked").total, 1);
    assert.equal(discovery.trafficPosts(1, "screened", "keywords").total, 0);
    const archivedAt = first.items[0].archivedAt;
    assert.deepEqual(await discovery.refresh({ kind: "trafficPosts", ids: ["112", "111"] }),
      { updated: 2, failed: 0 });
    assert.deepEqual(discovery.trafficPosts(1, "all", "all").items.slice(0, 2).map(({ views }) => views),
      [20_112, 20_111]);
    assert.equal(discovery.trafficPosts(1, "all", "all").items[0].archivedAt, archivedAt);
    for (const sort of ["views", "lifetimeDailyViews"] as const) {
      assert.deepEqual(discovery.trafficPosts(1, "all", "all", sort).items.slice(0, 2).map(({ id }) => id),
        ["112", "111"]);
      assert.deepEqual(discovery.trafficPosts(2, "all", "all", sort, "asc").items.map(({ id }) => id),
        ["111", "112"]);
    }
    assert.deepEqual(discovery.trafficPosts(2, "all", "all", "archivedAt", "asc").items.map(({ id }) => id),
      ["111", "112"]);
    assert.equal(discovery.trafficPosts(1, "all", "all", "dailyAddedViews", "asc").items[0].id, "112");
    assert.equal(discovery.trafficPosts(1, "qualified", "linked", "views").items[0].id, "112");
    discovery.deleteOldResource("112");
    assert.equal(discovery.trafficPosts(1, "all", "all").total, 11);
    assert.equal(db.get<{ count: number }>("SELECT count(*) count FROM tieba_discovery_traffic")?.count, 12);
    assert.deepEqual(await discovery.refresh({ kind: "trafficPosts", ids: ["112"] }), { updated: 0, failed: 1 });
  } finally {
    discovery.dispose();
    db.close();
  }
});

test("流量帖复查未通过时按流量帖来源回收，缺读数不影响原列表", async () => {
  const db = new Database(":memory:");
  const now = Date.parse("2026-11-14T01:00:00Z");
  const service = fixedTimingDiscovery(db, {
    forum: async () => assert.fail("无需扫描贴吧"),
    user: async () => assert.fail("无需查询作者"),
    followed: async () => assert.fail("无需读取关注"),
    views: async () => assert.fail("无需额外读取浏览量"),
    details: async (id) => ({
      views: id === "103" ? null : id === "102" ? 1500 : 30,
      resource: { linkSources: [], keywords: id === "102" ? ["资源"] : [] },
    }),
  }, () => now);
  const post = (id: string) => ({
    id, title: `帖子 ${id}`, forum: "网盘资源", author: "", url: `https://tieba.baidu.com/p/${id}`,
    publishedAt: new Date(now - 10 * 24 * discoveryInterval).toISOString(),
    views: 15000, checkedAt: now - 1000,
  });
  try {
    for (const id of ["101", "103"]) db.run("INSERT INTO tieba_discovery_traffic VALUES (?, ?, ?, ?)", id, now - 1000, 15000, JSON.stringify(post(id)));
    db.run(`INSERT INTO tieba_discovery_old_traffic (thread_id, post, last_at, last_views, next_check_at) VALUES (?, ?, ?, ?, ?)`,
      "102", JSON.stringify(post("102")), now - 1000, 15000, now);
    db.run(`INSERT INTO tieba_discovery_old_resource (thread_id, evidence, status, checked_at, admitted) VALUES (?, ?, 'linked', ?, 1)`,
      "102", '{"linkSources":["正文"],"keywords":[]}', now - 1000);
    assert.deepEqual(await service.refresh({ kind: "trafficPosts", ids: ["101", "102", "103"] }), { updated: 2, failed: 1 });
    assert.deepEqual(service.trafficPosts(1, "all", "all").items.map(({ id }) => id), ["103"]);
    assert.deepEqual(service.recycledPage(1).items.map(({ post, source, reason }) => [post.id, source, reason]), [
      ["102", "traffic", "resource"], ["101", "traffic", "belowThreshold"],
    ]);
  } finally {
    service.dispose();
    db.close();
  }
});

test("流量帖手动入库标记按帖子保存，支持老帖、累计高流量和取消标记", async () => {
  const { app, cleanup } = await fixture();
  const now = Date.parse("2026-11-24T00:00:00Z");
  const makePost = (id: string) => ({
    id, title: `帖子 ${id}`, url: `https://tieba.baidu.com/p/${id}`, forum: "网盘资源",
    publishedAt: "2026-11-14T00:00:00Z", checkedAt: now, views: 12000,
  });
  const list = async () => await app.invoke("tieba.discovery.trafficPosts", { page: 1, view: "all" }) as ReturnType<TiebaResourceDiscovery["trafficPosts"]>;
  const mark = (id: string, recorded: boolean) => app.invoke("tieba.discovery.setResourceRecorded", { id, recorded });
  try {
    app.db.run("INSERT INTO tieba_discovery_traffic VALUES (?, ?, ?, ?)",
      "101", now, 12000, JSON.stringify(makePost("101")));
    app.db.run(`INSERT INTO tieba_discovery_old_traffic (thread_id, post, last_at, last_views, next_check_at)
      VALUES (?, ?, ?, ?, ?)`, "102", JSON.stringify(makePost("102")), now, 12000, now + discoveryInterval);
    app.db.run(`INSERT INTO tieba_discovery_old_resource (thread_id, evidence, status, checked_at, admitted)
      VALUES (?, ?, 'linked', ?, 1)`, "102", '{"linkSources":["正文"],"keywords":[]}', now);
    const marks = (posts: Awaited<ReturnType<typeof list>>) => posts.items.map(({ id, resourceRecorded }) => [id, resourceRecorded]).sort();
    assert.deepEqual(marks(await list()), [["101", false], ["102", false]]);
    await mark("101", true);
    await mark("102", true);
    await mark("102", true);
    await assert.rejects(mark("999", true), { code: "TIEBA_DISCOVERY_POST_NOT_FOUND" });
    const reopenedDb = new Database(app.db.path);
    const reopened = fixedTimingDiscovery(reopenedDb);
    try {
      assert.deepEqual(marks(reopened.trafficPosts(1, "all", "all")), [["101", true], ["102", true]]);
    } finally {
      reopened.dispose();
      reopenedDb.close();
    }
    await mark("102", false);
    assert.deepEqual(marks(await list()), [["101", true], ["102", false]]);
  } finally {
    await cleanup();
  }
});

test("近期增长读数不受已有待观察数量限制，跨巡查间隔仍能入库", async () => {
  const db = new Database(":memory:");
  const start = Date.parse("2026-11-13T12:00:00Z");
  const hour = 3_600_000;
  let now = start;
  let failOldHandoff = true;
  const views: Record<string, number> = { "501": 90, "502": 90, "503": 90, "504": 90, "505": 90, "506": 0, "507": 90 };
  const ages: Record<string, number> = { "501": 72, "502": 72, "503": 167, "504": 72, "505": 167, "506": 1, "507": 72 };
  const thread = (id: string) => ({
    id, views: views[id], title: `百度网盘分享 ${id}`, forum: "网盘资源",
    author: "", url: `https://tieba.baidu.com/p/${id}`,
    publishedAt: new Date(start - ages[id] * hour).toISOString(),
    replies: 0, likes: 0, shares: null,
    resource: { linked: false, keys: [id === "507" ? "502" : id] },
  });
  db.setSetting("tieba.resourceDiscovery.v1", {
    seeds: ["网盘资源"], sources: [{ name: "网盘资源", status: "seed", scannedAt: null }],
    authors: {}, lastRun: null,
    posts: Array.from({ length: 1500 }, (_, i) => ({
      ...thread("501"), id: String(1000 + i), views: 6,
      publishedAt: new Date(start - 23 * hour).toISOString(), checkedAt: start,
      baseline: { at: start, views: 6 }, pendingSince: start, growth: null,
      keys: [], uid: null, linked: false, streak: 0,
    })),
  });
  const service = fixedTimingDiscovery(db, {
    forum: async ({ name, page, pageSize }) => ({
      id: "10", name, url: "", page, hasMore: true, totalPages: pageSize ? 20 : 50,
      threads: pageSize ? page < 10
        ? [thread("506")]
        : ["502", "503", "507"].map(thread) : [thread("506")],
    }),
    user: async () => assert.fail("样本没有作者 UID"),
    followed: async () => assert.fail("样本没有作者 UID"),
    views: async (id) => {
      if (id === "505" && failOldHandoff) throw new Error("临时读取失败");
      return views[id] ?? null;
    },
    thread: async (id) => ({ ...thread(id), uid: null }),
  }, () => now);
  async function scan() {
    service.scan();
    for (let i = 0; i < 50 && service.snapshot().busy; i++) await sleep(5);
    assert.equal(service.snapshot().busy, false);
  }
  try {
    service.saveRules({
      ...defaultTiebaDiscoveryRules, trafficThreshold: 200, recentGrowthMinDailyViews: 48,
      oldResourceCheckEnabled: false,
    });
    assert.equal((await service.importPost("501")).kind, "growthWatch");
    assert.equal((await service.importPost("504")).kind, "growthWatch");
    assert.equal((await service.importPost("505")).kind, "growthWatch");
    await scan();
    assert.equal(service.potential(1).total, 0);
    now = start + 15 * 60_000;
    views["501"] = 92;
    assert.equal((await service.importPost("501")).kind, "growthWatch");
    now = start + hour;
    views["503"] = 1001;
    views["504"] = 91;
    const below = await service.importPost("504");
    assert.equal(below.kind, "growthWatch");
    assert.equal(below.measuredDailyGrowth, 24);
    assert.equal((await service.importPost("501")).kind, "potential");
    now = start + 4 * hour;
    views["502"] = 98;
    views["507"] = 98;
    views["505"] = 1000;
    await scan();
    const posts = service.potential(1).items;
    assert.deepEqual(posts.map((post) => post.id).sort(), ["501", "502", "507"]);
    assert(posts.every((post) => post.first.recentGrowth?.hourly === 2));
    assert.equal(posts.find((post) => post.id === "502")?.first.recentGrowth?.from, start);
    assert.deepEqual(service.oldTraffic(1, "screened").items.map(({ id }) => id), ["503"]);
    failOldHandoff = false;
    now += hour;
    await scan();
    assert.deepEqual(service.oldTraffic(1, "screened").items.map(({ id }) => id).sort(), ["503", "505"]);
    assert.deepEqual(service.potential(1, true).items.map(({ id }) => id).sort(), ["501", "502", "507"]);
    assert.equal(service.traffic(1).items.some(({ id }) => id === "503" || id === "505"), false);
    assert.equal(db.get<{ count: number }>(
      "SELECT count(*) AS count FROM tieba_discovery_traffic WHERE thread_id IN ('503','505')",
    )?.count, 0);
    assert.equal(service.potential(1, true).items.find(({ id }) => id === "502")?.confirmedGrowth?.delta, 8);
  } finally {
    service.dispose();
    db.close();
  }
});

test("两种随机间隔独立保存，重开接续并保留简短扫描日志", async (t) => {
  const db = new Database(":memory:");
  const at = Date.parse("2026-11-12T03:00:00Z");
  const minute = 60_000;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: at });
  db.setSetting("tieba.resourceDiscovery.v1", {
    seeds: ["网盘资源"],
    sources: [
      { name: "网盘资源", status: "seed", scannedAt: at },
      {
        name: "资料分享",
        via: { forum: "网盘资源", reason: "posted" },
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
    resourceEvidence("今天是太阳雨 超清画质 全集已完结 官方中字", "夸克链接", [])?.linked,
    false,
    "列表摘要只写「夸克」，标题提供分享线索时仍应纳入发现",
  );
  assert.equal(resourceEvidence("这里讨论夸克浏览器", "", []), undefined);
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

test("老帖资源校验排除单独的资源一词，接受其他指定关键词和分享标记", () => {
  const evidence = (text: string) => oldResourceEvidence([{ source: "正文", text }]);
  assert.equal(isOldResource(evidence("漫画里灭霸还有哪些资源？")), false);
  assert.equal(isOldResource(evidence("网盘资源")), true);
  for (const word of ["网盘", "云盘", "提取码", "百度", "夸克", "链接", "口令", "//pan."]) {
    assert.equal(isOldResource(evidence(`正文提到${word}即可命中`)), true, word);
  }
  const plainTextLink = evidence("//pan.baidu.com/s/example");
  assert.equal(plainTextLink.linkSources.length, 0);
  assert.equal(isOldResource(plainTextLink), true);
});

test("老帖列表排除已误收的仅资源关键词帖子，补上网盘证据后保留原浏览记录", () => {
  const db = new Database(":memory:");
  const service = fixedTimingDiscovery(db);
  const id = "11176487422";
  const at = Date.parse("2026-11-23T13:57:25Z");
  try {
    db.db.prepare(`
      INSERT INTO tieba_discovery_old_traffic (thread_id, post, last_at, last_views, next_check_at)
      VALUES (?, ?, ?, 2013, ?)
    `).run(id, JSON.stringify({ id, publishedAt: "2026-11-07T18:54:24.000Z", archivedAt: at }), at, at);
    db.db.prepare(`
      INSERT INTO tieba_discovery_old_resource (thread_id, evidence, status, checked_at, admitted)
      VALUES (?, '{"linkSources":[],"keywords":["资源"]}', 'keywords', ?, 1)
    `).run(id, at);

    assert.equal(service.snapshot().oldTraffic?.tracked, 0);
    assert.equal(service.oldTraffic(1, "screened").total, 0);
    assert.equal(service.trafficPosts(1, "all", "all").total, 0);

    db.db.prepare(`
      UPDATE tieba_discovery_old_resource SET evidence = '{"linkSources":["回复"],"keywords":["资源"]}',
      status = 'linked' WHERE thread_id = ?
    `).run(id);
    assert.equal(service.oldTraffic(1, "screened").items[0]?.views, 2013);
  } finally {
    service.dispose();
    db.close();
  }
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
    service.saveRules({ ...defaultTiebaDiscoveryRules, minHourlyViews: 8, pendingObservationHours: 1 });
    const first = await cycle();
    assert.equal(first.trending.length, 0);
    assert.equal(first.watching.length, 3);
    assert.equal(first.potentialCount, 1);
    const [original] = service.potential(1).items;
    assert.equal(original.id, "111");
    assert.equal(original.first.views, 25);
    assert.equal(original.first.hourlyViews, 25 / 3);
    assert.deepEqual(first.sources[1]?.via, { forum: "网盘资源", reason: "posted" });
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

test("监控按单帖最近一次平均浏览量判断，接受小数和等于门槛的读数", () => {
  const at = Date.parse("2026-11-12T03:00:00Z");
  const post = {
    id: "1",
    forum: "网盘资源",
    keys: ["资源"],
    publishedAt: new Date(at - 2 * discoveryInterval).toISOString(),
    checkedAt: at,
    views: 7,
    replies: 0,
    likes: null,
    shares: null,
  };
  const rules = { ...defaultTiebaDiscoveryRules, lookbackHours: 2, minHourlyViews: 3.5, trafficThreshold: 100, pendingObservationHours: 1 };
  const results = potentialSignals(
    [
      post,
      { ...post, id: "转帖", views: 8 },
      { ...post, id: "达标", keys: ["另一资源"], replies: 100 },
      { ...post, id: "缺读数", views: null },
      { ...post, id: "未达标", views: 6 },
      { ...post, id: "高流量", views: 100 },
    ],
    at,
    rules,
  );
  assert.deepEqual([...results.keys()], ["转帖", "达标"]);
  assert.equal(results.get("达标")?.hourlyViews, 3.5);
  assert.equal(potentialSignals([post], at + 1, rules).size, 0);
  assert.equal(potentialSignals([post], at, { ...rules, minHourlyViews: 3.51 }).size, 0);
});

test("旧配置保留观察期和高流量门槛，旧入库帖按最近的实际浏览速度复核", () => {
  const db = new Database(":memory:");
  const now = Date.parse("2026-11-12T03:00:00Z");
  const service = fixedTimingDiscovery(db, undefined, () => now);
  try {
    db.setSetting("tieba.resourceDiscovery.rules", {
      lookbackHours: 24, potentialThreshold: 99, trafficThreshold: 100,
    });
    const rules = { ...defaultTiebaDiscoveryRules, lookbackHours: 24, trafficThreshold: 100, pendingObservationHours: 12 };
    assert.deepEqual(service.snapshot().rules, rules);
    db.db.prepare(
      "INSERT INTO tieba_discovery_potential(thread_id, first_found_at, first_evidence, latest) VALUES (?, ?, ?, ?)",
    ).run(
      "1", now, JSON.stringify({ at: now, score: 0, views: 42 }),
      JSON.stringify({ id: "1", publishedAt: new Date(now - 12 * discoveryInterval).toISOString(), views: 42, checkedAt: now }),
    );
    assert.equal(service.potential(1).items[0].active, true);
    service.saveRules({ ...rules, minHourlyViews: 3.6 });
    assert.equal(service.potential(1).items[0].active, false);
    assert.equal(service.potential(1).total, 1);
  } finally {
    service.dispose();
    db.close();
  }
});

test("旧潜力帖在待观察到期后重新读取，未达标移入回收贴", async () => {
  const db = new Database(":memory:");
  const publishedAt = "2026-11-12T09:59:04.000Z";
  const published = Date.parse(publishedAt);
  const checkedAt = Date.parse("2026-11-12T10:29:33.335Z");
  let now = published + 23 * discoveryInterval;
  const checked: string[] = [];
  const service = fixedTimingDiscovery(db, {
    forum: async ({ name, page }) => ({ id: "1", name, page, hasMore: false, url: "", threads: [] }),
    user: async () => assert.fail("无需查询作者"),
    followed: async () => assert.fail("无需查询关注"),
    views: async (id) => { checked.push(id); return 12; },
  }, () => now);
  const post = {
    id: "101", title: "旧入库帖", forum: "网盘资源", author: "",
    url: "https://tieba.baidu.com/p/101", publishedAt, checkedAt,
    views: 12, replies: 0, likes: 0, shares: 0,
  };
  const first = { at: checkedAt, views: 12, hourlyViews: 12 * discoveryInterval / (checkedAt - published) };
  try {
    service.saveRules({ ...defaultTiebaDiscoveryRules, minHourlyViews: 5, trafficThreshold: 200 });
    db.run(
      "INSERT INTO tieba_discovery_potential (thread_id, first_found_at, first_evidence, latest) VALUES (?, ?, ?, ?)",
      post.id, first.at, JSON.stringify(first), JSON.stringify(post),
    );
    const key = "tieba.resourceDiscovery.v1";
    db.setSetting(key, {
      seeds: [post.forum], sources: [], authors: {}, lastRun: null,
      posts: [{
        ...post, uid: null, keys: [], linked: false, baseline: { at: checkedAt, views: 12 },
        growth: null, streak: 0, potential: first,
      }],
    });
    const scan = async () => {
      service.scan();
      for (let i = 0; i < 100 && service.isBusy; i++) await sleep(5);
      assert.equal(service.isBusy, false);
    };
    const [before] = service.potential(1).items;
    assert.equal(before.active, false);
    assert.equal(before.awaitingMatureReading, true);
    await scan();
    assert.deepEqual(checked, []);
    now += discoveryInterval;
    await scan();
    assert.deepEqual(checked, [post.id]);
    assert.equal(service.potential(1).total, 0);
    const [after] = service.recycledPage(1).items;
    assert.equal(after.post.id, post.id);
    assert.equal(after.post.views, 12);
    assert.equal(after.source, "potential");
  } finally {
    service.dispose();
    db.close();
  }
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
    service.saveRules({ ...defaultTiebaDiscoveryRules, minHourlyViews: 59, pendingObservationHours: 1 });
    service.setAuto(true);
    await advance(1);
    assert.equal(service.potential(1).total, 1);
    assert.equal(service.potential(1).items[0].active, true);
    await advance(discoveryInterval);
    assert.deepEqual(checked, ["123"]);
    const [post] = service.potential(1).items;
    assert.equal(post.first.views, 99);
    assert.equal(post.views, 120);
    assert.equal(post.active, true);
    await advance(discoveryInterval);
    assert.deepEqual(checked, ["123", "123"]);
    assert.equal(post.replies, 0);
    assert.equal(post.shares, null);
    assert.equal(service.potential(2).page, 1);
  } finally {
    service.dispose();
    db.close();
  }
});

test("曝光潜力合并近期页，过滤无效读数并按最新 50 篇计算", async () => {
  const db = new Database(":memory:");
  const now = Date.parse("2026-11-12T03:00:00Z");
  const pages: number[] = [];
  const post = (index: number, age: number, views: number | null) => ({
    id: String(index),
    title: index === 30 ? "网盘资源样本" : `帖子 ${index}`,
    forum: "网盘资源",
    author: "",
    url: `https://tieba.baidu.com/p/${index}`,
    publishedAt: new Date(now - age).toISOString(),
    views,
    replies: null,
    likes: null,
    shares: null,
  });
  const service = fixedTimingDiscovery(db, {
    forum: async ({ name, page }) => {
      pages.push(page);
      const threads = page === 4
        ? [post(100, 1, 9999)]
        : Array.from({ length: 20 }, (_, offset) => {
            const index = (page - 1) * 20 + offset + 1;
            if (index === 21) return post(1, 1, 9999);
            return post(index, index, index === 22 ? null : index);
          });
      return {
        id: "1", name, page, hasMore: page < 4, threads,
        url: "https://tieba.baidu.com/f?kw=网盘资源",
      };
    },
    user: async () => { throw new Error("无需查询作者"); },
    followed: async () => ({ visibility: "restricted" }),
    views: async () => null,
  }, () => now);
  try {
    service.scan();
    for (let i = 0; i < 100 && service.isBusy; i++) await sleep(5);
    assert.equal(service.isBusy, false);
    assert.deepEqual(pages, [1, 2, 3, 4]);
    const snapshot = service.snapshot();
    // Index 21 repeats 1, and 22 has no view count. Median indices are 27 and 28.
    assert.deepEqual(snapshot.sources[0].exposure, {
      sample: 50,
      hourly: 55,
      observedAt: now,
    });
    assert(snapshot.logs?.some(({ message }) =>
      message.includes("近期 3 页，补读第 4 页，共 60 篇 · 曝光样本 50 篇"),
    ));
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
      ...defaultTiebaDiscoveryRules,
      lookbackHours: 24,
      minHourlyViews: 90,
      pendingObservationHours: 0.5,
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
    assert.deepEqual(service.snapshot().sources[1]?.via, { forum: seed, reason: "posted" });
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
    service.saveRules({ ...defaultTiebaDiscoveryRules, minHourlyViews: 15, pendingObservationHours: 1 });
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
    assert.deepEqual(expansion.sources.at(-1)?.via, { forum: "资料分享101", reason: "posted" });
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

test("老帖同时通过两项初筛，离线后按实际读数间隔复查并识别持续增长", async () => {
  const db = new Database(":memory:");
  const start = Date.parse("2026-11-12T03:00:00Z");
  const day = 24 * discoveryInterval;
  let now = start;
  const thread = (id: string, days: number, views: number) => ({
    id, title: "网盘历史资料", author: "", forum: "网盘资源",
    url: `https://tieba.baidu.com/p/${id}`,
    publishedAt: new Date(start - days * day).toISOString(),
    views, replies: 0, likes: null, shares: null,
  });
  db.setSetting("tieba.resourceDiscovery.logs", Array.from({ length: 49 }, (_, i) => ({
    id: i + 1, at: start - 1, message: "之前的日志",
  })));
  const detailReads: string[] = [];
  const resourceReads: string[] = [];
  let retry700 = true;
  const readers: TiebaDiscoveryReaders = {
    forum: async ({ name, page }) => ({
      id: "1", name, page, url: "", hasMore: false, threads: [],
    }),
    oldForum: async ({ name, page }) => {
      return {
        id: "1", name, page, url: "", hasMore: false,
        threads: now === start ? [
          thread("700", 60, 2400), // Passes both gates without resource evidence.
          thread("701", 30, 999), // Only the daily average passes.
          thread("702", 120, 1000), // Only cumulative views pass.
          { ...thread("704", 20, 2500), title: "普通讨论" }, // Traffic qualifies but content does not.
          thread("703", 6.99, 5000), // Too new for this workflow.
        ] : [],
      };
    },
    oldResource: async (id) => {
      resourceReads.push(id);
      if (id === "700" && retry700) {
        retry700 = false;
        throw new AppError("TIEBA_ANALYSIS_NETWORK", "暂时断网");
      }
      return id === "700"
        ? { linkSources: ["回复"], keywords: ["夸克"] }
        : { linkSources: [], keywords: [] };
    },
    user: async () => assert.fail("无需读取作者"),
    followed: async () => assert.fail("无需读取关注"),
    views: async (id) => {
      detailReads.push(id);
      return now === start + 5 * day ? 2600 : 2950;
    },
  };
  let service = fixedTimingDiscovery(db, readers, () => now);
  const cycle = async (days: number) => {
    now = start + days * day;
    service.scan();
    for (let i = 0; i < 100 && service.isBusy; i++) await sleep(5);
    assert.equal(service.isBusy, false);
    return service.snapshot();
  };
  try {
    service.saveRules({ ...defaultTiebaDiscoveryRules, oldTrafficMinLifetimeDailyViews: 20 });
    const legacy = thread("699", 30, 2000);
    db.run(
      "INSERT INTO tieba_discovery_old_traffic (thread_id, post, last_at, last_views, next_check_at) VALUES (?, ?, ?, ?, ?)",
      legacy.id, JSON.stringify(legacy), start - day, legacy.views, start + 3 * day,
    );
    db.run(
      "INSERT INTO tieba_discovery_old_resource_queue (thread_id, reading, next_check_at) VALUES (?, ?, ?)",
      legacy.id, JSON.stringify({ post: legacy, at: start, views: legacy.views }), start,
    );
    assert.equal(service.oldTraffic(1, "screened").total, 0);
    service.scanOldForum();
    while (service.snapshot().historyProgress?.forum) await sleep(5);
    assert.equal(service.oldTraffic(1, "screened").total, 0);
    assert.equal(db.get<{ count: number }>("SELECT count(*) AS count FROM tieba_discovery_old_traffic")?.count, 1);
    for (let i = 0; i < 500 && service.snapshot().oldResourcePending; i++) await sleep(5);
    assert.deepEqual(resourceReads.toSorted(), ["699", "700", "700", "704"]);
    assert.equal(db.get("SELECT 1 FROM tieba_discovery_old_resource WHERE thread_id = '699' AND checked_at IS NOT NULL") != null, true);
    assert.equal(db.get("SELECT 1 FROM tieba_discovery_old_resource_queue WHERE thread_id = '699'"), undefined);
    assert.equal(db.get("SELECT 1 FROM tieba_discovery_old_traffic WHERE thread_id = '704'"), undefined);
    assert.deepEqual(service.snapshot().oldTraffic, { tracked: 1, total: 0 });
    assert.equal(service.oldTraffic(1, "screened").items[0]?.dailyAddedViews, null);
    assert.deepEqual(service.oldTraffic(1).items, []);
    assert.equal(service.oldTraffic(1, "screened", "keywords").total, 0);
    assert.equal(service.oldTraffic(1, "screened", "pending").total, 0);
    assert.deepEqual(service.oldTraffic(1, "screened", "linked").items[0].resource, {
      checked: true, linkSources: ["回复"], keywords: ["网盘", "夸克"],
    });
    assert.equal(service.oldTraffic(1, "qualified", "linked").total, 0);
    await cycle(0);
    assert.deepEqual((await cycle(2)).oldTraffic, { tracked: 1, total: 0 });
    assert.deepEqual(detailReads, []);
    service.dispose();
    service = fixedTimingDiscovery(db, readers, () => now);

    const first = await cycle(5);
    const measured = service.oldTraffic(1).items[0];
    assert.equal(first.oldTraffic?.total, 1);
    assert.equal(service.oldTraffic(1, "qualified", "linked").total, 1);
    assert.equal(measured.id, "700");
    assert.equal(measured.addedViews, 200);
    assert.equal(measured.dailyAddedViews, 40);
    assert.equal(measured.baselineAt, start);
    assert.equal(measured.checkedAt, start + 5 * day);
    assert.equal(measured.lifetimeDailyViews, 40);
    assert.equal(measured.sustained, false);
    assert.equal(first.trafficCount, 0);
    assert.equal(service.saveRules({ ...first.rules, oldTrafficMinViews: 40 }).oldTraffic?.total, 0);
    assert.equal(service.saveRules(first.rules).oldTraffic?.total, 1);
    const second = await cycle(12);
    const sustained = service.oldTraffic(1).items[0];
    assert.equal(sustained.dailyAddedViews, 50);
    assert.equal(sustained.baselineAt, measured.checkedAt);
    assert.equal(sustained.sustained, true);
    assert.deepEqual(detailReads, ["700", "700"]);

    const storedLogs = db.setting<{ id: number }[]>("tieba.resourceDiscovery.logs", []);
    assert.equal(storedLogs.length, 50);
    assert.deepEqual(second.logs?.map(log => log.id), storedLogs.map(log => log.id));
    assert(storedLogs[0].id > 1);
    service.dispose();
    service = fixedTimingDiscovery(db, readers, () => now);
    assert.deepEqual(service.oldTraffic(1).items, [sustained]);
    service.deleteOldResource("700");
    assert.deepEqual(service.snapshot().oldTraffic, { tracked: 0, total: 0 });
    assert.equal(db.get("SELECT 1 FROM tieba_discovery_old_resource_deleted WHERE thread_id = '700'") != null, true);
  } finally {
    service.dispose();
    db.close();
  }
});

test("贴吧跳过规则在第 50 篇无网盘线索处截断，并对命中和重复帖子分别处理", () => {
  const irrelevant = (start: number, count: number) => Array.from({ length: count }, (_, index) => ({
    id: String(start + index), title: "论坛资源与普通链接",
  }));
  const pinned = { id: "pinned", title: "网盘分享" };
  const first = scanForumResourcePage([pinned, ...irrelevant(1, 49)]);
  assert.equal(first.skip, false);
  assert.equal(first.progress.misses, 49);
  const next = scanForumResourcePage([pinned, ...irrelevant(49, 3), { id: "too-late", title: "网盘" }], first.progress);
  assert.equal(next.skip, true);
  assert.deepEqual(next.threads.map(({ id }) => id), ["pinned", "49", "50"]);

  const newClue = { id: "body-link", title: "普通帖子", oldResource: { linkSources: [], keywords: ["提取码"] } };
  const afterClue = scanForumResourcePage([newClue, ...irrelevant(50, 20)], first.progress);
  assert.equal(afterClue.skip, false);
  assert.equal(afterClue.progress.misses, 20);
});

test("巡查和扩散在达到 50 篇后停止当前吧的补读和增长取样，继续扫描下一吧", async () => {
  const db = new Database(":memory:");
  const now = Date.parse("2026-11-24T00:00:00Z");
  const requests: string[] = [];
  const readers: TiebaDiscoveryReaders = {
    forum: async ({ name, page, pageSize }) => {
      requests.push(`${name}:${page}:${pageSize ?? 20}`);
      const barren = name === "无网盘线索吧";
      return { id: "1", name, page, url: "", hasMore: barren, totalPages: barren ? 100 : undefined,
        threads: Array.from({ length: barren ? 20 : 1 }, (_, index) => ({
          id: String((barren ? 0 : 1000) + (page - 1) * 20 + index + 1), title: barren ? "普通讨论" : "网盘资料合集",
          forum: name, author: "", url: "", publishedAt: new Date(now - discoveryInterval).toISOString(),
          views: 0, replies: 0, likes: null, shares: null,
        })),
      };
    },
    user: async () => assert.fail("没有楼主需要扩散"),
    followed: async () => assert.fail("没有关注吧需要读取"),
    views: async () => assert.fail("无需补读浏览量"),
  };
  const service = fixedTimingDiscovery(db, readers, () => now);
  try {
    const forums = ["无网盘线索吧", "另一个吧"];
    service.saveSeeds(forums);
    const expected = ["无网盘线索吧:1:20", "无网盘线索吧:2:20", "无网盘线索吧:3:20", "另一个吧:1:20"];
    service.scan();
    for (let i = 0; i < 100 && service.isBusy; i++) await sleep(5);
    assert.deepEqual(requests, expected);
    db.setSetting("tieba.resourceDiscovery.v1", {
      ...db.setting("tieba.resourceDiscovery.v1", {}),
      sources: forums.map((name) => ({ name, status: "watch", scannedAt: null, addedAt: now })),
    });
    requests.length = 0;
    service.scan("expand");
    for (let i = 0; i < 100 && service.isBusy; i++) await sleep(5);
    assert.deepEqual(requests, expected);
    assert.ok(service.snapshot().logs?.some(({ message }) => /连续 50 篇.*跳过/.test(message)));
  } finally {
    service.dispose();
    db.close();
  }
});

test("历史扫描断点保存无网盘线索计数，恢复后达到 50 篇立即跳过", async () => {
  const db = new Database(":memory:");
  const now = Date.parse("2026-11-24T00:00:00Z");
  let failed = false;
  const requests: string[] = [];
  const readers: TiebaDiscoveryReaders = {
    forum: async () => assert.fail("只扫描历史帖"),
    oldForum: async ({ name, page }) => {
      requests.push(`${name}:${page}`);
      const barren = name === "无网盘线索吧";
      if (barren && page === 3 && !failed) { failed = true; throw new Error("暂时断网"); }
      return { id: "1", name, page, url: "", hasMore: barren,
        threads: Array.from({ length: barren ? 20 : 1 }, (_, index) => ({
          id: String((barren ? 0 : 1000) + (page - 1) * 20 + index + 1), title: "普通讨论",
          forum: name, author: "", url: "", publishedAt: new Date(now - 10 * 24 * discoveryInterval).toISOString(),
          views: 0, replies: 0, likes: null, shares: null,
        })),
      };
    },
    user: async () => assert.fail("没有楼主需要扩散"),
    followed: async () => assert.fail("没有关注吧需要读取"),
    views: async () => assert.fail("无需补读浏览量"),
  };
  let service = fixedTimingDiscovery(db, readers, () => now);
  async function scan() {
    service.scanOldForum();
    for (let i = 0; i < 300 && service.isBusy; i++) await sleep(10);
    assert.equal(service.isBusy, false);
  }
  try {
    service.saveSeeds(["无网盘线索吧", "另一个吧"]);
    await scan();
    service.dispose();
    service = fixedTimingDiscovery(db, readers, () => now);
    await scan();
    assert.equal(service.snapshot().historyProgress?.completed, 1);
    await scan();
    assert.deepEqual(requests, ["无网盘线索吧:1", "无网盘线索吧:2", "无网盘线索吧:3", "无网盘线索吧:3", "另一个吧:1"]);
  } finally {
    service.dispose();
    db.close();
  }
});

test("老帖连续翻页，失败后从断点恢复，扫完一个吧再扫描下一个", async () => {
  const db = new Database(":memory:");
  const start = Date.parse("2026-11-12T03:00:00Z");
  const day = 24 * discoveryInterval;
  let now = start;
  const requests: string[] = [];
  let recentRuns = 0;
  let releaseHistory: (() => void) | undefined;
  const post = (id: string, forum: string, age: number, authorId?: string) => ({
    id, forum, author: "", authorId, title: `https://pan.baidu.com/s/${id}`,
    url: `https://tieba.baidu.com/p/${id}`,
    publishedAt: new Date(start - age * day).toISOString(),
    views: 1000, replies: 0, likes: null, shares: null,
  });
  const readers: TiebaDiscoveryReaders = {
    forum: async ({ name, page }) => {
      recentRuns++;
      return { id: "1", name, page, url: "", hasMore: false, threads: [] };
    },
    oldForum: async ({ name, page }) => {
      requests.push(`${name}:${page}`);
      if (name === "网盘资源" && page === 1)
        await new Promise<void>((resolve) => { releaseHistory = resolve; });
      if (name === "网盘资源" && page === 3 && now === start) throw new Error("暂时断网");
      return {
        id: "1", name, page, url: "", hasMore: name === "网盘资源" && page < 5,
        threads: name === "网盘资源" && page === 4
          ? []
          : name === "网盘资源"
          ? [post(String(page), name, page === 1 ? 1 : 14, page === 5 ? "500" : undefined)]
          : [post("600", name, 20)],
      };
    },
    user: async ({ target }) => {
      assert.equal(target, "UID: 500");
      return {
        uid: "500", profileId: null, author: "作者", page: 1, hasMore: false,
        threads: [post("510", "新发现的吧", 30), post("600", "第二个种子吧", 20)],
      };
    },
    followed: async () => assert.fail("无需读取关注"),
    views: async () => assert.fail("尚未到复查日期"),
  };
  let service = fixedTimingDiscovery(db, readers, () => now);
  async function scan() {
    service.scanOldForum();
    for (let i = 0; i < 500 && service.isBusy; i++) await sleep(10);
    assert.equal(service.isBusy, false);
    return service.snapshot();
  }
  try {
    service.saveSeeds(["网盘资源", "第二个种子吧"]);
    const inFlight = scan();
    service.scan();
    for (let i = 0; i < 100 && service.snapshot().busy; i++) await sleep(5);
    assert.equal(recentRuns, 2);
    assert.equal(service.snapshot().busy, false);
    assert.equal(service.snapshot().historyProgress?.forum, "网盘资源");
    assert.equal(service.isBusy, true);
    releaseHistory?.();
    const interrupted = await inFlight;
    assert.deepEqual(requests, ["网盘资源:1", "网盘资源:2", "网盘资源:3"]);
    assert.equal(interrupted.oldTraffic?.tracked, 1);
    service.dispose();
    service = fixedTimingDiscovery(db, readers, () => now);
    now += discoveryInterval;
    const resumed = await scan();
    assert.deepEqual(requests.slice(3), ["网盘资源:3", "网盘资源:4", "网盘资源:5"]);
    assert.equal(resumed.oldTraffic?.tracked, 5);
    assert.equal(resumed.historyProgress?.completed, 1);
    assert.equal(resumed.historyProgress?.total, 3);
    assert.equal(resumed.trafficCount, 0);
    service.deleteOldResource("600");
    assert.equal(service.oldTraffic(1, "screened").items.some(({id}) => id === "600"), false);
    await scan();
    assert.equal(requests.at(-1), "第二个种子吧:1");
    assert.equal(service.oldTraffic(1, "screened").items.some(({id}) => id === "600"), false);
    const discovered = await scan();
    assert.equal(requests.at(-1), "新发现的吧:1");
    assert.equal(discovered.historyProgress?.completed, 3);
  } finally {
    service.dispose();
    db.close();
  }
});

test("关闭老帖资源校验后直接收录流量达标帖，重新开启后恢复核验", async () => {
  const db = new Database(":memory:");
  const now = Date.parse("2026-11-12T03:00:00Z");
  let resourceReads = 0;
  const forum = async ({ name, page }: { name: string; page: number }) => ({
    id: "1", name, page, url: "", hasMore: false,
    threads: Array.from({ length: 12 }, (_, index) => ({
      id: String(900 + index),
      title: "普通帖子",
      url: `https://tieba.baidu.com/p/${900 + index}`,
      forum: name,
      author: "",
      publishedAt: new Date(now - 8 * 24 * discoveryInterval).toISOString(),
      views: index === 11 ? 10 : 1000,
      replies: 0, likes: null, shares: null,
    })),
  });
  const service = fixedTimingDiscovery(db, {
    forum, oldForum: forum,
    oldResource: async () => { resourceReads++; return { keywords: [], linkSources: [] }; },
    user: async () => assert.fail("无需读取作者"),
    followed: async () => assert.fail("无需读取关注"),
    views: async () => assert.fail("已有浏览量"),
  }, () => now);
  try {
    assert.equal(service.snapshot().rules.oldResourceCheckEnabled, true);
    service.saveRules({ ...defaultTiebaDiscoveryRules, oldResourceCheckEnabled: false });
    service.scanOldForum();
    for (let i = 0; i < 100 && service.isBusy; i++) await sleep(5);
    assert.equal(service.snapshot().oldTraffic?.tracked, 11);
    assert.equal(service.oldTraffic(1, "screened").items.length, 10);
    assert.equal(service.oldTraffic(2, "screened").items.length, 1);
    assert.equal(resourceReads, 0);
    service.saveRules(defaultTiebaDiscoveryRules);
    assert.equal(service.snapshot().oldTraffic?.tracked, 0);
    for (let i = 0; i < 400 && service.snapshot().oldResourcePending; i++) await sleep(5);
    assert.equal(resourceReads, 11);
    assert.equal(service.snapshot().oldResourcePending, 0);
  } finally {
    service.dispose();
    db.close();
  }
});

test("老帖刷新只读取指定帖子，更新浏览量和资源线索并保留增长基线", async () => {
  const db = new Database(":memory:");
  const start = Date.parse("2026-11-12T03:00:00Z");
  let now = start;
  const ids: string[] = [];
  const evidence = { keywords: ["网盘"], linkSources: ["正文"] as const };
  const forum: TiebaDiscoveryReaders["forum"] = async ({ name, page }) => ({
    id: "1", name, page, url: "", hasMore: false,
    threads: ["901", "902"].map((id) => ({
      id, title: "历史帖子", forum: name, author: "", url: `https://tieba.baidu.com/p/${id}`,
      publishedAt: new Date(start - 8 * 24 * discoveryInterval).toISOString(),
      views: 1000, replies: 0, likes: null, shares: null,
      oldResource: { ...evidence, linkSources: [...evidence.linkSources] },
    })),
  });
  const service = fixedTimingDiscovery(db, {
    forum, oldForum: forum,
    details: async (id) => {
      ids.push(id);
      return { views: 1200, resource: { keywords: ["夸克"], linkSources: ["回复"] } };
    },
    user: async () => assert.fail("无需读取作者"),
    followed: async () => assert.fail("无需读取关注"),
    views: async () => assert.fail("详情应直接返回浏览量"),
  }, () => now);
  try {
    service.scanOldForum();
    for (let i = 0; i < 100 && service.isBusy; i++) await sleep(5);
    assert.equal(service.oldTraffic(1, "screened").total, 2);
    now += discoveryInterval;
    assert.deepEqual(await service.refresh({ kind: "oldTraffic", ids: ["901", "903"] }), { updated: 1, failed: 1 });
    assert.deepEqual(ids, ["901"]);
    const items = service.oldTraffic(1, "screened").items;
    assert.equal(items.find(({ id }) => id === "902")?.views, 1000);
    const refreshed = items.find(({ id }) => id === "901");
    assert.equal(refreshed?.views, 1200);
    assert.equal(refreshed?.checkedAt, now);
    assert.equal(refreshed?.observationAt, start);
    assert.equal(refreshed?.dailyAddedViews, null);
    assert.deepEqual(refreshed?.resource, { checked: true, keywords: ["夸克"], linkSources: ["回复"] });
  } finally {
    service.dispose();
    db.close();
  }
});

test("新帖先待观察，到期用新读数晋级或移除，高流量直接入库", async () => {
  const db = new Database(":memory:");
  const start = Date.parse("2026-11-12T03:00:00Z");
  let now = start;
  const checked: string[] = [];
  const thread = (id: string, hours: number, views: number) => ({
    id, title: `资源 ${id}`, forum: "网盘资源", author: "",
    url: `https://tieba.baidu.com/p/${id}`,
    publishedAt: new Date(start - hours * discoveryInterval).toISOString(),
    views, replies: 0, likes: null, shares: null,
    resource: { linked: true, keys: [id] },
  });
  const readers: TiebaDiscoveryReaders = {
    forum: async ({ name, page }) => ({
      id: "1", name, page, hasMore: false, url: "",
      threads: now === start ? [
        thread("101", 1, 6), thread("102", 1, 5), thread("103", 1, 8),
        thread("104", 1, 100), thread("105", 24, 72), thread("106", 1, 9),
      ] : [],
    }),
    user: async () => assert.fail("无需查询作者"),
    followed: async () => assert.fail("无需查询关注"),
    views: async (id) => {
      checked.push(id);
      if (id === "101" && now === start + 23 * discoveryInterval) return null;
      return id === "101" ? 75 : id === "106" ? 100 : 71;
    },
  };
  let service = fixedTimingDiscovery(db, readers, () => now);
  async function cycle(hours: number) {
    now = start + hours * discoveryInterval;
    service.scan();
    for (let i = 0; i < 100 && service.isBusy; i++) await sleep(5);
    assert.equal(service.isBusy, false);
    assert.deepEqual(service.snapshot().lastRun?.warnings, []);
  }
  try {
    service.saveRules({ ...defaultTiebaDiscoveryRules, trafficThreshold: 100 });
    await cycle(0);
    assert.equal(service.snapshot().rules.pendingObservationHours, 24);
    assert.equal(service.snapshot().pendingCount, 3);
    assert.deepEqual(service.pending(1).items.map((item) => item.id).sort(), ["101", "103", "106"]);
    assert.equal(service.pending(1).items[0].dueAt, start + 23 * discoveryInterval);
    assert.deepEqual(service.potential(1).items.map((item) => item.id), ["105"]);
    assert.deepEqual(service.traffic(1).items.map((item) => item.id), ["104"]);
    service.dispose();
    service = fixedTimingDiscovery(db, readers, () => now);
    await cycle(22);
    assert(!checked.includes("101"));
    assert.equal(service.snapshot().pendingCount, 3);
    await cycle(23);
    assert.equal(service.snapshot().pendingCount, 1);
    assert.equal(service.pending(1).items[0].id, "101");
    assert.deepEqual(service.traffic(1).items.map((item) => item.id), ["106", "104"]);
    await cycle(24);
    assert.equal(service.snapshot().pendingCount, 0);
    assert.deepEqual(service.potential(1).items.map((item) => item.id), ["101"]);
    assert.deepEqual(service.recycledPage(1).items.map(({ post, source }) => [post.id, source]).sort(), [
      ["103", "pending"], ["105", "potential"],
    ]);
    const [promoted] = service.potential(1).items;
    assert.equal(promoted.first.views, 75);
    assert.equal(promoted.first.at, start + 24 * discoveryInterval);
    assert.equal(checked.filter(id => id === "101").length, 2);
  } finally {
    service.dispose();
    db.close();
  }
});

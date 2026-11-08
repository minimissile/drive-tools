import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Database } from "../core/database";
import { BaiduDiscovery } from "../core/baidu-discovery";
import { AppError } from "../core/errors";
import { TrafficKnowledge } from "../core/traffic-knowledge";
import { baiduKeywordInputSchema } from "../shared/baidu-keywords";
import {
  discoverySeeds,
  discoveryInputSchema,
  type BaiduDiscoveryPort,
  type DiscoveryInput,
  type DiscoveryRun,
} from "../shared/baidu-discovery";

const input = (patch: Partial<DiscoveryInput> = {}): DiscoveryInput => ({
  seeds: ["画竹子教程"],
  sources: ["suggest", "related"],
  maxDepth: 1,
  maxQueries: 10,
  intervalMs: 1500,
  ...patch,
});
const fixture = (read: BaiduDiscoveryPort["read"]) => {
  const db = new Database(":memory:");
  const port: BaiduDiscoveryPort = {
    read,
    open: async () => {},
    isOpen: () => false,
    close: () => {},
  };
  const service = new BaiduDiscovery(db, { baiduDiscovery: port }, () => {});
  return {
    db,
    port,
    service,
    knowledge: new TrafficKnowledge(db),
    close: () => {
      service.close();
      db.close();
    },
  };
};
async function settled(service: BaiduDiscovery, id: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const run = service.get(id);
    if (run.status !== "running" && !service.isBusy) return run;
    await delay(20);
  }
  throw new Error("采词任务未在时限内结束");
}

test("输入按行及中英文分隔符去重，保留短语空格，拒绝无界扩词", () => {
  assert.deepEqual(
    discoverySeeds(" 画竹子教程\n画竹子教程，ＡＩ 绘画;AI 绘画；国画 入门"),
    ["画竹子教程", "AI 绘画", "国画 入门"],
  );
  assert.equal(
    discoveryInputSchema.safeParse(input({ maxQueries: 0 })).success,
    false,
  );
  assert.equal(
    discoveryInputSchema.safeParse(input({ sources: [] })).success,
    false,
  );
  assert.equal(
    discoveryInputSchema.safeParse(input({ maxDepth: 4 })).success,
    false,
  );
  assert.equal(
    discoveryInputSchema.safeParse(
      input({ seeds: ["一", "二"], maxQueries: 1 }),
    ).success,
    false,
  );
});

test("两种来源合并同词且保存全部来源；CSV、TXT都按词去重", async () => {
  const f = fixture(async (source) =>
    source === "suggest"
      ? ["竹子画法", "ＡＩ 绘画", "竹子画法"]
      : ["竹子画法", "国画入门"],
  );
  try {
    const started = f.service.start(input()),
      run = await settled(f.service, started.id);
    assert.equal(run.status, "completed");
    assert.equal(run.words.length, 3);
    assert.equal(
      run.words.find((w) => w.word === "竹子画法")?.origins.length,
      2,
    );
    assert.equal(f.service.list()[0].wordCount, 3);
    assert.equal(f.service.list()[0].completedCount, 1);
    const library = f.knowledge.list({ endpoint: "baidu-discovery" });
    assert.equal(library.total, 3);
    assert.equal(f.knowledge.overview().summary.queries, 2);
    assert.equal(f.knowledge.overview().summary.observations, 4);
    assert.ok(library.items.every((word) => word.source === "百度批量扩词"));
    assert.ok(
      library.items.every((word) => word.metrics.averageMonthPv === 10),
    );
    assert.ok(
      library.items.every(
        (word) => word.metrics.averageMonthPvSource === "默认值（非实测）",
      ),
    );
    assert.equal(
      library.items.find((word) => word.word === "竹子画法")?.observations,
      2,
    );
    const archive = f.knowledge.detail(library.items[0].queryId);
    assert.equal(archive.query.endpoint, "baidu-discovery");
    assert.deepEqual(archive.query.seeds, ["画竹子教程"]);
    assert.match(archive.response!, /baidu.com/);
    assert.match(
      f.knowledge.export({ endpoint: "baidu-discovery" }),
      /默认值（非实测）/,
    );
    f.service.list();
    f.service.get(run.id);
    assert.equal(f.knowledge.overview().summary.observations, 4);
    const csv = f.service.exportBytes(run.id, "csv").toString();
    assert.match(csv, /下拉联想词；相关搜索/);
    assert.equal(csv.split('"竹子画法"').length - 1, 1);
    assert.equal(
      f.service.exportBytes(run.id, "txt", ["国画入门"]).toString(),
      "\uFEFF国画入门\r\n",
    );
  } finally {
    f.close();
  }
});

test("相关搜索验证失败时保留联想词，继续只重试未完成来源", async () => {
  let verify = true;
  const calls: string[] = [];
  const f = fixture(async (source) => {
    calls.push(source);
    if (source === "related" && verify)
      throw new AppError("BAIDU_VERIFICATION", "请手动验证");
    return source === "suggest" ? ["竹子画法"] : ["国画入门"];
  });
  try {
    const start = f.service.start(input()),
      paused = await settled(f.service, start.id);
    assert.equal(paused.status, "waiting");
    assert.equal(paused.words.length, 1);
    assert.deepEqual(paused.queries[0].completedSources, ["suggest"]);
    assert.equal(f.knowledge.list({}).total, 1);
    verify = false;
    f.service.resume(start.id);
    const run = await settled(f.service, start.id);
    assert.equal(run.status, "completed");
    assert.deepEqual(calls, ["suggest", "related", "related"]);
    assert.equal(f.knowledge.overview().summary.observations, 2);
  } finally {
    f.close();
  }
});

test("广度扩词去重并服从查询上限，查询深度可追溯", async () => {
  const calls: string[] = [];
  const f = fixture(async (_source, word) => {
    calls.push(word);
    return word === "画竹子教程"
      ? ["竹子画法", "国画入门"]
      : ["画竹子教程", "竹子画法", "新词"];
  });
  try {
    const start = f.service.start(
        input({ sources: ["related"], maxDepth: 3, maxQueries: 2 }),
      ),
      run = await settled(f.service, start.id);
    assert.deepEqual(calls, ["画竹子教程", "竹子画法"]);
    assert.equal(run.queries.length, 2);
    assert.equal(run.limited, true);
    assert.ok(
      run.words
        .find((w) => w.word === "新词")
        ?.origins.some((o) => o.depth === 2),
    );
    assert.throws(() => f.service.expand(run.id, ["国画入门"]), /上限/);
  } finally {
    f.close();
  }
});

test("手动勾词只查询未查询词，原结果与根词保持", async () => {
  const calls: string[] = [];
  const f = fixture(async (_source, word) => {
    calls.push(word);
    return word === "画竹子教程" ? ["竹子画法"] : ["简笔画竹子"];
  });
  try {
    const start = f.service.start(input({ sources: ["suggest"] }));
    await settled(f.service, start.id);
    f.service.expand(start.id, ["竹子画法", "竹子画法"]);
    const run = await settled(f.service, start.id);
    assert.deepEqual(calls, ["画竹子教程", "竹子画法"]);
    assert.equal(run.words.length, 2);
    assert.equal(run.words[1].origins[0].seed, "画竹子教程");
    assert.equal(run.words[1].origins[0].depth, 2);
    assert.throws(() => f.service.expand(start.id, ["竹子画法"]), /均已查询/);
  } finally {
    f.close();
  }
});

test("暂停取消当前读取，多个任务互斥，跳过词会记录而非伪装成功", async () => {
  const f = fixture((_source, _word, signal) => delay(10000, [], { signal }));
  try {
    const start = f.service.start(input());
    assert.throws(() => f.service.start(input()), /运行中/);
    await delay(20);
    const paused = await f.service.pause(start.id);
    assert.equal(paused.status, "paused");
    assert.equal(paused.queries[0].status, "pending");
    f.service.skip(start.id);
    const skipped = await settled(f.service, start.id);
    assert.equal(skipped.status, "completed");
    assert.equal(skipped.queries[0].status, "skipped");
    assert.equal(skipped.words.length, 0);
  } finally {
    f.close();
  }
});

test("重启只恢复断点，不自动发送请求；损坏任务不阻止应用初始化", () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return [];
  });
  try {
    const run: DiscoveryRun = {
      id: "restart",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
      input: input(),
      queries: [
        {
          word: "画竹子教程",
          seed: "画竹子教程",
          depth: 0,
          status: "pending",
          message: "",
          completedSources: [],
        },
      ],
      words: [],
      removedKeys: [],
      materialPool: null,
      message: "",
      currentWord: "画竹子教程",
      limited: false,
    };
    f.db.run(
      "INSERT INTO api_cache(key,value,expires_at) VALUES(?,?,?)",
      "baidu-discovery:restart",
      JSON.stringify(run),
      "9999",
    );
    f.db.run(
      "INSERT INTO api_cache(key,value,expires_at) VALUES(?,?,?)",
      "baidu-discovery:broken",
      "invalid json",
      "9999",
    );
    const recovered = new BaiduDiscovery(
      f.db,
      { baiduDiscovery: f.port },
      () => {},
    );
    assert.equal(recovered.get("restart").status, "paused");
    assert.equal(calls, 0);
    assert.throws(() => recovered.list());
    recovered.close();
  } finally {
    f.close();
  }
});

test("历史扩词在启动时本地回填，删除词不回填、归档不依赖任务缓存且默认值不覆盖实测来源", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return ["竹子画法", "国画入门"];
  });
  let recovered: BaiduDiscovery | undefined;
  try {
    const start = f.service.start(input({ sources: ["suggest"] }));
    const run = await settled(f.service, start.id);
    f.service.removeWord(
      run.id,
      run.words.find((word) => word.word === "国画入门")!.key,
    );
    // Simulate the task-only storage used before discovery indexing was introduced.
    f.db.run("DELETE FROM traffic_items");
    f.db.run("DELETE FROM traffic_queries");
    f.knowledge.ingestBaidu({
      id: "measured",
      accountUid: "123456",
      input: baiduKeywordInputSchema.parse({
        accountId: "web_test",
        seeds: ["画竹子教程"],
      }),
      total: 1,
      fetchedAt: "2026-01-01T00:00:00.000Z",
      keywords: [
        {
          id: "measured-word",
          word: "竹子画法",
          source: "百度营销 · 关键词规划师",
          platform: "baidu",
          metrics: { averageMonthPv: 1200 },
          fetchedAt: "2026-01-01T00:00:00.000Z",
          sourceUpdatedAt: null,
        },
      ],
    });
    f.db.run(
      "INSERT INTO api_cache(key,value,expires_at) VALUES(?,?,?)",
      "baidu-discovery:broken",
      "invalid",
      "9999",
    );
    recovered = new BaiduDiscovery(f.db, { baiduDiscovery: f.port }, () => {});
    assert.equal(calls, 1);
    const library = f.knowledge.list({ endpoint: "baidu-discovery" });
    assert.equal(library.total, 1);
    assert.equal(library.items[0].word, "竹子画法");
    assert.equal(library.items[0].metrics.averageMonthPv, 10);
    assert.equal(
      f.knowledge.list({ endpoint: "baidu-keywords" }).items[0].metrics
        .averageMonthPv,
      1200,
    );
    f.knowledge.archiveDiscovery(recovered.get(run.id));
    assert.equal(f.knowledge.overview().summary.observations, 2);
    recovered.removeWord(
      run.id,
      library.items[0].word.toLocaleLowerCase("zh-CN"),
    );
    assert.equal(f.knowledge.list({ endpoint: "baidu-discovery" }).total, 1);
    f.db.run("DELETE FROM api_cache");
    assert.equal(f.knowledge.list({ endpoint: "baidu-discovery" }).total, 1);
  } finally {
    recovered?.close();
    f.close();
  }
});

test("扩词入库失败保留采集结果，下一次启动只重试本地入库", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return ["竹子画法"];
  });
  const original = f.db.run.bind(f.db);
  let recovered: BaiduDiscovery | undefined;
  try {
    f.db.run = (sql, ...values) => {
      if (sql.startsWith("INSERT INTO traffic_items")) throw Error("disk full");
      return original(sql, ...values);
    };
    const start = f.service.start(input({ sources: ["suggest"] }));
    const run = await settled(f.service, start.id);
    assert.equal(run.status, "completed");
    assert.equal(run.words.length, 1);
    assert.match(run.knowledgeWarning!, /无需重复采集/);
    assert.doesNotMatch(run.message, /入库失败/);
    assert.equal(f.knowledge.list({}).total, 0);
    f.db.run = original;
    recovered = new BaiduDiscovery(f.db, { baiduDiscovery: f.port }, () => {});
    assert.equal(calls, 1);
    assert.equal(recovered.get(run.id).knowledgeWarning, undefined);
    assert.doesNotMatch(recovered.get(run.id).message, /入库失败/);
    assert.equal(f.knowledge.list({}).total, 1);
  } finally {
    f.db.run = original;
    recovered?.close();
    f.close();
  }
});

test("百度实测月搜索量10边界及未知值规则，已收录低量词继续更新", () => {
  const f = fixture(async () => []);
  try {
    const result = {
      id: "threshold",
      accountUid: "123456",
      input: baiduKeywordInputSchema.parse({
        accountId: "web_test",
        seeds: ["画竹子教程"],
      }),
      total: 8,
      fetchedAt: "2026-11-07T00:00:00.000Z",
      keywords: [
        ["数值10", 10],
        ["字符串10", "10"],
        ["数值9", 9],
        ["字符串9", "9"],
        ["小于10", "<10"],
        ["零值", 0],
        ["未知", null],
        ["无效", "unknown"],
      ].map(([word, monthly]) => ({
        id: String(word),
        word: String(word),
        source: "百度营销 · 关键词规划师",
        platform: "baidu",
        metrics: { averageMonthPv: monthly },
        fetchedAt: "2026-11-07T00:00:00.000Z",
        sourceUpdatedAt: null,
      })),
    };
    assert.equal(f.knowledge.ingestBaidu(result).indexed, 2);
    assert.equal(f.knowledge.list({}).total, 2);
    const updated = {
      ...result,
      id: "threshold-update",
      fetchedAt: "2026-11-08T00:00:00.000Z",
      keywords: [{ ...result.keywords[0], metrics: { averageMonthPv: 9 } }],
    };
    assert.equal(f.knowledge.ingestBaidu(updated).refreshedBelowThreshold, 1);
    assert.equal(
      f.knowledge.list({ search: "数值10" }).items[0].metrics.averageMonthPv,
      9,
    );
  } finally {
    f.close();
  }
});

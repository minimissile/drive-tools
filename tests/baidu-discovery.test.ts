import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Database } from "../core/database";
import { BaiduDiscovery } from "../core/baidu-discovery";
import { AppError } from "../core/errors";
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
    verify = false;
    f.service.resume(start.id);
    const run = await settled(f.service, start.id);
    assert.equal(run.status, "completed");
    assert.deepEqual(calls, ["suggest", "related", "related"]);
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
      materialPool:null,
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

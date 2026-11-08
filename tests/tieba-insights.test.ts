import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../core/database";
import { AppError } from "../core/errors";
import { TiebaAutocareStore } from "../core/tieba-autocare/store";
import {
  TiebaInsights,
  stopTiebaInsightsForBackup,
} from "../core/tieba-insights/service";
import type {
  TiebaPublicationRef,
  TiebaVisibilityReading,
} from "../shared/tieba-insights";
import type { TiebaAutocareTarget } from "../shared/tieba-autocare";
import type { WebsiteAccount } from "../shared/website-accounts";
import type { AppPorts } from "../core/ports";
import type { WebsiteAccounts } from "../core/website-accounts";
import type { BrowserEnvironments } from "../core/browser-environments";
import type { BrowserEnvironmentQueue } from "../core/browser-environment-queue";

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "tieba-insights-"));
  const db = new Database(join(folder, "test.db"));
  let time = Date.parse("2026-11-07T02:00:00Z"),
    metricReads = 0,
    visibilityReads = 0,
    verifies = 0;
  let level: number | null = 2,
    experience: number | null = 10,
    followed: boolean | null | undefined,
    visibility: TiebaVisibilityReading["visibility"] = "visible";
  let failure: Error | null = null,
    during: (() => Promise<void>) | undefined,
    beforeQueue: (() => Promise<void>) | undefined;
  const account: WebsiteAccount = {
    id: "web_insights",
    provider: "tieba",
    uid: "111",
    alias: "复盘账号",
    status: "connected",
    createdAt: "",
    updatedAt: "",
  };
  const stamp = {
    environmentId: "env_insights",
    revision: 1,
    identityId: "identity_insights",
    identityRevision: 1,
  };
  const at = () => new Date(time).toISOString();
  const target = {
    id: "tiebatarget_insights",
    accountId: account.id,
    uid: "111",
    forumId: "101",
    name: "资料整理",
    url: "https://tieba.baidu.com/f?kw=资料整理",
    level,
    experience,
    signed: null,
    canSign: null,
    message: null,
    checkedAt: at(),
    source: "observed" as const,
    paused: false,
    pauseReason: null,
    syncedAt: at(),
    stamp: { ...stamp },
  };
  const targets = new TiebaAutocareStore(db);
  targets.saveTarget(target);
  let publication: TiebaPublicationRef = {
    id: "tiebareply_insights",
    kind: "reply",
    accountId: account.id,
    uid: "111",
    forumId: target.forumId,
    forumName: target.name,
    threadId: "1001",
    postId: "2001",
    title: "资料如何整理",
    url: "https://tieba.baidu.com/p/1001?pid=2001#2001",
    body: "可以先按使用场景建立索引，保留原始文件，逐步整理常用资料。",
    submittedAt: at(),
    submissionStatus: "verified",
  };
  const ports = {
    tieba: {
      readForum: async () => {
        metricReads++;
        await during?.();
        if (failure) throw failure;
        return { ...target, level, experience, followed, checkedAt: at() };
      },
    },
    tiebaInsights: {
      readVisibility: async () => {
        visibilityReads++;
        await during?.();
        if (failure) throw failure;
        return {
          visibility,
          checkedAt: at(),
          message:
            visibility === "visible"
              ? "官网可见"
              : "未找到准确原内容，原因未知",
        };
      },
    },
  } as unknown as AppPorts;
  const accounts = {
    get: () => account,
    verify: async () => {
      verifies++;
      return account;
    },
  } as unknown as WebsiteAccounts;
  const environments = {
    stamp: () => ({ ...stamp }),
    assertStamp: (_ref: unknown, expected: typeof stamp) => {
      if (JSON.stringify(stamp) !== JSON.stringify(expected))
        throw new AppError("ENVIRONMENT_CHANGED", "环境已变化");
    },
  } as unknown as BrowserEnvironments;
  const queue = {
    schedule: async (
      _refs: unknown,
      _label: unknown,
      action: () => Promise<unknown>,
      signal: AbortSignal,
    ) => {
      await beforeQueue?.();
      if (signal.aborted) throw new Error("已取消");
      return action();
    },
  } as unknown as BrowserEnvironmentQueue;
  const auto = {
    revision: 1,
    enabled: false,
    config: {
      targetIds: [target.id],
      mode: "publish" as "draft" | "publish",
      dailyLimit: 2,
    },
  };
  const saves: unknown[] = [];
  const automation = {
    snapshot: () => structuredClone(auto),
    save: (input: { revision: number; config: typeof auto.config }) => {
      if (input.revision !== auto.revision)
        throw new AppError("TIEBA_AUTOMATION_CHANGED", "版本冲突");
      saves.push(input);
      auto.config = input.config;
      auto.enabled = false;
      auto.revision++;
      return structuredClone(auto);
    },
  };
  const dependencies = {
    db,
    accounts,
    environments,
    queue,
    ports,
    automation: automation as never,
    publications: () => [publication],
    dataPath: folder,
    changed: () => {},
    clock: () => time,
  };
  let service = new TiebaInsights(dependencies);
  return {
    db,
    service,
    targets,
    account,
    stamp,
    auto,
    saves,
    set followed(value: boolean | null | undefined) {
      followed = value;
    },
    get metricReads() {
      return metricReads;
    },
    get visibilityReads() {
      return visibilityReads;
    },
    get verifies() {
      return verifies;
    },
    get time() {
      return time;
    },
    set time(value: number) {
      time = value;
    },
    get publication() {
      return publication;
    },
    set publication(value: TiebaPublicationRef) {
      publication = value;
    },
    set level(value: number | null) {
      level = value;
    },
    set experience(value: number | null) {
      experience = value;
    },
    set visibility(value: TiebaVisibilityReading["visibility"]) {
      visibility = value;
    },
    set failure(value: Error | null) {
      failure = value;
    },
    set during(value: (() => Promise<void>) | undefined) {
      during = value;
    },
    set beforeQueue(value: (() => Promise<void>) | undefined) {
      beforeQueue = value;
    },
    restart() {
      service.dispose();
      service = new TiebaInsights(dependencies);
      this.service = service;
    },
    async close() {
      service.dispose();
      try {
        db.close();
      } catch {}
      await rm(folder, { recursive: true, force: true });
    },
  };
}

test("贴吧复盘快照仅本地读取，提交成功与官网可见性分开，未知不补零", async () => {
  const f = await fixture();
  try {
    const s = f.service.snapshot();
    assert.equal(s.settings.autoReview, false);
    assert.equal(s.targets[0].history.length, 1);
    assert.equal(s.targets[0].deltaExperience, null);
    assert.equal(s.publications[0].submissionStatus, "verified");
    assert.equal(s.publications[0].visibility, "unknown");
    assert.equal(s.publications[0].checkedAt, null);
    assert.equal(f.verifies + f.metricReads + f.visibilityReads, 0);
  } finally {
    await f.close();
  }
});
test("贴吧等级历史只记录真实读数，增量来自两次读取，缺失仍为未知", async () => {
  const f = await fixture();
  try {
    f.time += 60000;
    f.level = 3;
    f.experience = 15;
    let s = await f.service.refresh({
      targetIds: ["tiebatarget_insights"],
      publicationIds: [],
    });
    assert.equal(s.targets[0].deltaExperience, 5);
    assert.equal(s.targets[0].deltaLevel, 1);
    assert.deepEqual(s.refreshResult?.succeeded, ["tiebatarget_insights"]);
    f.time += 60000;
    f.level = null;
    f.experience = null;
    s = await f.service.refresh({
      targetIds: ["tiebatarget_insights"],
      publicationIds: [],
    });
    assert.equal(s.targets[0].level, null);
    assert.equal(s.targets[0].experience, null);
    assert.equal(s.targets[0].deltaExperience, null);
    assert.equal(s.targets[0].history.length, 3);
  } finally {
    await f.close();
  }
});
test("贴吧所选等级刷新不顺带查发布，所选发布刷新不访问其他目标", async () => {
  const f = await fixture();
  try {
    await f.service.refresh({ targetIds: ["tiebatarget_insights"] });
    assert.equal(f.metricReads, 1);
    assert.equal(f.visibilityReads, 0);
    await f.service.refresh({ publicationIds: [f.publication.id] });
    assert.equal(f.metricReads, 1);
    assert.equal(f.visibilityReads, 1);
  } finally {
    await f.close();
  }
});
test("贴吧可见性未知不改变已核实提交，刷新失败显式返回且保留历史", async () => {
  const f = await fixture();
  try {
    await f.service.refresh({
      targetIds: [],
      publicationIds: [f.publication.id],
    });
    f.visibility = "unknown";
    f.time += 60000;
    let s = await f.service.refresh({
      targetIds: [],
      publicationIds: [f.publication.id],
    });
    assert.equal(s.publications[0].submissionStatus, "verified");
    assert.equal(s.publications[0].visibility, "unknown");
    const at = s.publications[0].checkedAt;
    f.failure = new Error("网络断开");
    f.time += 60000;
    s = await f.service.refresh({
      targetIds: [],
      publicationIds: [f.publication.id],
    });
    assert.equal(s.refreshResult?.failed.length, 1);
    assert.equal(s.publications[0].checkedAt, at);
    assert.equal(s.publications[0].submissionStatus, "verified");
  } finally {
    await f.close();
  }
});
test("贴吧复盘身份或环境在途变化不保存结果，原发布正文变化不覆盖旧证据", async () => {
  const f = await fixture();
  try {
    f.during = async () => {
      f.stamp.revision++;
    };
    let s = await f.service.refresh({
      targetIds: [],
      publicationIds: [f.publication.id],
    });
    assert.equal(s.refreshResult?.failed.length, 1);
    assert.equal(s.publications[0].checkedAt, null);
    f.during = async () => {
      f.publication = { ...f.publication, body: f.publication.body + "更新" };
    };
    s = await f.service.refresh({
      targetIds: [],
      publicationIds: [f.publication.id],
    });
    assert.equal(s.refreshResult?.failed.length, 1);
    assert.equal(s.publications[0].checkedAt, null);
  } finally {
    await f.close();
  }
});
test("贴吧自动延后复查默认不运行，启用后10分钟和24小时各一次，手动核验不重发", async () => {
  const f = await fixture();
  try {
    f.time += 10 * 60000;
    await f.service.tick();
    assert.equal(f.visibilityReads, 0);
    f.service.save({ revision: 1, autoReview: true });
    await f.service.tick();
    assert.equal(f.visibilityReads, 1);
    assert.equal(f.service.snapshot().publications[0].visibility, "visible");
    await f.service.tick();
    assert.equal(f.visibilityReads, 1);
    f.time = Date.parse(f.publication.submittedAt) + 24 * 60 * 60000;
    await f.service.tick();
    assert.equal(f.visibilityReads, 2);
    assert.equal(f.service.snapshot().publications[0].nextCheckAt, null);
    f.time += 60000;
    await f.service.tick();
    assert.equal(f.visibilityReads, 2);
  } finally {
    await f.close();
  }
});
test("贴吧过期复查不追赶，也不伪造官网读取时间，自动失败不无限重试", async () => {
  const f = await fixture();
  try {
    f.service.save({ revision: 1, autoReview: true });
    f.time += 3 * 60 * 60000;
    await f.service.tick();
    let s = f.service.snapshot();
    assert.equal(f.visibilityReads, 0);
    assert.equal(s.publications[0].checkedAt, null);
    assert.equal(
      s.publications[0].nextCheckAt,
      new Date(
        Date.parse(f.publication.submittedAt) + 24 * 60 * 60000,
      ).toISOString(),
    );
    f.publication = {
      ...f.publication,
      id: "tiebareply_new",
      submittedAt: new Date(f.time - 10 * 60000).toISOString(),
    };
    f.time += 60000;
    f.failure = new Error("官网不可用");
    await f.service.tick();
    assert.equal(f.visibilityReads, 1);
    assert.equal(f.service.snapshot().publications[0].checkedAt, null);
    f.time += 60000;
    await f.service.tick();
    assert.equal(f.visibilityReads, 1);
  } finally {
    await f.close();
  }
});
test("贴吧首个复查槽过期不追赶，24小时独立复查仍能执行", async () => {
  const f = await fixture();
  try {
    f.service.save({ revision: 1, autoReview: true });
    f.time += 3 * 60 * 60000;
    await f.service.tick();
    assert.equal(f.visibilityReads, 0);
    f.time = Date.parse(f.publication.submittedAt) + 24 * 60 * 60000;
    await f.service.tick();
    assert.equal(f.visibilityReads, 1);
    assert.equal(f.service.snapshot().publications[0].visibility, "visible");
    assert.equal(f.service.snapshot().publications[0].nextCheckAt, null);
  } finally {
    await f.close();
  }
});
test("贴吧自动复查排队后撤销开关或临时停表，旧授权不再读取或落库", async () => {
  for (const pause of [false, true]) {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      queued = new Promise<void>((resolve) => {
        entered = resolve;
      });
    try {
      f.service.save({ revision: 1, autoReview: true });
      f.time += 10 * 60000;
      f.beforeQueue = async () => {
        entered();
        await gate;
      };
      const pending = f.service.tick();
      await queued;
      if (pause) f.service.start(false);
      else f.service.save({ revision: 2, autoReview: false });
      release();
      await pending;
      assert.equal(f.visibilityReads, 0);
      assert.equal(f.service.snapshot().publications[0].checkedAt, null);
    } finally {
      release();
      await f.close();
    }
  }
});
test("贴吧第二次自动复查失败保留前次可见证据及其官方读取时间", async () => {
  const f = await fixture();
  try {
    f.service.save({ revision: 1, autoReview: true });
    f.time += 10 * 60000;
    await f.service.tick();
    const first = f.service.snapshot().publications[0];
    f.failure = new Error("网络断开");
    f.time = Date.parse(f.publication.submittedAt) + 24 * 60 * 60000;
    await f.service.tick();
    const latest = f.service.snapshot().publications[0];
    assert.equal(latest.visibility, "visible");
    assert.equal(latest.checkedAt, first.checkedAt);
    assert.match(latest.message, /本次自动复查未完成/);
    assert.equal(latest.submissionStatus, "verified");
  } finally {
    await f.close();
  }
});
test("贴吧首槽网络失败只消耗当前槽，24小时恢复后仍独立复查", async () => {
  const f = await fixture();
  try {
    f.service.save({ revision: 1, autoReview: true });
    f.time += 10 * 60000;
    f.failure = new Error("网络失败");
    await f.service.tick();
    assert.equal(f.visibilityReads, 1);
    f.time += 60000;
    await f.service.tick();
    assert.equal(f.visibilityReads, 1);
    f.failure = null;
    f.time = Date.parse(f.publication.submittedAt) + 24 * 60 * 60000;
    await f.service.tick();
    assert.equal(f.visibilityReads, 2);
    assert.equal(f.service.snapshot().publications[0].visibility, "visible");
  } finally {
    await f.close();
  }
});
test("贴吧复查排队跨过当前槽截止则不读取，仍保留后续独立槽", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    queued = new Promise<void>((resolve) => {
      entered = resolve;
    });
  try {
    f.service.save({ revision: 1, autoReview: true });
    f.time += 10 * 60000;
    f.beforeQueue = async () => {
      entered();
      await gate;
    };
    const pending = f.service.tick();
    await queued;
    f.time = Date.parse(f.publication.submittedAt) + 3 * 60 * 60000;
    release();
    await pending;
    assert.equal(f.visibilityReads, 0);
    assert.equal(f.service.snapshot().publications[0].checkedAt, null);
    assert.ok(f.service.snapshot().publications[0].nextCheckAt);
  } finally {
    release();
    await f.close();
  }
});
test("贴吧无主题ID的未知提交保留入口，不安排自动读取或把未知记删除", async () => {
  const f = await fixture();
  try {
    f.publication = {
      ...f.publication,
      kind: "topic",
      threadId: null,
      postId: null,
      url: null,
      submissionStatus: "uncertain",
    };
    f.service.save({ revision: 1, autoReview: true });
    f.time += 600000;
    await f.service.tick();
    assert.equal(f.visibilityReads, 0);
    let s = await f.service.refresh({
      targetIds: [],
      publicationIds: [f.publication.id],
    });
    assert.equal(s.publications.length, 1);
    assert.equal(s.publications[0].visibility, "unknown");
    assert.equal(s.publications[0].nextCheckAt, null);
    assert.equal(s.refreshResult?.failed.length, 1);
  } finally {
    await f.close();
  }
});
test("贴吧策略预设只改变草稿预算，保留目标且关闭自动意图，陈旧修订拒绝", async () => {
  const f = await fixture();
  try {
    f.auto.enabled = true;
    f.service.applyPreset({ preset: "conservative", automationRevision: 1 });
    assert.deepEqual(f.auto.config, {
      targetIds: ["tiebatarget_insights"],
      mode: "draft",
      dailyLimit: 1,
    });
    assert.equal(f.auto.enabled, false);
    assert.throws(
      () =>
        f.service.applyPreset({ preset: "standard", automationRevision: 1 }),
      { code: "TIEBA_AUTOMATION_CHANGED" },
    );
    assert.throws(() => f.service.save({ revision: 9, autoReview: true }), {
      code: "TIEBA_INSIGHTS_CHANGED",
    });
  } finally {
    await f.close();
  }
});
test("贴吧复盘退出后在途结果不落已关闭数据库，备份撤销自动复查", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    start = new Promise<void>((resolve) => {
      entered = resolve;
    });
  try {
    f.service.save({ revision: 1, autoReview: true });
    stopTiebaInsightsForBackup(f.db);
    assert.equal(f.service.snapshot().settings.autoReview, false);
    f.during = async () => {
      entered();
      await gate;
    };
    const operation = f.service.refresh({
      targetIds: [],
      publicationIds: [f.publication.id],
    });
    await start;
    f.service.dispose();
    f.db.close();
    release();
    await assert.rejects(operation, { code: "TIEBA_INSIGHTS_CLOSED" });
  } finally {
    release();
    await f.close();
  }
});

test("贴吧复盘读数刷新同时核实已关注，保留原请求与暂停且不扩执行范围", async () => {
  for (const relation of [true, false, null] as const) {
    const f = await fixture();
    try {
      const target = f.targets.target("tiebatarget_insights")!,
        at = new Date(f.time - 60000).toISOString();
      target.followIntent = {
        status: "uncertain",
        submittedAt: at,
        checkedAt: null,
        message: "旧关注结果未确认",
      };
      target.paused = true;
      target.pauseReason = "用户保持暂停";
      f.targets.saveTarget(target);
      const originalConfig = structuredClone(f.auto);
      f.followed = relation;
      f.time += 60000;
      const result = await f.service.refresh({
        targetIds: [target.id],
        publicationIds: [],
      });
      assert.deepEqual(result.refreshResult?.succeeded, [target.id]);
      const current = f.targets.target(target.id)!;
      assert.equal(current.source, relation === true ? "followed" : "observed");
      assert.equal(
        current.followIntent?.status,
        relation === true ? "verified" : "uncertain",
      );
      assert.equal(current.followIntent?.submittedAt, at);
      assert.equal(current.paused, true);
      assert.equal(current.pauseReason, "用户保持暂停");
      if (relation === true) {
        assert.match(current.followIntent!.message, /只读核实/);
        assert.equal(current.followIntent?.checkedAt, current.checkedAt);
      } else assert.equal(current.followIntent?.message, "旧关注结果未确认");
      assert.deepEqual(f.auto, originalConfig);
      assert.equal(f.metricReads, 1);
      assert.equal(f.visibilityReads, 0);
    } finally {
      await f.close();
    }
  }
});

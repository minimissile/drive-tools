import { tiebaPublishingIndexKey } from "../core/tieba-publishing/store";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../core/database";
import { AppError } from "../core/errors";
import { SecretStore } from "../core/secrets";
import { BrowserEnvironments } from "../core/browser-environments";
import { BrowserEnvironmentQueue } from "../core/browser-environment-queue";
import { WebsiteAccounts } from "../core/website-accounts";
import { TiebaAutocare, tiebaDay } from "../core/tieba-autocare/service";
import {
  TiebaAutocareStore,
  stopTiebaAutocareForBackup,
} from "../core/tieba-autocare/store";
import { verifiedTiebaFollowState } from "../core/tieba-autocare/follow-state";
import type { AppPorts } from "../core/ports";
import type { TiebaForumReading } from "../shared/tieba-autocare";
import {
  tiebaAutocareObserveSchema,
  tiebaAutocareFollowSchema,
  tiebaAutocareAddSchema,
} from "../shared/tieba-autocare";
import type { TiebaForumDiscoveryResult } from "../shared/tieba-forum-discovery";
import {
  normalizeTiebaForumName,
  tiebaForumInputName,
  tiebaInitialForums,
} from "../shared/tieba-forums";

test("贴吧签到与主题共用真实提交间隔，主题审核或未知时阻断同账号签到", async () => {
  const f = await fixture();
  try {
    await f.configure();
    const at = new Date(f.time).toISOString(),
      account = f.accounts.get(f.account.id);
    f.db.run(
      "INSERT INTO tieba_topic_drafts(id,target_id,uid,forum_id,status,version,submitted_at,body_hash,data) VALUES(?,?,?,?,?,?,?,?,?)",
      "tiebatopic_cross_gap",
      "tiebatarget_fixture",
      account.uid!,
      "101",
      "verified",
      1,
      at,
      "fixture",
      JSON.stringify({ accountId: account.id, submittedAt: at }),
    );
    await f.service.tick();
    assert.equal(f.submissions, 0);
    assert.equal(
      Date.parse(f.service.snapshot().tasks[0].plannedAt),
      f.time + 60000,
    );
    f.time += 60000;
    for (const status of ["pending_review", "uncertain"]) {
      f.db.run(
        "UPDATE tieba_topic_drafts SET status=? WHERE id=?",
        status,
        "tiebatopic_cross_gap",
      );
      await f.service.tick();
      assert.equal(f.submissions, 0);
    }
    f.db.run(
      "UPDATE tieba_topic_drafts SET status='verified' WHERE id=?",
      "tiebatopic_cross_gap",
    );
    await f.service.tick();
    assert.equal(f.submissions, 1);
  } finally {
    await f.close();
  }
});

test("贴吧签到与回复共用真实提交间隔，未知回复阻断同账号签到", async () => {
  const f = await fixture();
  try {
    await f.configure();
    const at = new Date(f.time).toISOString();
    f.db.run(
      "INSERT INTO tieba_reply_drafts(id,candidate_id,uid,thread_id,status,version,submitted_at,data) VALUES(?,?,?,?,?,?,?,?)",
      "tiebareply_cross_gap",
      "candidate_fixture",
      f.accounts.get(f.account.id).uid!,
      "800",
      "verified",
      1,
      at,
      JSON.stringify({ accountId: f.account.id, submittedAt: at }),
    );
    await f.service.tick();
    assert.equal(f.submissions, 0);
    assert.equal(f.service.snapshot().tasks[0].status, "pending");
    assert.equal(
      Date.parse(f.service.snapshot().tasks[0].plannedAt),
      f.time + 60000,
    );
    f.time += 60000;
    f.db.run(
      "UPDATE tieba_reply_drafts SET status='uncertain' WHERE id=?",
      "tiebareply_cross_gap",
    );
    await f.service.tick();
    assert.equal(f.submissions, 0);
    f.db.run(
      "UPDATE tieba_reply_drafts SET status='verified' WHERE id=?",
      "tiebareply_cross_gap",
    );
    await f.service.tick();
    assert.equal(f.submissions, 1);
  } finally {
    await f.close();
  }
});

test("贴吧签到最后检查点再次阻断在途新出现的回复未知和主题审核，不影响其他账号", async () => {
  const cases = [
    { kind: "reply", status: "uncertain" },
    { kind: "reply", status: "submitting" },
    { kind: "topic", status: "uncertain" },
    { kind: "topic", status: "submitting" },
    { kind: "topic", status: "pending_review" },
    { kind: "topic", status: "uncertain", unrelated: true },
  ];
  for (const item of cases) {
    const f = await fixture();
    try {
      await f.configure();
      f.before = async () => {
        const at = new Date(f.time - 120000).toISOString();
        const uid = item.unrelated
          ? "other-owner"
          : f.accounts.get(f.account.id).uid!;
        const data = JSON.stringify({
          accountId: item.unrelated ? "web_other" : f.account.id,
          submittedAt: at,
        });
        if (item.kind === "reply")
          f.db.run(
            "INSERT INTO tieba_reply_drafts(id,candidate_id,uid,thread_id,status,version,submitted_at,data) VALUES(?,?,?,?,?,?,?,?)",
            "reply_during_checkin",
            "candidate_during_checkin",
            uid,
            "1001",
            item.status,
            1,
            item.status === "submitting" ? null : at,
            data,
          );
        else
          f.db.run(
            "INSERT INTO tieba_topic_drafts(id,target_id,uid,forum_id,status,version,submitted_at,body_hash,data) VALUES(?,?,?,?,?,?,?,?,?)",
            "topic_during_checkin",
            "target_during_checkin",
            uid,
            "101",
            item.status,
            1,
            item.status === "submitting" ? null : at,
            "fixture",
            data,
          );
      };
      await f.service.tick();
      const task = f.service.snapshot().tasks[0];
      assert.equal(
        f.submissions,
        item.unrelated ? 1 : 0,
        `${item.kind}/${item.status}`,
      );
      if (!item.unrelated) {
        assert.equal(task.submittedAt, null);
        assert.equal(task.status, "failed");
        assert.match(task.message, /回复或主题.*请先核对原记录/);
        await f.service.tick();
        assert.equal(f.submissions, 0);
      }
    } finally {
      await f.close();
    }
  }
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "panxu-tieba-autocare-"));
  const db = new Database(join(dir, "panxu.db"));
  const identities = new Map<string, string>();
  const signed = new Set<string>();
  let time = Date.parse("2026-11-07T02:00:00Z"),
    submissions = 0,
    reads = 0;
  let unknown = false,
    before: (() => Promise<void>) | undefined,
    duringRead: (() => Promise<void>) | undefined;
  let forums = ["101", "102"];
  let observeDuring: ((name: string) => Promise<void>) | undefined;
  let relation: boolean | null | undefined;
  const relationships = new Map<string, boolean | null>();
  let finds = 0,
    findDuring: (() => Promise<void>) | undefined,
    findResult: Partial<TiebaForumDiscoveryResult> | undefined;
  let followFailure: Error | undefined,
    beforeFollow: (() => Promise<void>) | undefined,
    afterFollow: (() => Promise<void>) | undefined;
  let followCalls = 0,
    follows = 0,
    followConfirmed = true;
  const observedNames: string[] = [];
  const reading = (forumId: string): TiebaForumReading => ({
    forumId,
    name: `测试${forumId}`,
    url: `https://tieba.baidu.com/f?kw=${encodeURIComponent(`测试${forumId}`)}`,
    level: 2,
    experience: 8,
    signed: signed.has(forumId),
    canSign: true,
    message: null,
    checkedAt: new Date(time).toISOString(),
    followed: relationships.has(forumId)
      ? relationships.get(forumId)
      : relation,
    personalStatsMessage:
      relation === false ? "尚未关注，本吧个人等级未展示。" : null,
    memberCount: 123,
    postCount: 456,
    threadCount: 78,
  });
  const ports = {
    browserEnvironments: {
      prepare: async () => {},
      assertIdle: async () => {},
      checkNetwork: async () => "203.0.113.10",
    },
    websiteSessions: {
      login: async () => {},
      clear: async () => {},
      invalidate: async () => {},
      status: async (account: { id: string }) => ({
        hasSession: true,
        uid: identities.get(account.id) ?? null,
        windowOpen: false,
        error: null,
      }),
      verify: async (account: { id: string }) => ({
        hasSession: true,
        uid: identities.get(account.id) ?? null,
        windowOpen: false,
        error: null,
      }),
    },
    tieba: {
      resolveForum: async (_account: unknown, _uid: string, name: string) => {
        observedNames.push(name);
        reads++;
        await observeDuring?.(name);
        return {
          ...reading(
            name === "测试101" ? "101" : name === "测试102" ? "102" : "103",
          ),
          name,
          url: `https://tieba.baidu.com/f?kw=${encodeURIComponent(name)}`,
        };
      },
      listForums: async () => {
        reads++;
        return forums.map(reading);
      },
      readForum: async (
        _a: unknown,
        _uid: string,
        forum: TiebaForumReading,
      ) => {
        reads++;
        await duringRead?.();
        return reading(forum.forumId);
      },
      checkIn: async (
        _a: unknown,
        _uid: string,
        forum: TiebaForumReading,
        checkpoint: () => Promise<void>,
      ) => {
        await before?.();
        await checkpoint();
        submissions++;
        signed.add(forum.forumId);
        if (unknown) throw new Error("官网提交后断线");
        return reading(forum.forumId);
      },
      followForum: async (
        _account: unknown,
        uid: string,
        forum: TiebaForumReading,
        checkpoint: () => Promise<void>,
      ) => {
        followCalls++;
        await beforeFollow?.();
        await checkpoint();
        follows++;
        await afterFollow?.();
        if (followFailure) throw followFailure;
        if (followConfirmed) relationships.set(forum.forumId, true);
        return {
          status: followConfirmed ? "followed" : "uncertain",
          uid,
          reading: reading(forum.forumId),
          checkedAt: new Date(time).toISOString(),
          message: followConfirmed
            ? "官网完整关注列表已核实"
            : "尚未查到此吧的明确关注关系",
        };
      },
      findForums: async (
        account: { id: string },
        _uid: string,
        keyword: string,
      ) => {
        finds++;
        await findDuring?.();
        const at = new Date(time).toISOString();
        return {
          accountId: account.id,
          keyword,
          items: [
            {
              name: "测试101",
              forumId: "101",
              url: "https://tieba.baidu.com/f?kw=测试101",
              description: "官网候选简介",
              memberCount: 123,
              postCount: null,
              threadCount: null,
              sampledThreads: 3,
              zeroReplyThreads: 2,
              latestActiveLabel: "11-07",
              checkedAt: at,
            },
          ],
          checkedAt: at,
          truncated: false,
          message: "已只读查找",
          ...findResult,
        };
      },
    },
  } as unknown as AppPorts;
  const secrets = new SecretStore(db, {
    available: () => true,
    encrypt: async (v) => v,
    decrypt: async (v) => v,
  });
  const environments = new BrowserEnvironments(
    db,
    secrets,
    ports,
    dir,
    () => {},
  );
  environments.setExternalNetworkChecker(async () => "203.0.113.10");
  const queue = new BrowserEnvironmentQueue(db, environments, () => {});
  const accounts = new WebsiteAccounts(
    db,
    ports,
    () => {},
    environments,
    queue,
  );
  const env = await environments.save({
    name: "贴吧测试环境",
    engine: "bitbrowser",
    profileId: "tieba-fixture",
  });
  const account = accounts.add("tieba", "贴吧测试账号", env.id);
  identities.set(account.id, "tieba-owner-1");
  await accounts.verify(account.id);
  const dependencies = {
    db,
    accounts,
    environments,
    queue,
    ports,
    dataPath: dir,
    changed: () => {},
    clock: () => time,
  };
  let service = new TiebaAutocare(dependencies);
  const configure = async (count = 1) => {
    await service.syncForums({ accountId: account.id });
    const snapshot = service.snapshot();
    service.save({
      revision: snapshot.revision,
      config: {
        targetIds: snapshot.targets.slice(0, count).map((target) => target.id),
      },
    });
    service.toggle({
      enabled: true,
      revision: service.snapshot().revision,
      confirmed: true,
    });
  };
  return {
    dir,
    dependencies,
    db,
    ports,
    environments,
    queue,
    accounts,
    account,
    identities,
    observedNames,
    get followCalls() {
      return followCalls;
    },
    get follows() {
      return follows;
    },
    set relation(value: boolean | null | undefined) {
      relation = value;
      relationships.clear();
    },
    get finds() {
      return finds;
    },
    set findDuring(value: typeof findDuring) {
      findDuring = value;
    },
    set findResult(value: typeof findResult) {
      findResult = value;
    },
    set followFailure(value: Error | undefined) {
      followFailure = value;
    },
    set beforeFollow(value: typeof beforeFollow) {
      beforeFollow = value;
    },
    set afterFollow(value: typeof afterFollow) {
      afterFollow = value;
    },
    set followConfirmed(value: boolean) {
      followConfirmed = value;
    },
    signed,
    get service() {
      return service;
    },
    reading,
    get time() {
      return time;
    },
    set time(value: number) {
      time = value;
    },
    get submissions() {
      return submissions;
    },
    get reads() {
      return reads;
    },
    set unknown(value: boolean) {
      unknown = value;
    },
    set before(value: (() => Promise<void>) | undefined) {
      before = value;
    },
    set duringRead(value: (() => Promise<void>) | undefined) {
      duringRead = value;
    },
    set forums(value: string[]) {
      forums = value;
    },
    set observeDuring(value: ((name: string) => Promise<void>) | undefined) {
      observeDuring = value;
    },
    configure,
    restart() {
      service.dispose();
      service = new TiebaAutocare(dependencies);
    },
    async close() {
      service.dispose();
      queue.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("贴吧：快照仅本地读取，同步不会自动选中新增关注吧，保存有修订冲突检查", async () => {
  const f = await fixture();
  try {
    const original = f.service.snapshot();
    assert.equal(f.reads, 0);
    assert.deepEqual(original.config.targetIds, []);
    await f.service.syncForums({ accountId: f.account.id });
    assert.equal(f.service.snapshot().targets.length, 2);
    assert.equal(f.service.snapshot().revision, original.revision);
    assert.deepEqual(f.service.snapshot().config.targetIds, []);
    f.service.save({
      revision: original.revision,
      config: { targetIds: [f.service.snapshot().targets[0].id] },
    });
    assert.throws(
      () =>
        f.service.save({
          revision: original.revision,
          config: { targetIds: [] },
        }),
      { code: "TIEBA_CONFIG_CHANGED" },
    );
    f.forums = ["101", "102", "103"];
    await f.service.syncForums({ accountId: f.account.id });
    assert.equal(f.service.snapshot().targets.length, 3);
    assert.equal(f.service.snapshot().config.targetIds.length, 1);
  } finally {
    await f.close();
  }
});

test("贴吧观察：名称严格规范、去重和首批候选，网址仅经官方首页转换工具", () => {
  assert.equal(
    normalizeTiebaForumName("  Ｏｆｆｉｃｅ  技巧  "),
    "Office 技巧",
  );
  assert.equal(
    normalizeTiebaForumName("酒吧"),
    "酒吧",
    "不盲目删除官方名称末尾的吧字",
  );
  assert.equal(tiebaInitialForums.length, 5);
  assert.equal(
    tiebaForumInputName(
      "https://tieba.baidu.com/f?kw=office%E6%8A%80%E5%B7%A7&ie=utf-8",
    ),
    "office技巧",
  );
  for (const invalid of [
    "",
    " \t ",
    "abc\n吧",
    "https://tieba.baidu.com/f?kw=test",
    "../test",
    "a".repeat(101),
  ])
    assert.throws(() => normalizeTiebaForumName(invalid));
  for (const invalid of [
    "http://tieba.baidu.com/f?kw=test",
    "https://example.com/f?kw=test",
    "https://tieba.baidu.com/p/123",
    "https://user:pass@tieba.baidu.com/f?kw=test",
  ])
    assert.throws(() => tiebaForumInputName(invalid));
  assert.deepEqual(
    tiebaAutocareObserveSchema.parse({
      accountId: "web_test",
      forumNames: [" 测试101 ", "测试101"],
    }).forumNames,
    ["测试101"],
  );
  assert.throws(() =>
    tiebaAutocareObserveSchema.parse({
      accountId: "web_test",
      forumNames: Array(6).fill("测试"),
    }),
  );
});

test("贴吧观察：只读新增目标不关注不签到，不扩大配置或排期，重复核验保持ID", async () => {
  const f = await fixture();
  try {
    const state = f.service.store.state();
    const result = await f.service.observe({
      accountId: f.account.id,
      forumNames: [" 测试101 ", "测试101", "测试102"],
    });
    assert.deepEqual(result.observation, {
      accountId: f.account.id,
      succeeded: ["测试101", "测试102"],
      failed: [],
    });
    assert.equal(result.targets.length, 2);
    assert.ok(result.targets.every((target) => target.source === "observed"));
    assert.deepEqual(f.service.store.state(), state);
    assert.equal(result.tasks.length, 0);
    assert.equal(f.submissions, 0);
    assert.deepEqual(f.observedNames, ["测试101", "测试102"]);
    const id = result.targets[0].id;
    await f.service.observe({
      accountId: f.account.id,
      forumNames: ["测试101"],
    });
    assert.equal(f.service.snapshot().targets[0].id, id);
    assert.equal(f.service.snapshot().targets.length, 2);
    assert.equal(
      f.service.snapshot().observation,
      undefined,
      "逐次读取结果不持久化到普通快照",
    );
  } finally {
    await f.close();
  }
});

test("贴吧观察：观察目标拒绝签到授权，官网关注同步升级沿用ID且默认仍未选择", async () => {
  const f = await fixture();
  try {
    const observed = await f.service.observe({
      accountId: f.account.id,
      forumNames: ["测试101"],
    });
    const target = observed.targets[0];
    assert.throws(
      () =>
        f.service.save({
          revision: observed.revision,
          config: { targetIds: [target.id] },
        }),
      { code: "TIEBA_OBSERVED_NOT_FOLLOWED" },
    );
    f.service.store.saveState({
      ...f.service.store.state(),
      config: { targetIds: [target.id] },
    });
    assert.throws(
      () =>
        f.service.toggle({
          revision: observed.revision,
          enabled: true,
          confirmed: true,
        }),
      { code: "TIEBA_OBSERVED_NOT_FOLLOWED" },
    );
    f.service.store.saveState({
      ...f.service.store.state(),
      config: { targetIds: [] },
    });
    f.service.pauseTarget({
      targetId: target.id,
      paused: true,
      revision: observed.revision,
    });
    f.forums = ["101"];
    await f.service.syncForums({ accountId: f.account.id });
    const upgraded = f.service.snapshot();
    assert.equal(upgraded.targets[0].id, target.id);
    assert.equal(upgraded.targets[0].source, "followed");
    assert.equal(upgraded.targets[0].paused, true);
    assert.deepEqual(upgraded.config.targetIds, []);
    assert.equal(upgraded.tasks.length, 0);
    f.service.pauseTarget({
      targetId: target.id,
      paused: false,
      revision: upgraded.revision,
    });
    f.service.save({
      revision: f.service.snapshot().revision,
      config: { targetIds: [target.id] },
    });
    assert.deepEqual(f.service.snapshot().config.targetIds, [target.id]);
  } finally {
    await f.close();
  }
});

test("贴吧观察：空关注列表保留观察吧可读状态，既有关注目标仍按原规则暂停", async () => {
  const f = await fixture();
  try {
    await f.service.syncForums({ accountId: f.account.id });
    await f.service.observe({
      accountId: f.account.id,
      forumNames: ["测试103"],
    });
    f.forums = [];
    await f.service.syncForums({ accountId: f.account.id });
    assert.equal(
      f.service.snapshot().targets.find((target) => target.forumId === "103")!
        .paused,
      false,
    );
    assert.equal(
      f.service.snapshot().targets.find((target) => target.forumId === "101")!
        .paused,
      true,
    );
    assert.equal(
      f.service.snapshot().targets.find((target) => target.forumId === "103")!
        .source,
      "observed",
    );
  } finally {
    await f.close();
  }
});

test("贴吧观察：部分失败保留成功结果，全失败明确返回逐吧错误且不产生任务", async () => {
  const f = await fixture();
  try {
    f.observeDuring = async (name) => {
      if (name === "测试102")
        throw new AppError("TIEBA_PAGE_HTTP", "官网返回404");
    };
    const result = await f.service.observe({
      accountId: f.account.id,
      forumNames: ["测试101", "测试102", "测试103"],
    });
    assert.deepEqual(result.observation!.succeeded, ["测试101", "测试103"]);
    assert.equal(result.observation!.failed[0].name, "测试102");
    assert.match(result.observation!.failed[0].message, /404/);
    assert.equal(result.targets.length, 2);
    assert.equal(result.tasks.length, 0);
    assert.ok(
      result.logs.items.some(
        (entry) =>
          entry.event === "forums.observed" && entry.level === "warning",
      ),
    );
    f.observeDuring = async () => {
      throw new AppError("TIEBA_PAGE_HTTP", "官网不可用");
    };
    const allFailed = await f.service.observe({
      accountId: f.account.id,
      forumNames: ["测试102"],
    });
    assert.equal(allFailed.observation!.succeeded.length, 0);
    assert.equal(allFailed.observation!.failed.length, 1);
    assert.equal(allFailed.targets.length, 2);
  } finally {
    await f.close();
  }
});

test("贴吧观察：在途暂停不被旧官网结果覆盖，环境变化中止剩余读取", async () => {
  const f = await fixture();
  try {
    const initial = await f.service.observe({
      accountId: f.account.id,
      forumNames: ["测试101"],
    });
    f.observeDuring = async () => {
      f.service.pauseTarget({
        targetId: initial.targets[0].id,
        paused: true,
        revision: f.service.snapshot().revision,
      });
    };
    await f.service.observe({
      accountId: f.account.id,
      forumNames: ["测试101"],
    });
    assert.equal(f.service.snapshot().targets[0].paused, true);
    f.observeDuring = async (name) => {
      if (name === "测试102")
        f.environments.invalidateIdentity({
          kind: "website",
          id: f.account.id,
        });
    };
    f.observedNames.length = 0;
    const result = await f.service.observe({
      accountId: f.account.id,
      forumNames: ["测试102", "测试103"],
    });
    assert.deepEqual(f.observedNames, ["测试102"]);
    assert.equal(result.observation!.succeeded.length, 0);
    assert.equal(result.observation!.failed.length, 2);
    assert.match(result.observation!.failed[1].message, /未执行/);
    assert.equal(result.targets.length, 1);
  } finally {
    await f.close();
  }
});

test("贴吧观察：缺少只读端口明确报错，退出后在途结果不写已关闭数据库", async () => {
  const f = await fixture();
  try {
    const resolve = f.ports.tieba!.resolveForum;
    delete f.ports.tieba!.resolveForum;
    await assert.rejects(
      f.service.observe({ accountId: f.account.id, forumNames: ["测试101"] }),
      { code: "TIEBA_OBSERVE_UNAVAILABLE" },
    );
    f.ports.tieba!.resolveForum = resolve;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      started = new Promise<void>((r) => {
        entered = r;
      });
    f.observeDuring = async () => {
      entered();
      await gate;
    };
    const observing = f.service.observe({
      accountId: f.account.id,
      forumNames: ["测试101"],
    });
    await started;
    f.service.dispose();
    f.queue.close();
    f.db.close();
    release();
    await assert.rejects(observing, { code: "TIEBA_SERVICE_CLOSED" });
  } finally {
    f.service.dispose();
    f.queue.close();
    try {
      f.db.close();
    } catch {}
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("贴吧观察：旧followed目标缺source仍按关注处理，观测不改变既有选择和任务", async () => {
  const f = await fixture();
  try {
    await f.configure();
    const target = f.service.store.targets()[0];
    const { source: _source, ...legacy } = target;
    f.service.store.saveTarget(legacy);
    const state = f.service.store.state(),
      tasks = f.service.store.tasks();
    assert.equal(f.service.snapshot().targets[0].source, "followed");
    const result = await f.service.observe({
      accountId: f.account.id,
      forumNames: ["测试101"],
    });
    assert.equal(result.targets[0].source, "followed");
    assert.equal(result.targets[0].id, target.id);
    assert.deepEqual(f.service.store.state(), state);
    assert.deepEqual(f.service.store.tasks(), tasks);
  } finally {
    await f.close();
  }
});

test("贴吧观察：错误kw和未来或陈旧回执不保存，最后返回前登录变化不能报告全成功", async () => {
  const f = await fixture();
  try {
    const resolve = f.ports.tieba!.resolveForum!;
    for (const mode of ["duplicate_kw", "future", "old"] as const) {
      f.ports.tieba!.resolveForum = async (account, uid, name) => {
        const result = await resolve(account, uid, name);
        if (mode === "duplicate_kw") result.url += "&kw=other";
        else
          result.checkedAt = new Date(
            f.time + (mode === "future" ? 60000 : -11 * 60000),
          ).toISOString();
        return result;
      };
      const result = await f.service.observe({
        accountId: f.account.id,
        forumNames: ["测试101"],
      });
      assert.equal(result.observation!.succeeded.length, 0);
      assert.equal(result.observation!.failed.length, 1);
      assert.equal(result.targets.length, 0);
    }
    f.ports.tieba!.resolveForum = resolve;
    let changed = false;
    f.dependencies.changed = () => {
      if (!changed && f.service.store.targets().length) {
        changed = true;
        f.db.run(
          "UPDATE website_accounts SET status='expired' WHERE id=?",
          f.account.id,
        );
      }
    };
    const result = await f.service.observe({
      accountId: f.account.id,
      forumNames: ["测试101"],
    });
    assert.equal(result.observation!.succeeded.length, 0);
    assert.equal(result.observation!.failed.length, 1);
    assert.match(result.observation!.failed[0].message, /重新核实/);
    assert.equal(
      result.targets.length,
      1,
      "先前合法读取结果保留，但不作为本次全部核验成功",
    );
    assert.deepEqual(result.config.targetIds, []);
  } finally {
    await f.close();
  }
});

test("贴吧：真实提交检查点、官网核验和完整配置快照落库，同日重启不重签", async () => {
  const f = await fixture();
  try {
    await f.configure();
    const deadline = f.service.snapshot().run!.deadlineAt;
    await Promise.all([f.service.tick(), f.service.tick()]);
    assert.equal(f.submissions, 1);
    const task = f.service.snapshot().tasks[0];
    assert.equal(task.status, "verified");
    assert.ok(task.submittedAt);
    assert.deepEqual(
      f.service.store.task(task.id)!.configSnapshot,
      f.service.snapshot().config,
    );
    f.time += 60000;
    f.restart();
    await f.service.tick();
    assert.equal(f.submissions, 1);
    assert.equal(f.service.snapshot().run!.deadlineAt, deadline);
    assert.ok(
      f.service
        .snapshot()
        .logs.items.some((entry) => entry.event === "task.submitting"),
    );
    assert.ok(
      f.service
        .snapshot()
        .logs.items.some((entry) => entry.event === "task.verified"),
    );
  } finally {
    await f.close();
  }
});

test("贴吧：官网已经签到则跳过，不制造本地提交回执", async () => {
  const f = await fixture();
  try {
    f.signed.add("101");
    await f.configure();
    await f.service.tick();
    assert.equal(f.submissions, 0);
    assert.equal(f.service.snapshot().tasks[0].status, "already_signed");
    assert.equal(f.service.snapshot().tasks[0].submittedAt, null);
  } finally {
    await f.close();
  }
});

test("贴吧：关闭发生在提交前时不再点击，重开不延长原批次", async () => {
  const f = await fixture();
  try {
    await f.configure();
    const deadline = f.service.snapshot().run!.deadlineAt;
    f.before = async () => {
      f.service.toggle({
        enabled: false,
        revision: f.service.snapshot().revision,
        confirmed: true,
      });
    };
    await f.service.tick();
    assert.equal(f.submissions, 0);
    assert.equal(f.service.snapshot().tasks[0].status, "cancelled");
    f.before = undefined;
    f.service.toggle({
      enabled: true,
      revision: f.service.snapshot().revision,
      confirmed: true,
    });
    assert.equal(f.service.snapshot().run!.deadlineAt, deadline);
    assert.equal(f.service.snapshot().tasks.length, 1);
  } finally {
    await f.close();
  }
});

test("贴吧：提交结果未知跨重启保留，只读补核不重新签到，阻断同号后续写入", async () => {
  const f = await fixture();
  try {
    await f.configure(2);
    f.unknown = true;
    await f.service.tick();
    const task = f.service
      .snapshot()
      .tasks.find((task) => task.status === "uncertain")!;
    assert.ok(task.submittedAt);
    f.time += 2 * 60000;
    f.restart();
    await f.service.tick();
    assert.equal(f.submissions, 1);
    await f.service.reconcile({ taskId: task.id });
    assert.equal(f.submissions, 1);
    assert.equal(f.service.store.task(task.id)!.status, "verified");
  } finally {
    await f.close();
  }
});

test("贴吧：在途读取不能覆盖逐吧暂停，也不能继续提交", async () => {
  const f = await fixture();
  try {
    await f.configure();
    const targetId = f.service.snapshot().targets[0].id;
    f.duringRead = async () => {
      f.service.pauseTarget({
        targetId,
        paused: true,
        revision: f.service.snapshot().revision,
      });
    };
    await f.service.tick();
    assert.equal(f.submissions, 0);
    assert.equal(f.service.store.target(targetId)!.paused, true);
    assert.equal(
      f.service.store.target(targetId)!.pauseReason,
      "已手动暂停此目标贴吧",
    );
    assert.equal(f.service.snapshot().tasks[0].status, "cancelled");
  } finally {
    await f.close();
  }
});

test("贴吧：提交前环境身份修订变化阻断，不因原账号UID相同忽略登录切换", async () => {
  const f = await fixture();
  try {
    await f.configure();
    f.before = async () => {
      f.environments.invalidateIdentity({ kind: "website", id: f.account.id });
    };
    await f.service.tick();
    assert.equal(f.submissions, 0);
    assert.equal(f.service.snapshot().tasks[0].status, "failed");
    assert.equal(f.service.snapshot().targets[0].paused, true);
  } finally {
    await f.close();
  }
});

test("贴吧：跨午夜或超过两小时均停止新的签到提交，旧日期状态不冒充今日已签", async () => {
  const f = await fixture();
  try {
    f.time = Date.parse("2026-11-07T15:59:00Z");
    await f.configure();
    f.before = async () => {
      f.time += 2 * 60000;
    };
    await f.service.tick();
    assert.equal(f.submissions, 0);
    assert.equal(f.service.snapshot().tasks[0].status, "expired");
    assert.equal(f.service.snapshot().targets[0].signed, null);
    assert.equal(tiebaDay(f.time), "2026-11-08");
    f.before = undefined;
    await f.service.tick();
    assert.equal(f.submissions, 1);
    assert.equal(f.service.snapshot().tasks.length, 2);
  } finally {
    await f.close();
  }
});

test("贴吧：原子领取避免重复执行，数据库以UID/吧/业务日防重", async () => {
  const f = await fixture();
  try {
    await f.configure();
    const original = f.service.store.tasks()[0];
    const otherStore = new TiebaAutocareStore(f.db);
    assert.equal(
      f.service.store.claim({ ...original, status: "running" }),
      true,
    );
    assert.equal(otherStore.claim({ ...original, status: "running" }), false);
    assert.throws(
      () => otherStore.saveTask({ ...original, id: "tiebatask_duplicate" }),
      /UNIQUE/,
    );
    f.restart();
    assert.equal(f.service.store.tasks()[0].status, "pending");
    await f.service.tick();
    assert.equal(f.submissions, 1);
  } finally {
    await f.close();
  }
});

test("贴吧：读取/签到单项目失败不取消其他目标，过期批次重开不重新排满", async () => {
  const f = await fixture();
  try {
    await f.configure(2);
    const read = f.ports.tieba!.readForum;
    f.ports.tieba!.readForum = async (account, uid, forum) =>
      forum.forumId === "101"
        ? { ...f.reading("101"), canSign: false, message: "此吧未提供签到入口" }
        : read(account, uid, forum);
    await f.service.tick();
    assert.equal(
      f.service.snapshot().tasks.find((task) => task.forumId === "101")!.status,
      "failed",
    );
    f.time += 60000;
    await f.service.tick();
    assert.equal(f.submissions, 1);
    f.time += 2 * 60 * 60000;
    f.service.toggle({
      enabled: false,
      revision: f.service.snapshot().revision,
      confirmed: true,
    });
    f.service.toggle({
      enabled: true,
      revision: f.service.snapshot().revision,
      confirmed: true,
    });
    await f.service.tick();
    assert.equal(f.submissions, 1);
    assert.equal(f.service.snapshot().run!.status, "ended");
  } finally {
    await f.close();
  }
});

test("贴吧：备份副本撤销自动执行范围，未提交取消，可能已提交只读补核，成功历史保留", async () => {
  const f = await fixture();
  try {
    await f.configure(2);
    const [first, second] = f.service.store.tasks();
    f.service.store.saveTask({ ...first, status: "running" });
    f.service.store.saveTask({
      ...second,
      status: "submitting",
      submittedAt: new Date(f.time).toISOString(),
    });
    f.service.store.saveTask({
      ...first,
      id: "tiebatask_success",
      forumId: "999",
      status: "verified",
      submittedAt: new Date(f.time).toISOString(),
    });
    stopTiebaAutocareForBackup(f.db);
    assert.equal(f.service.snapshot().enabled, false);
    assert.deepEqual(f.service.store.state().authorities, []);
    assert.equal(f.service.store.state().run!.status, "stopped");
    assert.equal(f.service.store.task(first.id)!.status, "cancelled");
    assert.equal(f.service.store.task(second.id)!.status, "uncertain");
    assert.equal(f.service.store.task("tiebatask_success")!.status, "verified");
  } finally {
    await f.close();
  }
});

test("贴吧：排期持久化失败时设置与原任务一起回滚，不留下已应用的半份配置", async () => {
  const f = await fixture();
  try {
    await f.configure();
    const previous = f.service.snapshot();
    const saveTask = f.service.store.saveTask.bind(f.service.store);
    f.service.store.saveTask = (task) => {
      saveTask(task);
      throw new Error("模拟磁盘写入中断");
    };
    assert.throws(
      () =>
        f.service.save({
          revision: previous.revision,
          config: { targetIds: previous.targets.map((target) => target.id) },
        }),
      /写入中断/,
    );
    f.service.store.saveTask = saveTask;
    assert.equal(f.service.snapshot().revision, previous.revision);
    assert.deepEqual(f.service.snapshot().config, previous.config);
    assert.deepEqual(f.service.snapshot().tasks, previous.tasks);
  } finally {
    await f.close();
  }
});

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("贴吧：补核排队跨午夜后不请求今日状态，不把今日签到证明给昨日", async () => {
  const f = await fixture();
  const entered = latch(),
    gate = latch();
  let holder: Promise<unknown> | undefined;
  try {
    f.time = Date.parse("2026-11-07T15:59:00Z");
    await f.configure();
    f.unknown = true;
    await f.service.tick();
    const task = f.service.snapshot().tasks[0];
    const reads = f.reads;
    holder = f.queue.schedule(
      [{ kind: "website", id: f.account.id }],
      "占用同一测试环境",
      async () => {
        entered.release();
        await gate.promise;
      },
    );
    await entered.promise;
    const reconcile = f.service.reconcile({ taskId: task.id });
    f.time += 2 * 60000;
    gate.release();
    await holder;
    await assert.rejects(reconcile, { code: "TIEBA_RECONCILE_PAST_DAY" });
    assert.equal(f.reads, reads);
    assert.equal(f.service.store.task(task.id)!.status, "uncertain");
  } finally {
    gate.release();
    await holder;
    await f.close();
  }
});

test("贴吧：补核读取期间跨日只保留未知，已签读数不能写成昨日成功", async () => {
  const f = await fixture();
  try {
    f.time = Date.parse("2026-11-07T15:59:00Z");
    await f.configure();
    f.unknown = true;
    await f.service.tick();
    const task = f.service.snapshot().tasks[0];
    f.duringRead = async () => {
      f.time += 2 * 60000;
    };
    await f.service.reconcile({ taskId: task.id });
    assert.equal(f.service.store.task(task.id)!.status, "uncertain");
    assert.equal(f.submissions, 1);
  } finally {
    await f.close();
  }
});

test("贴吧：签到提交后跨日或回执读取日期错配，成功读数均不能变成原任务成功", async () => {
  for (const advanceClock of [true, false]) {
    const f = await fixture();
    try {
      f.time = Date.parse("2026-11-07T15:59:00Z");
      await f.configure();
      const checkIn = f.ports.tieba!.checkIn;
      f.ports.tieba!.checkIn = async (...args) => {
        const result = await checkIn(...args);
        if (advanceClock) f.time += 2 * 60000;
        return { ...result, checkedAt: "2026-11-07T16:01:00Z" };
      };
      await f.service.tick();
      assert.equal(f.submissions, 1);
      assert.equal(f.service.snapshot().tasks[0].status, "uncertain");
    } finally {
      await f.close();
    }
  }
});

test("贴吧：官网提示频繁后持久暂停同账号所有吧，其他账号继续且重启不解除暂停", async () => {
  const f = await fixture();
  try {
    await f.configure(2);
    const env = await f.environments.save({
      name: "另一贴吧环境",
      engine: "bitbrowser",
      profileId: "tieba-fixture-2",
    });
    const other = f.accounts.add("tieba", "另一贴吧账号", env.id);
    f.identities.set(other.id, "tieba-owner-2");
    await f.accounts.verify(other.id);
    await f.service.syncForums({ accountId: other.id });
    const snapshot = f.service.snapshot();
    const otherTarget = snapshot.targets.find(
      (target) => target.accountId === other.id,
    )!;
    f.service.save({
      revision: snapshot.revision,
      config: { targetIds: [...snapshot.config.targetIds, otherTarget.id] },
    });
    const read = f.ports.tieba!.readForum;
    let firstAccountRequests = 0;
    f.ports.tieba!.readForum = async (account, ...args) => {
      if (account.id === f.account.id) {
        firstAccountRequests++;
        throw new AppError("TIEBA_RATE_LIMITED", "操作频繁，请稍后再试");
      }
      return read(account, ...args);
    };
    await f.service.tick();
    assert.ok(
      f.service
        .snapshot()
        .targets.filter((target) => target.accountId === f.account.id)
        .every((target) => target.paused),
    );
    f.time += 60000;
    await f.service.tick();
    f.time += 60000;
    await f.service.tick();
    assert.equal(firstAccountRequests, 1);
    assert.equal(
      f.service.snapshot().tasks.find((task) => task.accountId === other.id)!
        .status,
      "verified",
    );
    f.restart();
    assert.ok(
      f.service
        .snapshot()
        .targets.filter((target) => target.accountId === f.account.id)
        .every((target) => target.paused),
    );
  } finally {
    await f.close();
  }
});

test("贴吧：真实提交时间约束顺延已到期任务，准备耗时不导致每次心跳追赶提交", async () => {
  const f = await fixture();
  try {
    await f.configure(2);
    let delayed = false;
    f.duringRead = async () => {
      if (!delayed) {
        delayed = true;
        f.time += 90000;
      }
    };
    await f.service.tick();
    assert.equal(f.submissions, 1);
    const submitted = Date.parse(
      f.service.snapshot().tasks.find((task) => task.status === "verified")!
        .submittedAt!,
    );
    await f.service.tick();
    assert.equal(f.submissions, 1);
    const pending = f.service
      .snapshot()
      .tasks.find((task) => task.status === "pending")!;
    assert.equal(Date.parse(pending.plannedAt), submitted + 60000);
    f.time = submitted + 59999;
    await f.service.tick();
    assert.equal(f.submissions, 1);
    f.time = submitted + 60000;
    await f.service.tick();
    assert.equal(f.submissions, 2);
  } finally {
    await f.close();
  }
});

test("贴吧：关闭数据库后在途读取或提交返回不再落库，重开按原提交边界恢复", async () => {
  for (const phase of ["reading", "submitted"] as const) {
    const f = await fixture();
    const entered = latch(),
      gate = latch();
    let closed = false;
    try {
      await f.configure();
      if (phase === "reading") {
        f.duringRead = async () => {
          entered.release();
          await gate.promise;
        };
      } else {
        const checkIn = f.ports.tieba!.checkIn;
        f.ports.tieba!.checkIn = async (...args) => {
          const result = await checkIn(...args);
          entered.release();
          await gate.promise;
          return result;
        };
      }
      const tick = f.service.tick();
      await entered.promise;
      const task = f.service.store.tasks()[0];
      assert.equal(task.status, phase === "reading" ? "running" : "submitting");
      f.service.dispose();
      f.queue.close();
      f.db.close();
      closed = true;
      gate.release();
      await tick;
      const reopened = new Database(join(f.dir, "panxu.db"));
      try {
        const recovered = new TiebaAutocare({
          ...f.dependencies,
          db: reopened,
        });
        assert.equal(
          recovered.store.task(task.id)!.status,
          phase === "reading" ? "pending" : "uncertain",
        );
        recovered.dispose();
      } finally {
        reopened.close();
      }
    } finally {
      gate.release();
      if (closed) await rm(f.dir, { recursive: true, force: true });
      else await f.close();
    }
  }
});

async function observedFollowFixture() {
  const f = await fixture();
  f.relation = false;
  const snapshot = await f.service.observe({
    accountId: f.account.id,
    forumNames: ["测试101"],
  });
  const target = snapshot.targets[0];
  const follow = () =>
    f.service.follow({
      targetId: target.id,
      revision: f.service.snapshot().revision,
      confirmed: true,
    });
  return Object.assign(f, { target, follow });
}

test("贴吧关注：明确操作仅关注指定目标，官网核实才升级，范围和签到保持关闭", async () => {
  const f = await observedFollowFixture();
  try {
    const revision = f.service.snapshot().revision;
    assert.equal(
      tiebaAutocareFollowSchema.safeParse({ targetId: f.target.id, revision })
        .success,
      false,
    );
    await assert.rejects(
      f.service.follow({
        targetId: f.target.id,
        revision: revision + 1,
        confirmed: true,
      }),
      { code: "TIEBA_CONFIG_CHANGED" },
    );
    let checkpoint = false;
    f.afterFollow = async () => {
      checkpoint =
        f.service.store.target(f.target.id)!.followIntent?.status ===
        "submitting";
    };
    const result = await f.follow();
    assert.equal(checkpoint, true);
    assert.equal(result.followResult?.status, "followed");
    assert.equal(result.targets[0].source, "followed");
    assert.equal(result.targets[0].followed, true);
    assert.equal(result.targets[0].followIntent?.status, "verified");
    assert.equal(result.targets[0].memberCount, 123);
    assert.equal(result.targets[0].postCount, 456);
    assert.equal(result.targets[0].threadCount, 78);
    assert.deepEqual(result.config.targetIds, []);
    assert.equal(result.enabled, false);
    assert.equal(result.tasks.length, 0);
    assert.equal(f.follows, 1);
    assert.equal(f.followCalls, 1);
    assert.equal(f.submissions, 0);
    assert.equal(f.service.snapshot().followResult, undefined);
  } finally {
    await f.close();
  }
});

test("贴吧关注：官网已关注仅核实升级，不虚构本地提交记录或再次调用关注", async () => {
  const f = await observedFollowFixture();
  try {
    f.relation = true;
    const result = await f.follow();
    assert.equal(result.followResult?.status, "followed");
    assert.equal(result.targets[0].source, "followed");
    assert.equal(result.targets[0].followIntent, undefined);
    assert.equal(f.followCalls, 0);
    assert.equal(f.follows, 0);
    assert.deepEqual(result.config.targetIds, []);
  } finally {
    await f.close();
  }
});

test("贴吧关注：检查点后断线持久未知，跨重启同操作只读，确认后仍不授签到", async () => {
  const f = await observedFollowFixture();
  try {
    f.followFailure = new Error("关注点击后网络断开");
    let result = await f.follow();
    assert.equal(result.followResult?.status, "uncertain");
    assert.equal(result.targets[0].source, "observed");
    assert.equal(result.targets[0].followIntent?.status, "uncertain");
    assert.equal(f.follows, 1);
    f.followFailure = undefined;
    f.restart();
    result = await f.follow();
    assert.equal(result.followResult?.status, "uncertain");
    assert.equal(f.followCalls, 1);
    assert.equal(f.follows, 1);
    f.relation = true;
    result = await f.follow();
    assert.equal(result.followResult?.status, "followed");
    assert.equal(result.targets[0].id, f.target.id);
    assert.equal(result.targets[0].followIntent?.status, "verified");
    assert.deepEqual(result.config.targetIds, []);
    assert.equal(result.enabled, false);
    assert.equal(f.follows, 1);
  } finally {
    await f.close();
  }
});

test("贴吧关注：未得到官网确证不能升级，未知回执不会重复关注", async () => {
  const f = await observedFollowFixture();
  try {
    f.followConfirmed = false;
    const first = await f.follow();
    assert.equal(first.followResult?.status, "uncertain");
    assert.equal(first.targets[0].source, "observed");
    assert.equal(first.targets[0].followIntent?.status, "uncertain");
    await f.follow();
    assert.equal(f.follows, 1);
    assert.equal(f.followCalls, 1);
    const raw = f.service.store.target(f.target.id)!;
    raw.followIntent!.status = "submitting";
    f.service.store.saveTarget(raw);
    f.restart();
    assert.equal(
      f.service.store.target(raw.id)!.followIntent?.status,
      "uncertain",
    );
  } finally {
    await f.close();
  }
});

test("贴吧关注：关系不明或端口缺失不点击，读数未知原因与公开数据仍保存", async () => {
  const f = await observedFollowFixture();
  try {
    f.relation = null;
    let result = await f.follow();
    assert.equal(result.followResult?.status, "failed");
    assert.equal(f.followCalls, 0);
    assert.equal(result.targets[0].followIntent, undefined);
    f.relation = false;
    delete f.ports.tieba!.followForum;
    result = await f.follow();
    assert.equal(result.followResult?.status, "failed");
    assert.match(result.followResult!.message, /未接入|尚未接入/);
    assert.equal(
      result.targets[0].personalStatsMessage,
      "尚未关注，本吧个人等级未展示。",
    );
    assert.equal(result.targets[0].memberCount, 123);
    assert.equal(f.follows, 0);
    f.relation = true;
    result = await f.follow();
    assert.equal(result.followResult?.status, "followed");
  } finally {
    await f.close();
  }
});

test("贴吧关注：提交前暂停或更改环境阻止点击，在途暂停不被结果覆盖", async () => {
  for (const phase of ["pause-before", "environment-before", "pause-after"]) {
    const f = await observedFollowFixture();
    try {
      const pause = async () => {
        f.service.pauseTarget({
          targetId: f.target.id,
          revision: f.service.snapshot().revision,
          paused: true,
        });
      };
      if (phase === "pause-before") f.beforeFollow = pause;
      if (phase === "environment-before")
        f.beforeFollow = async () => {
          f.environments.invalidateIdentity({
            kind: "website",
            id: f.account.id,
          });
        };
      if (phase === "pause-after") f.afterFollow = pause;
      const result = await f.follow();
      assert.equal(f.follows, phase === "pause-after" ? 1 : 0);
      assert.equal(result.targets[0].source, "observed");
      if (phase !== "environment-before")
        assert.equal(result.targets[0].paused, true);
      assert.equal(
        result.followResult?.status,
        phase === "pause-after" ? "uncertain" : "failed",
      );
    } finally {
      await f.close();
    }
  }
});

test("贴吧关注：官网完整关注同步核实原未知，保留暂停与历史，不自动加入配置", async () => {
  const f = await observedFollowFixture();
  try {
    f.followConfirmed = false;
    await f.follow();
    f.service.pauseTarget({
      targetId: f.target.id,
      revision: f.service.snapshot().revision,
      paused: true,
    });
    const result = await f.service.syncForums({ accountId: f.account.id });
    const current = result.targets.find((target) => target.id === f.target.id)!;
    assert.equal(current.followIntent?.status, "verified");
    assert.equal(current.followed, true);
    assert.equal(current.paused, true);
    assert.equal(current.source, "followed");
    assert.deepEqual(result.config.targetIds, []);
    assert.equal(f.follows, 1);
  } finally {
    await f.close();
  }
});

test("贴吧关注：暂停目标的原未知仍可只读核实，同UID复登不重复关注", async () => {
  const f = await observedFollowFixture();
  try {
    f.followConfirmed = false;
    await f.follow();
    f.service.pauseTarget({
      targetId: f.target.id,
      revision: f.service.snapshot().revision,
      paused: true,
    });
    f.environments.invalidateIdentity({ kind: "website", id: f.account.id });
    await f.accounts.verify(f.account.id);
    f.relation = true;
    const result = await f.follow();
    assert.equal(result.followResult?.status, "followed");
    assert.equal(result.targets[0].paused, true);
    assert.equal(result.targets[0].source, "followed");
    assert.equal(result.targets[0].followIntent?.status, "verified");
    assert.equal(f.followCalls, 1);
    assert.equal(f.follows, 1);
    assert.deepEqual(result.config.targetIds, []);
  } finally {
    await f.close();
  }
});

test("贴吧关注：错UID或未来回执不能升级，已有检查点保留未知", async () => {
  for (const mismatch of ["uid", "time"]) {
    const f = await observedFollowFixture();
    try {
      const original = f.ports.tieba!.followForum!;
      f.ports.tieba!.followForum = async (...args) => {
        const result = await original(...args);
        return {
          ...result,
          ...(mismatch === "uid"
            ? { uid: "different-owner" }
            : { checkedAt: new Date(f.time + 60000).toISOString() }),
        };
      };
      const result = await f.follow();
      assert.equal(result.followResult?.status, "uncertain");
      assert.equal(result.targets[0].source, "observed");
      assert.equal(result.targets[0].followIntent?.status, "uncertain");
      assert.equal(f.follows, 1);
    } finally {
      await f.close();
    }
  }
});

test("贴吧关注：退出后在途回执不访问关闭数据库，原检查点跨重启仅待核对", async () => {
  const f = await observedFollowFixture(),
    entered = latch(),
    gate = latch();
  let closed = false;
  try {
    f.afterFollow = async () => {
      entered.release();
      await gate.promise;
    };
    const operation = f.follow();
    await entered.promise;
    f.service.dispose();
    f.queue.close();
    f.db.close();
    closed = true;
    gate.release();
    await assert.rejects(operation, { code: "TIEBA_SERVICE_CLOSED" });
    const reopened = new Database(join(f.dir, "panxu.db"));
    try {
      const recovered = new TiebaAutocare({ ...f.dependencies, db: reopened });
      assert.equal(
        recovered.store.target(f.target.id)!.followIntent?.status,
        "uncertain",
      );
      recovered.dispose();
    } finally {
      reopened.close();
    }
  } finally {
    gate.release();
    if (closed) await rm(f.dir, { recursive: true, force: true });
    else await f.close();
  }
});

test("贴吧资料刷新：只读真关系解除原关注未知，保留原意图时间和暂停且不安排签到", async () => {
  const f = await observedFollowFixture();
  try {
    f.followConfirmed = false;
    await f.follow();
    const original = f.service.store.target(f.target.id)!.followIntent!;
    f.service.pauseTarget({
      targetId: f.target.id,
      revision: f.service.snapshot().revision,
      paused: true,
    });
    const state = f.service.snapshot();
    f.relation = true;
    const result = await f.service.observe({
      accountId: f.account.id,
      forumNames: ["测试101"],
    });
    const current = result.targets.find((target) => target.id === f.target.id)!;
    assert.equal(current.followed, true);
    assert.equal(current.source, "followed");
    assert.equal(current.followIntent?.status, "verified");
    assert.equal(current.followIntent?.submittedAt, original.submittedAt);
    assert.equal(current.followIntent?.checkedAt, current.checkedAt);
    assert.match(current.followIntent!.message, /只读核实/);
    assert.equal(current.paused, true);
    assert.deepEqual(result.config, state.config);
    assert.equal(result.revision, state.revision);
    assert.equal(result.enabled, false);
    assert.equal(result.tasks.length, 0);
    assert.equal(f.follows, 1);
    assert.equal(f.followCalls, 1);
  } finally {
    await f.close();
  }
});

test("贴吧资料刷新：负或未知关系以及早于原检查点的真关系均不解除未知", async () => {
  for (const relation of [false, null, true] as const) {
    const f = await observedFollowFixture();
    try {
      f.followConfirmed = false;
      await f.follow();
      if (relation === true) {
        const raw = f.service.store.target(f.target.id)!;
        raw.followIntent!.submittedAt = new Date(f.time + 1000).toISOString();
        f.service.store.saveTarget(raw);
      }
      f.relation = relation;
      const result = await f.service.observe({
        accountId: f.account.id,
        forumNames: ["测试101"],
      });
      assert.equal(result.targets[0].source, "observed");
      assert.equal(result.targets[0].followIntent?.status, "uncertain");
      assert.equal(f.follows, 1);
    } finally {
      await f.close();
    }
  }
});

test("贴吧只读关系合并：UID/FID/名称/stamp与新鲜时间缺一不能升级", async () => {
  const f = await observedFollowFixture();
  try {
    const target = f.service.store.target(f.target.id)!,
      reading = { ...f.reading(target.forumId), followed: true };
    const scope = { uid: target.uid, stamp: target.stamp };
    assert.equal(
      verifiedTiebaFollowState(target, reading, scope, f.time).source,
      "followed",
    );
    for (const candidate of [
      () =>
        verifiedTiebaFollowState(
          target,
          reading,
          { ...scope, uid: "other" },
          f.time,
        ),
      () =>
        verifiedTiebaFollowState(
          target,
          reading,
          {
            ...scope,
            stamp: {
              ...scope.stamp,
              identityRevision: scope.stamp.identityRevision + 1,
            },
          },
          f.time,
        ),
      () =>
        verifiedTiebaFollowState(
          target,
          { ...reading, forumId: "other" },
          scope,
          f.time,
        ),
      () =>
        verifiedTiebaFollowState(
          target,
          { ...reading, name: "其他贴吧" },
          scope,
          f.time,
        ),
      () =>
        verifiedTiebaFollowState(
          target,
          {
            ...reading,
            checkedAt: new Date(f.time - 11 * 60000).toISOString(),
          },
          scope,
          f.time,
        ),
      () =>
        verifiedTiebaFollowState(
          target,
          { ...reading, checkedAt: new Date(f.time + 6000).toISOString() },
          scope,
          f.time,
        ),
    ])
      assert.deepEqual(candidate(), {});
  } finally {
    await f.close();
  }
});

test("贴吧批量添加：明确授权后顺序关注，重复名称去重，不自动启用签到或发言", async () => {
  const f = await fixture();
  try {
    f.relation = false;
    assert.deepEqual(
      tiebaAutocareAddSchema.parse({
        accountId: f.account.id,
        forumNames: [" Office技巧 ", "office技巧", "Ｏｆｆｉｃｅ技巧"],
        revision: 1,
        confirmed: true,
      }).forumNames,
      ["Office技巧"],
    );
    assert.equal(
      tiebaAutocareAddSchema.safeParse({
        accountId: f.account.id,
        forumNames: ["测试101"],
        revision: 1,
      }).success,
      false,
    );
    const result = await f.service.add({
      accountId: f.account.id,
      forumNames: ["测试101", "测试102", "测试101"],
      revision: 1,
      confirmed: true,
    });
    assert.deepEqual(
      result.addition?.items.map((item) => [item.name, item.status]),
      [
        ["测试101", "followed"],
        ["测试102", "followed"],
      ],
    );
    assert.equal(f.follows, 2);
    assert.equal(f.followCalls, 2);
    assert.equal(result.targets.length, 2);
    assert.ok(
      result.targets.every(
        (target) =>
          target.source === "followed" &&
          target.followIntent?.status === "verified",
      ),
    );
    assert.deepEqual(result.config.targetIds, []);
    assert.equal(result.enabled, false);
    assert.equal(result.tasks.length, 0);
    assert.equal(f.submissions, 0);
    const second = await f.service.add({
      accountId: f.account.id,
      forumNames: ["测试101", "测试102"],
      revision: 1,
      confirmed: true,
    });
    assert.ok(
      second.addition?.items.every((item) => item.status === "followed"),
    );
    assert.equal(f.follows, 2);
    assert.equal(f.followCalls, 2);
    assert.equal(f.service.snapshot().addition, undefined);
  } finally {
    await f.close();
  }
});

test("贴吧批量添加：单吧失败保留其他成功，原观察接口仍不产生关注", async () => {
  const f = await fixture();
  try {
    f.relation = false;
    f.observeDuring = async (name) => {
      if (name === "不存在吧")
        throw new AppError("TIEBA_FORUM_NOT_FOUND", "官网未找到准确贴吧");
    };
    const result = await f.service.add({
      accountId: f.account.id,
      forumNames: ["测试101", "不存在吧", "测试102"],
      revision: 1,
      confirmed: true,
    });
    assert.deepEqual(
      result.addition?.items.map((item) => item.status),
      ["followed", "failed", "followed"],
    );
    assert.equal(result.targets.length, 2);
    assert.equal(f.follows, 2);
    assert.match(result.addition!.items[1].message, /未找到/);
    await f.service.observe({
      accountId: f.account.id,
      forumNames: ["测试103"],
    });
    assert.equal(f.follows, 2);
    assert.equal(
      f.service.snapshot().targets.find((target) => target.forumId === "103")
        ?.source,
      "observed",
    );
  } finally {
    await f.close();
  }
});

test("贴吧批量添加：原未知只读核对，新确认关系才升级，不重放原关注", async () => {
  const f = await fixture();
  try {
    f.relation = false;
    f.followConfirmed = false;
    const add = () =>
      f.service.add({
        accountId: f.account.id,
        forumNames: ["测试101"],
        revision: 1,
        confirmed: true,
      });
    assert.equal((await add()).addition?.items[0].status, "uncertain");
    f.followConfirmed = true;
    assert.equal((await add()).addition?.items[0].status, "uncertain");
    assert.equal(f.followCalls, 1);
    assert.equal(f.follows, 1);
    f.relation = true;
    const result = await add();
    assert.equal(result.addition?.items[0].status, "followed");
    assert.equal(result.targets[0].followIntent?.status, "verified");
    assert.equal(f.follows, 1);
  } finally {
    await f.close();
  }
});

test("贴吧批量添加：配置、UID或环境变化在实际关注gate前终止余项", async () => {
  for (const kind of ["revision", "uid", "stamp"]) {
    const f = await fixture();
    try {
      f.relation = false;
      f.beforeFollow = async () => {
        if (kind === "revision")
          f.service.save({ revision: 1, config: { targetIds: [] } });
        if (kind === "uid") {
          f.identities.set(f.account.id, "different-owner");
          await f.accounts.verify(f.account.id);
        }
        if (kind === "stamp")
          f.environments.invalidateIdentity({
            kind: "website",
            id: f.account.id,
          });
      };
      const result = await f.service.add({
        accountId: f.account.id,
        forumNames: ["测试101", "测试102", "测试103"],
        revision: 1,
        confirmed: true,
      });
      assert.equal(f.follows, 0);
      assert.equal(result.addition?.items.length, 3);
      assert.equal(result.addition?.items[0].status, "failed");
      assert.ok(
        result.addition?.items
          .slice(1)
          .every(
            (item) =>
              item.status === "failed" && item.message.startsWith("未执行："),
          ),
      );
      assert.deepEqual(f.observedNames, ["测试101"]);
    } finally {
      await f.close();
    }
  }
});

test("贴吧批量添加：同账号并发不双重读取或关注，已成功项留在持久目标", async () => {
  const f = await fixture(),
    entered = latch(),
    gate = latch();
  try {
    f.relation = false;
    f.observeDuring = async () => {
      entered.release();
      await gate.promise;
    };
    const input = {
      accountId: f.account.id,
      forumNames: ["测试101"],
      revision: 1,
      confirmed: true as const,
    };
    const first = f.service.add(input);
    await entered.promise;
    assert.equal(f.service.isBusy, true);
    await assert.rejects(f.service.add(input), { code: "TIEBA_ADD_BUSY" });
    gate.release();
    const result = await first;
    assert.equal(result.addition?.items[0].status, "followed");
    assert.equal(f.follows, 1);
    assert.equal(result.targets.length, 1);
  } finally {
    gate.release();
    await f.close();
  }
});

test("贴吧批量添加：新关注网络未知停止余项并保留原检查点", async () => {
  const f = await fixture();
  try {
    f.relation = false;
    f.followFailure = new Error("官网关注后断线");
    const result = await f.service.add({
      accountId: f.account.id,
      forumNames: ["测试101", "测试102"],
      revision: 1,
      confirmed: true,
    });
    assert.deepEqual(
      result.addition?.items.map((item) => item.status),
      ["uncertain", "failed"],
    );
    assert.match(result.addition!.items[1].message, /未执行/);
    assert.equal(f.follows, 1);
    assert.equal(result.targets[0].followIntent?.status, "uncertain");
    assert.deepEqual(f.observedNames, ["测试101"]);
  } finally {
    await f.close();
  }
});

test("贴吧批量添加：首项无异常但关注收据未知，停止后二吧且原检查点不重放", async () => {
  const f = await fixture();
  try {
    f.relation = false;
    f.followConfirmed = false;
    const config = f.service.snapshot().config;
    const input = {
      accountId: f.account.id,
      forumNames: ["测试101", "测试102", "测试103"],
      revision: 1,
      confirmed: true as const,
    };
    const first = await f.service.add(input);
    assert.deepEqual(
      first.addition?.items.map((item) => item.status),
      ["uncertain", "failed", "failed"],
    );
    assert.ok(
      first.addition?.items
        .slice(1)
        .every((item) => item.message === "前项关注结果待核对，尚未执行"),
    );
    assert.deepEqual(f.observedNames, ["测试101"]);
    assert.equal(f.followCalls, 1);
    assert.equal(f.follows, 1);
    assert.equal(first.targets.length, 1);
    const checkpoint = first.targets[0].followIntent!.submittedAt;
    f.followConfirmed = true;
    const second = await f.service.add(input);
    assert.deepEqual(
      second.addition?.items.map((item) => item.status),
      ["uncertain", "failed", "failed"],
    );
    assert.deepEqual(f.observedNames, ["测试101", "测试101"]);
    assert.equal(f.followCalls, 1);
    assert.equal(f.follows, 1);
    assert.equal(second.targets[0].followIntent?.submittedAt, checkpoint);
    assert.deepEqual(second.config, config);
    assert.equal(second.enabled, false);
    assert.equal(second.tasks.length, 0);
  } finally {
    await f.close();
  }
});

test("贴吧关注：同号其他关注未知阻断新写，已关注的只读核实仍可用", async () => {
  const f = await fixture();
  try {
    f.relation = false;
    f.followConfirmed = false;
    const first = await f.service.add({
      accountId: f.account.id,
      forumNames: ["测试101"],
      revision: 1,
      confirmed: true,
    });
    const originalId = first.targets[0].id;
    const observed = await f.service.observe({
        accountId: f.account.id,
        forumNames: ["测试102"],
      }),
      target = observed.targets.find((target) => target.forumId === "102")!;
    f.followConfirmed = true;
    const blocked = await f.service.follow({
      targetId: target.id,
      revision: 1,
      confirmed: true,
    });
    assert.equal(blocked.followResult?.status, "failed");
    assert.match(blocked.followResult!.message, /先核对原关注/);
    assert.equal(f.followCalls, 1);
    assert.equal(f.follows, 1);
    assert.equal(f.service.store.target(target.id)?.followIntent, undefined);
    const batch = await f.service.add({
      accountId: f.account.id,
      forumNames: ["测试102", "测试103"],
      revision: 1,
      confirmed: true,
    });
    assert.ok(batch.addition?.items.every((item) => item.status === "failed"));
    assert.match(batch.addition!.items[1].message, /未执行.*先核对原关注/);
    assert.ok(!f.observedNames.includes("测试103"));
    f.relation = true;
    const known = await f.service.follow({
      targetId: target.id,
      revision: 1,
      confirmed: true,
    });
    assert.equal(known.followResult?.status, "followed");
    assert.equal(f.follows, 1);
    assert.equal(
      f.service.store.target(originalId)?.followIntent?.status,
      "uncertain",
    );
  } finally {
    await f.close();
  }
});

test("贴吧批量添加：退出后停止剩余项，原关注检查点保留且不写关闭数据库", async () => {
  const f = await fixture(),
    entered = latch(),
    gate = latch();
  let closed = false;
  try {
    f.relation = false;
    f.afterFollow = async () => {
      entered.release();
      await gate.promise;
    };
    const operation = f.service.add({
      accountId: f.account.id,
      forumNames: ["测试101", "测试102"],
      revision: 1,
      confirmed: true,
    });
    await entered.promise;
    f.service.dispose();
    f.queue.close();
    f.db.close();
    closed = true;
    gate.release();
    await assert.rejects(operation, { code: "TIEBA_SERVICE_CLOSED" });
    assert.deepEqual(f.observedNames, ["测试101"]);
    assert.equal(f.follows, 1);
    const reopened = new Database(join(f.dir, "panxu.db"));
    try {
      const recovered = new TiebaAutocare({ ...f.dependencies, db: reopened });
      assert.equal(
        recovered.store.targets()[0].followIntent?.status,
        "uncertain",
      );
      assert.equal(recovered.store.targets().length, 1);
      recovered.dispose();
    } finally {
      reopened.close();
    }
  } finally {
    gate.release();
    if (closed) await rm(f.dir, { recursive: true, force: true });
    else await f.close();
  }
});

test("贴吧查找：显式只读、参数规范、返回活动样本，不添加或关注", async () => {
  const f = await fixture();
  try {
    const before = f.service.snapshot();
    const result = await f.service.findForums({
      accountId: f.account.id,
      keyword: "  office　技巧  ",
    });
    assert.equal(result.keyword, "office 技巧");
    assert.equal(result.items[0].sampledThreads, 3);
    assert.equal(result.items[0].zeroReplyThreads, 2);
    assert.equal(f.finds, 1);
    assert.equal(f.follows, 0);
    assert.equal(f.submissions, 0);
    assert.deepEqual(f.observedNames, []);
    assert.deepEqual(f.service.snapshot().targets, before.targets);
    assert.deepEqual(f.service.snapshot().config, before.config);
    delete f.ports.tieba!.findForums;
    await assert.rejects(
      f.service.findForums({ accountId: f.account.id, keyword: "办公" }),
      { code: "TIEBA_FIND_UNAVAILABLE" },
    );
  } finally {
    await f.close();
  }
});

test("贴吧查找：拒绝错误账号、查找词、过期结果和无来源候选", async () => {
  const f = await fixture();
  try {
    const input = { accountId: f.account.id, keyword: "办公" },
      valid = await f.service.findForums(input);
    for (const bad of [
      { accountId: "web_other" },
      { keyword: "其他" },
      { checkedAt: new Date(f.time - 11 * 60000).toISOString() },
      {
        items: [
          { ...valid.items[0], url: "https://evil.invalid/f?kw=测试101" },
        ],
      },
      { items: [{ ...valid.items[0], zeroReplyThreads: 4 }] },
    ]) {
      f.findResult = bad;
      await assert.rejects(f.service.findForums(input), {
        code: "TIEBA_FIND_RESULT",
      });
    }
    assert.equal(f.service.snapshot().targets.length, 0);
    assert.equal(f.follows, 0);
  } finally {
    await f.close();
  }
});

test("贴吧查找：在途UID或stamp改变不返回陈旧候选", async () => {
  for (const kind of ["uid", "stamp"]) {
    const f = await fixture();
    try {
      f.findDuring = async () => {
        if (kind === "uid") {
          f.identities.set(f.account.id, "different-owner");
          await f.accounts.verify(f.account.id);
        } else
          f.environments.invalidateIdentity({
            kind: "website",
            id: f.account.id,
          });
      };
      await assert.rejects(
        f.service.findForums({ accountId: f.account.id, keyword: "办公" }),
      );
      assert.equal(f.service.snapshot().targets.length, 0);
      assert.equal(f.follows, 0);
    } finally {
      await f.close();
    }
  }
});

test("贴吧查找：退出后丢弃在途结果，不访问已关闭数据库", async () => {
  const f = await fixture(),
    entered = latch(),
    gate = latch();
  let closed = false;
  try {
    f.findDuring = async () => {
      entered.release();
      await gate.promise;
    };
    const operation = f.service.findForums({
      accountId: f.account.id,
      keyword: "办公",
    });
    await entered.promise;
    f.service.dispose();
    f.queue.close();
    f.db.close();
    closed = true;
    gate.release();
    await assert.rejects(operation, { code: "TIEBA_SERVICE_CLOSED" });
    assert.equal(f.follows, 0);
  } finally {
    gate.release();
    if (closed) await rm(f.dir, { recursive: true, force: true });
    else await f.close();
  }
});

test("资源发帖未知阻断签到，已核实的发帖仍遵守真实提交间隔", async () => {
  const f = await fixture();
  try {
    await f.configure();
    const post = {
      id: "tiebapublishing_guard",
      uid: f.accounts.get(f.account.id).uid,
      status: "uncertain",
      submittedAt: new Date(f.time).toISOString(),
    };
    f.db.setSetting(tiebaPublishingIndexKey, [post.id]);
    f.db.setSetting(`tieba-publishing:draft:v1:${post.id}`, post);
    await f.service.tick();
    assert.equal(f.submissions, 0);
    post.status = "verified";
    f.db.setSetting(`tieba-publishing:draft:v1:${post.id}`, post);
    await f.service.tick();
    assert.equal(f.submissions, 0);
    f.time += 60000;
    await f.service.tick();
    assert.equal(f.submissions, 1);
  } finally {
    await f.close();
  }
});

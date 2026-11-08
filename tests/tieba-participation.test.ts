import { tiebaPublishingIndexKey } from "../core/tieba-publishing/store";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../core/database";
import { AppError } from "../core/errors";
import { SecretStore } from "../core/secrets";
import { WebsiteAccounts } from "../core/website-accounts";
import { BrowserEnvironments } from "../core/browser-environments";
import { BrowserEnvironmentQueue } from "../core/browser-environment-queue";
import type { AppPorts } from "../core/ports";
import type { AiService } from "../core/ai";
import type {
  TiebaThreadCandidate,
  TiebaThreadContext,
  TiebaReplyReceipt,
} from "../shared/tieba-participation";
import { TiebaAutocareStore } from "../core/tieba-autocare/store";
import { TiebaParticipation } from "../core/tieba-participation/service";
import { migrateTiebaParticipation } from "../core/tieba-participation/migration";
import { stopTiebaParticipationForBackup } from "../core/tieba-participation/store";
import { checkTiebaReply } from "../core/tieba-participation/generation";
import { migrateTiebaTopics } from "../core/tieba-topics/migration";

const source =
  "我正在整理一个资料目录，需要按文件类型和使用场景分类。现在的文件夹过多，查找资料时经常不知道应该从哪里开始，希望得到具体的整理建议。";
const evidence = ["按文件类型和使用场景分类"];
const reply =
  "可以先把目录入口缩到三个常用场景，每份资料只保留一个主目录，再用标签记录文件类型。这样查找时先按用途缩小范围，类型只作为辅助条件。";
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "panxu-tieba-reply-"));
  const db = new Database(join(dir, "panxu.db"));
  migrateTiebaParticipation(db.db);
  let time = Date.parse("2026-11-07T02:00:00Z"),
    networkReads = 0,
    submissions = 0,
    calls = 0;
  let uid = "111",
    body = source,
    truncated = false,
    unknown = false,
    receiptMismatch = false;
  let before: (() => Promise<void>) | undefined,
    duringRead: (() => Promise<void>) | undefined,
    duringAi: (() => Promise<void>) | undefined;
  let aiFailure: Error | undefined;
  let replies: TiebaThreadContext["replies"] = [];
  let aiResult = { publishable: true, body: reply, reason: "", evidence };
  const replyOptions: { aiGenerated: boolean }[] = [];
  const now = () => new Date(time).toISOString();
  const thread = (threadId = "1001"): TiebaThreadCandidate => ({
    threadId,
    forumId: "101",
    forumName: "整理资料",
    title: "资料目录如何整理",
    url: `https://tieba.baidu.com/p/${threadId}`,
    authorUid: "222",
    replyCount: 2,
    lastActiveAt: null,
    discoveredAt: now(),
  });
  const context = (threadId = "1001"): TiebaThreadContext => ({
    ...thread(threadId),
    body,
    replies,
    closed: false,
    canReply: true,
    truncated,
    checkedAt: now(),
  });
  const receipt = (threadId: string, text: string): TiebaReplyReceipt => ({
    status: "verified",
    threadId,
    postId: "9001",
    url: `https://tieba.baidu.com/p/${threadId}#9001`,
    authorUid: receiptMismatch ? "333" : "111",
    body: text,
    checkedAt: now(),
    message: "官网已核实",
  });
  const ports = {
    browserEnvironments: {
      prepare: async () => {},
      assertIdle: async () => {},
      checkNetwork: async () => "203.0.113.10",
    },
    websiteSessions: {
      isOpen: () => false,
      login: async () => {},
      clear: async () => {},
      invalidate: async () => {},
      status: async () => ({
        hasSession: true,
        uid,
        windowOpen: false,
        error: null,
      }),
      verify: async () => ({
        hasSession: true,
        uid,
        windowOpen: false,
        error: null,
      }),
    },
    tiebaParticipation: {
      listThreads: async () => {
        networkReads++;
        return [thread(), thread(), thread("1002")];
      },
      readThread: async (
        _account: unknown,
        _uid: string,
        candidate: TiebaThreadCandidate,
      ) => {
        networkReads++;
        await duringRead?.();
        return context(candidate.threadId);
      },
      reply: async (
        _account: unknown,
        _uid: string,
        ctx: TiebaThreadContext,
        text: string,
        checkpoint: () => Promise<void>,
        options?: { aiGenerated: boolean },
      ) => {
        if (options) replyOptions.push(options);
        await before?.();
        await checkpoint();
        submissions++;
        if (unknown) throw new Error("官网提交后断线");
        return receipt(ctx.threadId, text);
      },
      reconcileReply: async (
        _account: unknown,
        _uid: string,
        ctx: TiebaThreadContext,
        text: string,
      ) => {
        networkReads++;
        return receipt(ctx.threadId, text);
      },
    },
  } as unknown as AppPorts;
  const secrets = new SecretStore(db, {
    available: () => true,
    encrypt: async (value) => value,
    decrypt: async (value) => value,
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
    name: "回复专用环境",
    engine: "bitbrowser",
    profileId: "reply-fixture",
  });
  const account = accounts.add("tieba", "回复测试账号", env.id);
  await accounts.verify(account.id);
  const targets = new TiebaAutocareStore(db);
  targets.saveTarget({
    id: "tiebatarget_reply",
    accountId: account.id,
    uid: "111",
    forumId: "101",
    name: "整理资料",
    url: "https://tieba.baidu.com/f?kw=test",
    level: 3,
    experience: 10,
    signed: null,
    canSign: null,
    message: null,
    checkedAt: now(),
    paused: false,
    pauseReason: null,
    syncedAt: now(),
    stamp: environments.stamp({ kind: "website", id: account.id }),
  });
  const ai = {
    assertTextConfigured: () => ({ model: "mock/copy" }),
    modelFor: () => "mock/copy",
    resourceExport: async (
      _phase: string,
      _schema: unknown,
      _instruction: string,
      _input: unknown,
      _images: unknown,
      options: { beforeRequest(): void },
    ) => {
      options.beforeRequest();
      calls++;
      await duringAi?.();
      if (aiFailure) throw aiFailure;
      return aiResult;
    },
  } as unknown as AiService;
  const dependencies = {
    db,
    accounts,
    environments,
    queue,
    ports,
    ai,
    dataPath: dir,
    changed: () => {},
    clock: () => time,
  };
  let service = new TiebaParticipation(dependencies);
  const prepare = async () => {
    await service.discover({ targetId: "tiebatarget_reply" });
    const candidate = service
      .snapshot()
      .candidates.find((row) => row.threadId === "1001")!;
    await service.read({ candidateId: candidate.id });
    await service.generate({ candidateId: candidate.id, confirmed: true });
    return service.snapshot().drafts[0];
  };
  return {
    dir,
    db,
    ports,
    targets,
    account,
    accounts,
    replyOptions,
    environments,
    queue,
    context,
    thread,
    prepare,
    get service() {
      return service;
    },
    get time() {
      return time;
    },
    set time(value: number) {
      time = value;
    },
    get calls() {
      return calls;
    },
    get networkReads() {
      return networkReads;
    },
    get submissions() {
      return submissions;
    },
    set uid(value: string) {
      uid = value;
    },
    set body(value: string) {
      body = value;
    },
    set truncated(value: boolean) {
      truncated = value;
    },
    set unknown(value: boolean) {
      unknown = value;
    },
    set receiptMismatch(value: boolean) {
      receiptMismatch = value;
    },
    set before(value: (() => Promise<void>) | undefined) {
      before = value;
    },
    set duringRead(value: (() => Promise<void>) | undefined) {
      duringRead = value;
    },
    set duringAi(value: (() => Promise<void>) | undefined) {
      duringAi = value;
    },
    set aiFailure(value: Error | undefined) {
      aiFailure = value;
    },
    set replies(value: TiebaThreadContext["replies"]) {
      replies = value;
    },
    set aiResult(value: typeof aiResult) {
      aiResult = value;
    },
    restart() {
      service.dispose();
      service = new TiebaParticipation(dependencies);
    },
    async close() {
      service.dispose();
      queue.close();
      try {
        db.close();
      } catch {}
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("贴吧观察目标：未加入签到范围仍可显式发现和读取，快照不触发生成或发言", async () => {
  const f = await fixture();
  try {
    const target = f.targets.target("tiebatarget_reply")!;
    f.targets.saveTarget({ ...target, source: "observed" });
    const initial = f.service.snapshot();
    assert.equal(initial.targets[0].source, "observed");
    assert.deepEqual(f.targets.state().config.targetIds, []);
    assert.equal(f.targets.state().enabled, false);
    assert.equal(f.networkReads, 0);
    await f.service.discover({ targetId: target.id });
    const candidate = f.service.snapshot().candidates[0];
    await f.service.read({ candidateId: candidate.id });
    assert.equal(f.service.snapshot().candidates[0].context?.body, source);
    assert.equal(f.calls, 0);
    assert.equal(f.submissions, 0);
    assert.deepEqual(f.targets.tasks(), []);
    assert.deepEqual(f.targets.state().config.targetIds, []);
  } finally {
    await f.close();
  }
});

test("贴吧回复：快照本地只读，发现候选按UID与主题去重，读取保存准确上下文", async () => {
  const f = await fixture();
  try {
    assert.equal(f.service.snapshot().candidates.length, 0);
    assert.equal(f.networkReads, 0);
    await f.service.discover({ targetId: "tiebatarget_reply" });
    assert.equal(f.service.snapshot().candidates.length, 2);
    await f.service.discover({ targetId: "tiebatarget_reply" });
    assert.equal(f.service.snapshot().candidates.length, 2);
    const candidate = f.service.snapshot().candidates[0];
    await f.service.read({ candidateId: candidate.id });
    assert.equal(f.service.snapshot().candidates[0].context?.body, source);
    assert.equal(f.calls, 0);
    assert.equal(f.submissions, 0);
  } finally {
    await f.close();
  }
});

test("贴吧回复：缺完整上下文不付费，明确生成保存模型依据且不自动提交", async () => {
  const f = await fixture();
  try {
    await f.service.discover({ targetId: "tiebatarget_reply" });
    const candidate = f.service.snapshot().candidates[0];
    await assert.rejects(
      f.service.generate({ candidateId: candidate.id, confirmed: true }),
      { code: "TIEBA_CONTEXT_REQUIRED" },
    );
    f.truncated = true;
    await f.service.read({ candidateId: candidate.id });
    await assert.rejects(
      f.service.generate({ candidateId: candidate.id, confirmed: true }),
      { code: "TIEBA_CONTEXT_INCOMPLETE" },
    );
    assert.equal(f.calls, 0);
    f.truncated = false;
    await f.service.read({ candidateId: candidate.id });
    await f.service.generate({ candidateId: candidate.id, confirmed: true });
    const draft = f.service.snapshot().drafts[0];
    assert.equal(draft.status, "ready");
    assert.equal(draft.model, "mock/copy");
    assert.deepEqual(draft.evidence, evidence);
    assert.equal(f.calls, 1);
    assert.equal(f.submissions, 0);
    await assert.rejects(
      f.service.generate({ candidateId: candidate.id, confirmed: true }),
      { code: "TIEBA_REPLY_GENERATION_EXISTS" },
    );
  } finally {
    await f.close();
  }
});

test("贴吧回复：规则拒绝导流、套话、伪造经历、复制和无来源证据", async () => {
  const f = await fixture();
  try {
    for (const body of [
      "感谢分享，这个观点很好，我也觉得整理资料非常有必要。",
      "我亲测这种方式效果特别好，你可以按场景分类并坚持使用。",
      "资料整理建议到https://example.com领取完整清单，按说明来就可以。",
      source,
    ])
      assert.throws(() => checkTiebaReply(body, f.context(), evidence));
    assert.throws(
      () => checkTiebaReply(reply, f.context(), ["首帖并不存在这一条信息"]),
      { code: "TIEBA_REPLY_EVIDENCE" },
    );
    assert.ok(checkTiebaReply(reply, f.context(), evidence).length);
  } finally {
    await f.close();
  }
});

test("贴吧回复：生成费用未知跨重启保留，不允许再次付费或提交", async () => {
  const f = await fixture();
  try {
    f.aiFailure = new Error("生成服务连接中断");
    const draft = await f.prepare();
    assert.equal(draft.status, "attention");
    f.restart();
    await assert.rejects(
      f.service.generate({ candidateId: draft.candidateId, confirmed: true }),
      { code: "TIEBA_REPLY_GENERATION_EXISTS" },
    );
    await assert.rejects(
      f.service.submit({
        draftId: draft.id,
        version: draft.version,
        confirmed: true,
      }),
      { code: "TIEBA_REPLY_NOT_READY" },
    );
    assert.equal(f.calls, 1);
    assert.equal(f.submissions, 0);
  } finally {
    await f.close();
  }
});

test("贴吧回复：草稿版本冲突拒绝，保存后的准确正文才可提交", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    const body = reply + "也可以定期清理不再使用的分类。";
    const saved = f.service.saveDraft({
      draftId: draft.id,
      version: draft.version,
      body,
    }).drafts[0];
    assert.equal(saved.version, draft.version + 1);
    assert.throws(
      () =>
        f.service.saveDraft({
          draftId: draft.id,
          version: draft.version,
          body,
        }),
      { code: "TIEBA_REPLY_VERSION_CHANGED" },
    );
    await assert.rejects(
      f.service.submit({
        draftId: draft.id,
        version: draft.version,
        confirmed: true,
      }),
      { code: "TIEBA_REPLY_VERSION_CHANGED" },
    );
    const result = await f.service.submit({
      draftId: draft.id,
      version: saved.version,
      confirmed: true,
    });
    assert.equal(result.drafts[0].status, "verified");
    assert.equal(result.drafts[0].receipt?.body, body);
    assert.equal(f.submissions, 1);
    assert.ok(result.drafts[0].submittedAt);
    await assert.rejects(
      f.service.submit({
        draftId: draft.id,
        version: result.drafts[0].version,
        confirmed: true,
      }),
      { code: "TIEBA_REPLY_NOT_READY" },
    );
  } finally {
    await f.close();
  }
});

test("贴吧回复：未知提交重启不重放，只读核对匹配身份和正文的楼层", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    f.unknown = true;
    await f.service.submit({
      draftId: draft.id,
      version: draft.version,
      confirmed: true,
    });
    const pending = f.service.snapshot().drafts[0];
    assert.equal(pending.status, "uncertain");
    f.restart();
    f.receiptMismatch = true;
    await f.service.reconcile({ draftId: draft.id });
    assert.equal(f.service.snapshot().drafts[0].status, "uncertain");
    f.receiptMismatch = false;
    await f.service.reconcile({ draftId: draft.id });
    assert.equal(f.service.snapshot().drafts[0].status, "verified");
    assert.equal(f.submissions, 1);
  } finally {
    await f.close();
  }
});

test("贴吧回复：提交前重新读取正文，主题变化不点击且保留原稿", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    f.body = source + "补充：我现在只考虑纯文本资料，不包含图片。";
    await f.service.submit({
      draftId: draft.id,
      version: draft.version,
      confirmed: true,
    });
    assert.equal(f.submissions, 0);
    assert.equal(f.service.snapshot().drafts[0].status, "draft");
    assert.equal(f.service.snapshot().drafts[0].body, reply);
    assert.match(f.service.snapshot().drafts[0].message, /首帖已变化/);
  } finally {
    await f.close();
  }
});

test("贴吧回复：提交前暂停或换号阻止点击，不改变已保存正文", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    f.before = async () => {
      const target = f.targets.target("tiebatarget_reply")!;
      f.targets.saveTarget({
        ...target,
        paused: true,
        pauseReason: "测试暂停",
      });
    };
    await f.service.submit({
      draftId: draft.id,
      version: draft.version,
      confirmed: true,
    });
    assert.equal(f.submissions, 0);
    assert.equal(f.service.snapshot().drafts[0].status, "draft");
    const target = f.targets.target("tiebatarget_reply")!;
    f.targets.saveTarget({ ...target, paused: false, pauseReason: null });
    f.uid = "333";
    const current = f.service.snapshot().drafts[0];
    f.service.saveDraft({
      draftId: current.id,
      version: current.version,
      body: current.body,
    });
    await f.service.submit({
      draftId: draft.id,
      version: f.service.snapshot().drafts[0].version,
      confirmed: true,
    });
    assert.equal(f.submissions, 0);
  } finally {
    await f.close();
  }
});

test("贴吧回复：关闭数据库后在途读取不再落库", async () => {
  const f = await fixture();
  try {
    await f.service.discover({ targetId: "tiebatarget_reply" });
    const candidate = f.service.snapshot().candidates[0];
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.duringRead = async () => {
      entered();
      await gate;
    };
    const reading = f.service.read({ candidateId: candidate.id });
    await started;
    f.service.dispose();
    f.queue.close();
    f.db.close();
    release();
    await assert.rejects(reading, { code: "TIEBA_PARTICIPATION_CLOSED" });
  } finally {
    await f.close();
  }
});

test("贴吧回复：生成或提交在途关闭后保留检查点，重新打开仅恢复attention或uncertain", async () => {
  for (const stage of ["generation", "submission"] as const) {
    const f = await fixture();
    try {
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let operation: Promise<unknown>;
      if (stage === "generation") {
        f.duringAi = async () => {
          entered();
          await gate;
        };
        operation = f.prepare();
      } else {
        const draft = await f.prepare();
        f.ports.tiebaParticipation!.reply = async (
          _account,
          _uid,
          context,
          body,
          checkpoint,
        ) => {
          await checkpoint();
          entered();
          await gate;
          return {
            status: "verified",
            threadId: context.threadId,
            postId: "9001",
            url: `https://tieba.baidu.com/p/${context.threadId}#9001`,
            authorUid: "111",
            body,
            checkedAt: new Date(f.time).toISOString(),
            message: "官网已核实",
          };
        };
        operation = f.service.submit({
          draftId: draft.id,
          version: draft.version,
          confirmed: true,
        });
      }
      await started;
      f.service.dispose();
      f.queue.close();
      f.db.close();
      release();
      await assert.rejects(operation, { code: "TIEBA_PARTICIPATION_CLOSED" });
      const reopened = new Database(join(f.dir, "panxu.db"));
      const restored = new TiebaParticipation({
        db: reopened,
        accounts: {} as WebsiteAccounts,
        environments: {} as BrowserEnvironments,
        queue: {} as BrowserEnvironmentQueue,
        ports: {} as AppPorts,
        ai: {} as AiService,
        dataPath: f.dir,
        changed: () => {},
        clock: () => f.time,
      });
      try {
        assert.equal(
          restored.store.drafts()[0].status,
          stage === "generation" ? "attention" : "uncertain",
        );
        if (stage === "submission")
          assert.ok(restored.store.drafts()[0].submittedAt);
      } finally {
        restored.dispose();
        reopened.close();
      }
    } finally {
      await f.close();
    }
  }
});

test("贴吧回复：备份撤销ready资格，提交未知保留，生成记录不自动重试", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    stopTiebaParticipationForBackup(f.db);
    assert.equal(f.service.snapshot().drafts[0].status, "draft");
    assert.equal(f.service.snapshot().drafts[0].body, draft.body);
    await assert.rejects(
      f.service.submit({
        draftId: draft.id,
        version: f.service.snapshot().drafts[0].version,
        confirmed: true,
      }),
      { code: "TIEBA_REPLY_NOT_READY" },
    );
    assert.equal(f.submissions, 0);
  } finally {
    await f.close();
  }
});

test("贴吧回复：没有明确生成触发时不付费，已参与或其他受管账号主题不生成", async () => {
  const f = await fixture();
  try {
    await f.service.discover({ targetId: "tiebatarget_reply" });
    const candidate = f.service.snapshot().candidates[0];
    await f.service.read({ candidateId: candidate.id });
    await assert.rejects(
      f.service.generate({
        candidateId: candidate.id,
        confirmed: false as true,
      }),
      { code: "TIEBA_REPLY_GENERATION_CONFIRMATION" },
    );
    const stored = f.service.store.candidate(candidate.id)!;
    f.service.store.saveCandidate({
      ...stored,
      context: {
        ...stored.context!,
        replies: [
          {
            postId: "900",
            authorUid: "111",
            authorName: "本人",
            text: "原有回复",
          },
        ],
      },
    });
    await assert.rejects(
      f.service.generate({ candidateId: candidate.id, confirmed: true }),
      { code: "TIEBA_ALREADY_PARTICIPATED" },
    );
    f.service.store.saveCandidate({
      ...stored,
      context: { ...stored.context!, authorUid: "111" },
    });
    await assert.rejects(
      f.service.generate({ candidateId: candidate.id, confirmed: true }),
      { code: "TIEBA_MANAGED_THREAD" },
    );
    assert.equal(f.calls, 0);
  } finally {
    await f.close();
  }
});

test("贴吧回复：北京时间业务日签到未知会阻断回帖，实际签到提交时间约束回复间隔", async () => {
  const f = await fixture();
  try {
    f.time = Date.parse("2026-11-07T16:05:00Z");
    const draft = await f.prepare();
    const day = new Date(f.time + 8 * 3600000).toISOString().slice(0, 10);
    f.db.run(
      "INSERT INTO tieba_autocare_tasks(id,target_id,uid,forum_id,day,action,status,planned_at,deadline_at,submitted_at,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      "tiebatask_sign",
      "tiebatarget_reply",
      "111",
      "101",
      day,
      "checkin",
      "uncertain",
      new Date(f.time).toISOString(),
      new Date(f.time + 7200000).toISOString(),
      new Date(f.time).toISOString(),
      JSON.stringify({ accountId: f.account.id }),
    );
    await assert.rejects(
      f.service.submit({
        draftId: draft.id,
        version: draft.version,
        confirmed: true,
      }),
      { code: "TIEBA_SIGN_UNCERTAIN_BLOCK" },
    );
    f.db.run(
      "UPDATE tieba_autocare_tasks SET status='verified' WHERE id='tiebatask_sign'",
    );
    await assert.rejects(
      f.service.submit({
        draftId: draft.id,
        version: draft.version,
        confirmed: true,
      }),
      { code: "TIEBA_REPLY_INTERVAL" },
    );
    f.time += 60000;
    await f.service.submit({
      draftId: draft.id,
      version: draft.version,
      confirmed: true,
    });
    assert.equal(f.submissions, 1);
  } finally {
    await f.close();
  }
});

test("贴吧回复：已知生成失败仅可有限再试，不能借更换草稿重置次数", async () => {
  const f = await fixture();
  try {
    f.aiResult = {
      publishable: true,
      body: reply,
      reason: "",
      evidence: ["正文并无这条模型虚构证据"],
    };
    const draft = await f.prepare();
    assert.equal(draft.status, "failed");
    await f.service.generate({
      candidateId: draft.candidateId,
      confirmed: true,
    });
    assert.equal(f.service.snapshot().drafts[0].generationAttempts, 2);
    assert.equal(f.service.snapshot().drafts.length, 1);
    await assert.rejects(
      f.service.generate({ candidateId: draft.candidateId, confirmed: true }),
      { code: "TIEBA_REPLY_GENERATION_LIMIT" },
    );
    assert.equal(f.calls, 2);
  } finally {
    await f.close();
  }
});

test("贴吧回复：官网回执不是准确身份不能记成功，频繁错误暂停相关账号目标", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    f.receiptMismatch = true;
    await f.service.submit({
      draftId: draft.id,
      version: draft.version,
      confirmed: true,
    });
    assert.equal(f.service.snapshot().drafts[0].status, "uncertain");
    f.ports.tiebaParticipation!.reconcileReply = async () => {
      throw new AppError("TIEBA_RATE_LIMITED", "操作过于频繁");
    };
    await assert.rejects(f.service.reconcile({ draftId: draft.id }), {
      code: "TIEBA_RATE_LIMITED",
    });
    assert.equal(f.targets.target("tiebatarget_reply")!.paused, true);
    assert.match(f.targets.target("tiebatarget_reply")!.pauseReason!, /频繁/);
    assert.equal(f.submissions, 1);
  } finally {
    await f.close();
  }
});

test("贴吧回复：回执链接必须指向准确楼层，网页空白归一匹配不改变提交正文hash", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    const body = reply.replace("每份", "\n每份");
    const saved = f.service.saveDraft({
      draftId: draft.id,
      version: draft.version,
      body,
    }).drafts[0];
    f.unknown = true;
    await f.service.submit({
      draftId: draft.id,
      version: saved.version,
      confirmed: true,
    });
    for (const url of [
      "https://tieba.baidu.com/p/1001",
      "https://tieba.baidu.com/p/1001?pid=9002#9001",
      "https://tieba.baidu.com/p/1001?pid=9001#9002",
      "https://tieba.baidu.com/p/1001?pid=9001&pid=9002#9001",
      "https://tieba.baidu.com/p/1001#post_9002",
    ]) {
      f.ports.tiebaParticipation!.reconcileReply = async () => ({
        status: "verified",
        threadId: "1001",
        postId: "9001",
        url,
        authorUid: "111",
        body,
        checkedAt: new Date(f.time).toISOString(),
        message: "楼层不一致的模拟回执",
      });
      await f.service.reconcile({ draftId: draft.id });
      assert.equal(f.service.snapshot().drafts[0].status, "uncertain", url);
    }
    const hash = f.service.store.draft(draft.id)!.bodyHash;
    f.ports.tiebaParticipation!.reconcileReply = async () => ({
      status: "verified",
      threadId: "1001",
      postId: "9001",
      url: "https://tieba.baidu.com/p/1001?pid=9001#post_9001",
      authorUid: "111",
      body: body.replace("\n", "\n\n "),
      checkedAt: new Date(f.time).toISOString(),
      message: "官网正文含段落空白",
    });
    await f.service.reconcile({ draftId: draft.id });
    assert.equal(f.service.snapshot().drafts[0].status, "verified");
    assert.equal(f.service.store.draft(draft.id)!.bodyHash, hash);
    assert.equal(f.submissions, 1);
  } finally {
    await f.close();
  }
});

test("贴吧回复：他人楼层整段复制被拒绝，提交前新增相同回复时跳过且不点击", async () => {
  const f = await fixture();
  try {
    const context = f.context();
    context.replies = [
      { postId: "8001", authorUid: "333", authorName: "他人", text: reply },
    ];
    assert.throws(() => checkTiebaReply(reply, context, evidence), {
      code: "TIEBA_REPLY_DUPLICATE",
    });
    const draft = await f.prepare();
    f.replies = context.replies;
    await f.service.submit({
      draftId: draft.id,
      version: draft.version,
      confirmed: true,
    });
    assert.equal(f.service.snapshot().drafts[0].status, "skipped");
    assert.match(f.service.snapshot().drafts[0].message, /复制/);
    assert.equal(f.submissions, 0);
    assert.equal(
      f.service.store.candidate(draft.candidateId)!.context!.replies[0].postId,
      "8001",
    );
  } finally {
    await f.close();
  }
});

test("贴吧回复：显式重新发现只恢复同目标同身份候选，原稿保留且需重新读取保存", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    const candidate = f.service.store.candidate(draft.candidateId)!;
    f.environments.invalidateIdentity({ kind: "website", id: f.account.id });
    const target = f.targets.target("tiebatarget_reply")!;
    f.targets.saveTarget({
      ...target,
      stamp: f.environments.stamp({ kind: "website", id: f.account.id }),
    });
    await assert.rejects(f.service.read({ candidateId: candidate.id }), {
      code: "ENVIRONMENT_CHANGED",
    });
    await f.service.discover({ targetId: target.id });
    const updated = f.service.snapshot().drafts[0];
    assert.equal(updated.status, "draft");
    assert.equal(updated.body, draft.body);
    assert.equal(
      updated.version,
      draft.version + 1,
      "同页重复候选不重复恢复或增加版本",
    );
    assert.equal(f.service.store.candidate(candidate.id)!.context, null);
    await assert.rejects(
      f.service.submit({
        draftId: draft.id,
        version: updated.version,
        confirmed: true,
      }),
      { code: "TIEBA_REPLY_NOT_READY" },
    );
    await f.service.read({ candidateId: candidate.id });
    const saved = f.service.saveDraft({
      draftId: draft.id,
      version: f.service.snapshot().drafts[0].version,
      body: updated.body,
    }).drafts[0];
    assert.equal(saved.status, "ready");
    assert.equal(f.calls, 1, "登录恢复不重新付费生成");
    assert.equal(f.submissions, 0);
  } finally {
    await f.close();
  }
});

test("贴吧回复：重新发现不能迁移其他目标吧或重置已提交未知记录", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    f.unknown = true;
    await f.service.submit({
      draftId: draft.id,
      version: draft.version,
      confirmed: true,
    });
    const before = f.service.store.candidate(draft.candidateId)!;
    f.environments.invalidateIdentity({ kind: "website", id: f.account.id });
    const target = f.targets.target("tiebatarget_reply")!;
    f.targets.saveTarget({
      ...target,
      stamp: f.environments.stamp({ kind: "website", id: f.account.id }),
    });
    await f.service.discover({ targetId: target.id });
    const after = f.service.store.candidate(draft.candidateId)!;
    assert.deepEqual(after.stamp, before.stamp);
    assert.deepEqual(after.context, before.context);
    assert.equal(f.service.snapshot().drafts[0].status, "uncertain");
    const otherCandidate = f.service
      .snapshot()
      .candidates.find((row) => row.threadId === "1002")!;
    const otherStamp = f.service.store.candidate(otherCandidate.id)!.stamp;
    f.targets.saveTarget({
      ...target,
      id: "tiebatarget_other",
      forumId: "202",
      name: "其他",
      stamp: f.environments.stamp({ kind: "website", id: f.account.id }),
    });
    f.ports.tiebaParticipation!.listThreads = async () => [
      { ...f.thread("1002"), forumId: "202", forumName: "其他" },
    ];
    await f.service.discover({ targetId: "tiebatarget_other" });
    assert.equal(
      f.service.store.candidate(otherCandidate.id)!.targetId,
      target.id,
    );
    assert.deepEqual(
      f.service.store.candidate(otherCandidate.id)!.stamp,
      otherStamp,
    );
    await f.service.reconcile({ draftId: draft.id });
    assert.equal(f.service.snapshot().drafts[0].status, "verified");
    assert.equal(f.submissions, 1);
  } finally {
    await f.close();
  }
});

test("贴吧回复：超过300条历史后旧未知草稿及关联候选仍保留恢复入口", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    f.unknown = true;
    await f.service.submit({
      draftId: draft.id,
      version: draft.version,
      confirmed: true,
    });
    const original = f.service.store.draft(draft.id)!;
    const candidate = f.service.store.candidate(draft.candidateId)!;
    f.db.transaction(() => {
      for (let index = 0; index < 301; index++) {
        const threadId = String(2000 + index),
          candidateId = `tiebacandidate_history${index}`;
        f.service.store.saveCandidate({
          ...candidate,
          id: candidateId,
          threadId,
          url: `https://tieba.baidu.com/p/${threadId}`,
          context: null,
          status: "discovered",
        });
        f.service.store.saveDraft({
          ...original,
          id: `tiebareply_history${index}`,
          candidateId,
          threadId,
          status: "verified",
          receipt: {
            status: "verified",
            threadId,
            postId: String(9000 + index),
            url: `https://tieba.baidu.com/p/${threadId}#${9000 + index}`,
            authorUid: "111",
            body: original.body,
            checkedAt: new Date(f.time).toISOString(),
            message: "专用已完成历史",
          },
        });
      }
    });
    const snapshot = f.service.snapshot();
    assert.ok(
      snapshot.drafts.some(
        (row) => row.id === draft.id && row.status === "uncertain",
      ),
    );
    assert.ok(
      snapshot.candidates.some(
        (row) => row.id === draft.candidateId && row.context?.body === source,
      ),
    );
    assert.equal(
      snapshot.drafts.filter((row) => row.status === "verified").length,
      300,
    );
    await f.service.reconcile({ draftId: draft.id });
    assert.equal(f.service.store.draft(draft.id)!.status, "verified");
    assert.equal(f.submissions, 1);
  } finally {
    await f.close();
  }
});

test("贴吧回复：自动授权在模型请求前撤销不付费，返回付费正文后撤销保留原稿", async () => {
  const f = await fixture();
  try {
    await f.service.discover({ targetId: "tiebatarget_reply" });
    const candidate = f.service.snapshot().candidates[0];
    await f.service.read({ candidateId: candidate.id });
    let checks = 0;
    await f.service.generate(
      { candidateId: candidate.id, confirmed: true },
      () => {
        if (++checks >= 2)
          throw new AppError("TIEBA_AUTOMATION_REVOKED", "自动授权已撤销");
      },
    );
    assert.equal(f.calls, 0);
    assert.equal(f.service.snapshot().drafts[0].status, "failed");
    assert.equal(f.service.store.generations()[0].status, "failed");
    let enabled = true;
    f.duringAi = async () => {
      enabled = false;
    };
    await f.service.generate(
      { candidateId: candidate.id, confirmed: true },
      () => {
        if (!enabled)
          throw new AppError("TIEBA_AUTOMATION_REVOKED", "自动授权已撤销");
      },
    );
    const paid = f.service.snapshot().drafts[0];
    assert.equal(f.calls, 1);
    assert.equal(paid.status, "draft");
    assert.equal(paid.body, reply);
    assert.equal(
      f.service.store.generations().filter((row) => row.status === "success")
        .length,
      1,
    );
    assert.equal(f.submissions, 0);
  } finally {
    await f.close();
  }
});

test("贴吧回复：自动授权在官网提交检查点前撤销不点击且保留草稿", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    let enabled = true;
    f.before = async () => {
      enabled = false;
    };
    await f.service.submit(
      { draftId: draft.id, version: draft.version, confirmed: true },
      () => {
        if (!enabled)
          throw new AppError("TIEBA_AUTOMATION_REVOKED", "自动授权已撤销");
      },
    );
    const saved = f.service.snapshot().drafts[0];
    assert.equal(f.submissions, 0);
    assert.equal(saved.status, "draft");
    assert.equal(saved.submittedAt, null);
    assert.equal(saved.body, reply);
  } finally {
    await f.close();
  }
});

test("贴吧回复：同账号主题未知阻断回帖，主题真实提交也纳入全局60秒间隔", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    migrateTiebaTopics(f.db.db);
    f.db.run(
      "INSERT INTO tieba_topic_drafts(id,target_id,uid,forum_id,status,version,submitted_at,body_hash,data) VALUES(?,?,?,?,?,?,?,?,?)",
      "tiebatopic_guard",
      "tiebatarget_reply",
      "111",
      "101",
      "uncertain",
      1,
      null,
      "hash",
      "{}",
    );
    await assert.rejects(
      f.service.submit({
        draftId: draft.id,
        version: draft.version,
        confirmed: true,
      }),
      { code: "TIEBA_TOPIC_UNCERTAIN_BLOCK" },
    );
    f.db.run(
      "UPDATE tieba_topic_drafts SET status='pending_review' WHERE id=?",
      "tiebatopic_guard",
    );
    await assert.rejects(
      f.service.submit({
        draftId: draft.id,
        version: draft.version,
        confirmed: true,
      }),
      { code: "TIEBA_TOPIC_UNCERTAIN_BLOCK" },
    );
    f.db.run(
      "UPDATE tieba_topic_drafts SET status='verified',submitted_at=? WHERE id=?",
      new Date(f.time).toISOString(),
      "tiebatopic_guard",
    );
    await assert.rejects(
      f.service.submit({
        draftId: draft.id,
        version: draft.version,
        confirmed: true,
      }),
      { code: "TIEBA_REPLY_INTERVAL" },
    );
    assert.equal(f.submissions, 0);
    f.time += 60000;
    await f.service.submit({
      draftId: draft.id,
      version: draft.version,
      confirmed: true,
    });
    assert.equal(f.submissions, 1);
  } finally {
    await f.close();
  }
});

test("贴吧回复：AI声明来源只在保留实际AI正文后设置，人工编辑保留，旧稿兼容", async () => {
  for (const kind of ["paid", "empty", "legacy"] as const) {
    const f = await fixture();
    try {
      if (kind === "empty")
        f.aiResult = {
          publishable: false,
          body: "",
          reason: "不适合自动回复",
          evidence,
        };
      let draft = await f.prepare();
      assert.equal(
        f.service.store.draft(draft.id)!.aiGenerated,
        kind !== "empty",
      );
      draft = f.service
        .saveDraft({ draftId: draft.id, version: draft.version, body: reply })
        .drafts.find((row) => row.id === draft.id)!;
      if (kind === "legacy") {
        const raw = f.service.store.draft(draft.id)!;
        delete raw.aiGenerated;
        f.service.store.saveDraft(raw);
      }
      await f.service.submit({
        draftId: draft.id,
        version: draft.version,
        confirmed: true,
      });
      assert.equal(f.replyOptions[0].aiGenerated, kind !== "empty");
    } finally {
      await f.close();
    }
  }
});

test("贴吧回复：同UID重新登录可只读核对，原提交stamp不恢复写入资格，异UID不读取", async () => {
  for (const same of [true, false]) {
    const f = await fixture();
    try {
      f.unknown = true;
      const original = await f.prepare();
      await f.service.submit({
        draftId: original.id,
        version: original.version,
        confirmed: true,
      });
      const stamp = f.service.store.draft(original.id)!.stamp;
      f.environments.invalidateIdentity({ kind: "website", id: f.account.id });
      if (!same) f.uid = "999";
      await f.accounts.verify(f.account.id);
      const reads = f.networkReads;
      if (same) {
        await f.service.reconcile({ draftId: original.id });
        assert.equal(f.service.store.draft(original.id)!.status, "verified");
        assert.deepEqual(f.service.store.draft(original.id)!.stamp, stamp);
        assert.equal(f.networkReads, reads + 1);
      } else {
        await assert.rejects(f.service.reconcile({ draftId: original.id }));
        assert.equal(f.networkReads, reads);
      }
      assert.equal(f.submissions, 1);
    } finally {
      await f.close();
    }
  }
});

test("资源发帖未知时原回复不提交，核实后仍遵守提交间隔", async () => {
  const f = await fixture();
  try {
    const draft = await f.prepare();
    const post = {
      id: "tiebapublishing_guard",
      uid: draft.uid,
      status: "uncertain",
      submittedAt: new Date(f.time).toISOString(),
    };
    f.db.setSetting(tiebaPublishingIndexKey, [post.id]);
    f.db.setSetting(`tieba-publishing:draft:v1:${post.id}`, post);
    await assert.rejects(
      f.service.submit({
        draftId: draft.id,
        version: draft.version,
        confirmed: true,
      }),
      { code: "TIEBA_PUBLISHING_UNCERTAIN_BLOCK" },
    );
    assert.equal(f.submissions, 0);
    post.status = "verified";
    f.db.setSetting(`tieba-publishing:draft:v1:${post.id}`, post);
    await assert.rejects(
      f.service.submit({
        draftId: draft.id,
        version: draft.version,
        confirmed: true,
      }),
      { code: "TIEBA_REPLY_INTERVAL" },
    );
    assert.equal(f.submissions, 0);
  } finally {
    await f.close();
  }
});

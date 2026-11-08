import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../core/database";
import { AppError } from "../core/errors";
import { TiebaAutocareStore } from "../core/tieba-autocare/store";
import { TiebaAutomation } from "../core/tieba-automation/service";
import { migrateTiebaAutomation } from "../core/tieba-automation/migration";
import { stopTiebaAutomationForBackup } from "../core/tieba-automation/store";
import {
  tiebaAutomationConfigSchema,
  tiebaAutomationToggleSchema,
} from "../shared/tieba-automation";
import type {
  TiebaParticipationSnapshot,
  TiebaReplyDraft,
} from "../shared/tieba-participation";
import type { WebsiteAccount } from "../shared/website-accounts";
import type { EnvironmentStamp } from "../shared/browser-environments";
import { createTiebaAutomationHandlers } from "../core/ipc/tieba-automation";

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "tieba-automation-"));
  const db = new Database(join(folder, "test.db"));
  migrateTiebaAutomation(db.db);
  let time = Date.parse("2026-11-07T02:00:00Z"),
    disposed = false;
  const account: WebsiteAccount = {
    id: "web_auto",
    provider: "tieba",
    alias: "测试",
    uid: "111",
    status: "connected",
    createdAt: "",
    updatedAt: "",
  };
  const stamp: EnvironmentStamp = {
    environmentId: "env_auto",
    revision: 1,
    identityId: "identity_auto",
    identityRevision: 1,
  };
  let environmentChanged = false,
    generateUnknown = false,
    submitUnknown = false;
  let beforeAi: (() => Promise<void>) | undefined,
    duringAi: (() => Promise<void>) | undefined,
    beforeSubmit: (() => Promise<void>) | undefined,
    duringRead: (() => Promise<void>) | undefined;
  const counts = { discover: 0, read: 0, generate: 0, submit: 0, reconcile: 0 };
  const targets = new TiebaAutocareStore(db);
  for (let i = 1; i <= 3; i++)
    targets.saveTarget({
      id: `tiebatarget_auto${i}`,
      accountId: account.id,
      uid: "111",
      forumId: `${100 + i}`,
      name: `观察${i}`,
      url: `https://tieba.baidu.com/f?kw=${i}`,
      level: null,
      experience: null,
      signed: null,
      canSign: null,
      checkedAt: new Date(time).toISOString(),
      message: null,
      source: "observed",
      paused: false,
      pauseReason: null,
      syncedAt: new Date(time).toISOString(),
      stamp,
    });
  const data: TiebaParticipationSnapshot = {
    busy: false,
    accounts: [account],
    targets: [],
    candidates: [],
    drafts: [],
    logs: { items: [], total: 0, page: 1, pageSize: 50, folder },
    message: "",
  };
  const snapshot = () => structuredClone(data);
  const p = {
    isBusy: false,
    snapshot,
    async discover({ targetId }: { targetId: string }) {
      counts.discover++;
      const target = targets.target(targetId)!;
      const number = counts.discover + 1000;
      data.candidates.unshift({
        id: `tiebacandidate_${number}`,
        targetId,
        accountId: account.id,
        uid: "111",
        status: "discovered",
        context: null,
        message: "",
        updatedAt: new Date(time).toISOString(),
        threadId: `${number}`,
        forumId: target.forumId,
        forumName: target.name,
        title: "资料整理方法",
        url: `https://tieba.baidu.com/p/${number}`,
        authorUid: "222",
        replyCount: 0,
        lastActiveAt: null,
        discoveredAt: new Date(time).toISOString(),
      });
      return snapshot();
    },
    async read({ candidateId }: { candidateId: string }) {
      counts.read++;
      await duringRead?.();
      data.candidates.find((row) => row.id === candidateId)!.status = "read";
      return snapshot();
    },
    async generate(
      { candidateId }: { candidateId: string },
      guard?: () => void,
    ) {
      guard?.();
      await beforeAi?.();
      guard?.();
      counts.generate++;
      const candidate = data.candidates.find((row) => row.id === candidateId)!;
      const draft: TiebaReplyDraft = {
        id: `tiebareply_${candidate.threadId}`,
        candidateId,
        accountId: account.id,
        uid: "111",
        threadId: candidate.threadId,
        title: candidate.title,
        url: candidate.url,
        version: 1,
        status: "generating",
        body: "",
        evidence: [],
        checks: [],
        model: "mock",
        generationAttempts: 1,
        submittedAt: null,
        receipt: null,
        message: "",
        createdAt: new Date(time).toISOString(),
        updatedAt: new Date(time).toISOString(),
      };
      data.drafts.unshift(draft);
      await duringAi?.();
      draft.body =
        "可以按使用场景建立目录入口，优先保留少量常用类别，再用标签记录其他维度。";
      draft.status = generateUnknown ? "attention" : "ready";
      draft.message = generateUnknown ? "费用待核对" : "已生成";
      try {
        guard?.();
      } catch {
        draft.status = "draft";
      }
      return snapshot();
    },
    async submit(
      { draftId, version }: { draftId: string; version: number },
      guard?: () => void,
    ) {
      guard?.();
      const draft = data.drafts.find((row) => row.id === draftId)!;
      assert.equal(version, draft.version);
      draft.status = "submitting";
      await beforeSubmit?.();
      try {
        guard?.();
      } catch {
        draft.status = "draft";
        return snapshot();
      }
      counts.submit++;
      draft.submittedAt = new Date(time).toISOString();
      draft.version++;
      draft.status = submitUnknown ? "uncertain" : "verified";
      draft.message = submitUnknown ? "官网提交后断线，仅可核对" : "官网已核实";
      return snapshot();
    },
    async reconcile({ draftId }: { draftId: string }) {
      counts.reconcile++;
      const draft = data.drafts.find((row) => row.id === draftId)!;
      draft.status = "verified";
      draft.message = "原回复已核实";
      draft.version++;
      return snapshot();
    },
  };
  const dependencies = {
    db,
    participation: p,
    accounts: { get: () => account },
    environments: {
      forAccount: () => ({ engine: "bitbrowser" }),
      assertStamp: () => {
        if (environmentChanged)
          throw new AppError("ENVIRONMENT_CHANGED", "环境变化");
      },
    },
    dataPath: folder,
    changed: () => {},
    clock: () => time,
  } as unknown as ConstructorParameters<typeof TiebaAutomation>[0];
  let service = new TiebaAutomation(dependencies);
  const configure = (
    mode: "draft" | "publish" = "draft",
    limit = 1,
    ids = ["tiebatarget_auto1"],
  ) => {
    service.save({
      revision: service.snapshot().revision,
      config: { targetIds: ids, mode, dailyLimit: limit },
    });
    return service.toggle({
      revision: service.snapshot().revision,
      enabled: true,
      confirmed: true,
    });
  };
  return {
    db,
    targets,
    counts,
    p,
    data,
    configure,
    get service() {
      return service;
    },
    get time() {
      return time;
    },
    set time(value: number) {
      time = value;
    },
    set beforeAi(value: typeof beforeAi) {
      beforeAi = value;
    },
    set duringAi(value: typeof duringAi) {
      duringAi = value;
    },
    set beforeSubmit(value: typeof beforeSubmit) {
      beforeSubmit = value;
    },
    set duringRead(value: typeof duringRead) {
      duringRead = value;
    },
    set generateUnknown(value: boolean) {
      generateUnknown = value;
    },
    set submitUnknown(value: boolean) {
      submitUnknown = value;
    },
    set environmentChanged(value: boolean) {
      environmentChanged = value;
    },
    get account() {
      return account;
    },
    async step(n = 1) {
      for (let i = 0; i < n; i++) await service.tick();
    },
    stop() {
      service.toggle({
        revision: service.snapshot().revision,
        enabled: false,
        confirmed: true,
      });
    },
    restart() {
      service.dispose();
      service = new TiebaAutomation(dependencies);
    },
    reopen() {
      service = new TiebaAutomation(dependencies);
    },
    closeDb() {
      db.close();
      disposed = true;
    },
    async close() {
      service.dispose();
      if (!disposed) db.close();
      await rm(folder, { recursive: true, force: true });
    },
  };
}

test("automation defaults disabled and read-only; validation prevents broad limits or missing consent", async () => {
  const f = await fixture();
  try {
    const state = f.service.snapshot();
    assert.equal(state.enabled, false);
    assert.equal(state.config.mode, "draft");
    await f.step(3);
    assert.equal(f.counts.discover, 0);
    assert.equal(f.counts.generate, 0);
    assert.equal(
      tiebaAutomationConfigSchema.safeParse({ targetIds: [], dailyLimit: 3 })
        .success,
      false,
    );
    assert.equal(
      tiebaAutomationToggleSchema.safeParse({ enabled: true, revision: 1 })
        .success,
      false,
    );
    const handlers = createTiebaAutomationHandlers({
      tiebaAutomation: f.service,
    });
    assert.throws(() =>
      handlers["tieba.automation.toggle"]({
        enabled: true,
        revision: 1,
        confirmed: false,
      }),
    );
  } finally {
    await f.close();
  }
});

test("bounded persistent batch uses global daily limit, 45 minute slots, and immutable same-day deadline", async () => {
  const f = await fixture();
  try {
    const first = f.configure("draft", 2),
      tasks = first.tasks.sort((a, b) =>
        a.plannedAt.localeCompare(b.plannedAt),
      );
    assert.equal(tasks.length, 2);
    assert.equal(
      Date.parse(tasks[1].plannedAt) - Date.parse(tasks[0].plannedAt),
      45 * 60000,
    );
    assert.equal(Date.parse(first.run!.deadlineAt) - f.time, 2 * 3600000);
    const deadline = first.run!.deadlineAt;
    f.stop();
    f.time += 30 * 60000;
    f.service.toggle({
      revision: f.service.snapshot().revision,
      enabled: true,
      confirmed: true,
    });
    assert.equal(f.service.snapshot().run!.deadlineAt, deadline);
    assert.equal(f.service.snapshot().tasks.length, 2);
    await f.step();
    assert.equal(f.counts.discover, 0);
  } finally {
    await f.close();
  }
});

test("draft mode executes one persisted step per tick and never submits", async () => {
  const f = await fixture();
  try {
    f.configure();
    await f.step();
    assert.equal(f.service.snapshot().tasks[0].step, "read");
    await f.step();
    assert.equal(f.service.snapshot().tasks[0].step, "generate");
    await f.step(3);
    assert.equal(f.counts.generate, 1);
    assert.equal(f.counts.submit, 0);
    assert.equal(f.service.snapshot().tasks[0].status, "draft");
    assert.ok(f.service.snapshot().tasks[0].draftId);
  } finally {
    await f.close();
  }
});

test("publish mode reuses exact generated draft and records verified result", async () => {
  const f = await fixture();
  try {
    f.configure("publish");
    await f.step(3);
    assert.equal(f.counts.submit, 0);
    assert.equal(f.service.snapshot().tasks[0].step, "submit");
    await f.step(3);
    assert.equal(f.counts.generate, 1);
    assert.equal(f.counts.submit, 1);
    assert.equal(f.service.snapshot().tasks[0].status, "verified");
  } finally {
    await f.close();
  }
});

test("closing before the model request cancels paid work and does not retry", async () => {
  const f = await fixture();
  try {
    f.configure("publish");
    await f.step(2);
    f.beforeAi = async () => {
      f.stop();
    };
    await f.step(4);
    assert.equal(f.counts.generate, 0);
    assert.equal(f.counts.submit, 0);
    assert.equal(f.service.snapshot().tasks[0].status, "cancelled");
  } finally {
    await f.close();
  }
});

test("closing after generation has started retains paid text and cancels automatic submission", async () => {
  const f = await fixture();
  try {
    f.configure("publish");
    await f.step(2);
    f.duringAi = async () => {
      f.stop();
    };
    await f.step(4);
    assert.equal(f.counts.generate, 1);
    assert.equal(f.counts.submit, 0);
    assert.ok(f.data.drafts[0].body);
    assert.equal(f.service.snapshot().tasks[0].status, "draft");
  } finally {
    await f.close();
  }
});

test("configuration save revokes the original scope while an operation is in flight", async () => {
  const f = await fixture();
  try {
    f.configure("publish");
    f.duringRead = async () => {
      f.service.save({
        revision: f.service.snapshot().revision,
        config: {
          targetIds: ["tiebatarget_auto2"],
          mode: "publish",
          dailyLimit: 1,
        },
      });
    };
    await f.step(4);
    assert.equal(f.counts.generate, 0);
    assert.equal(f.service.snapshot().enabled, false);
    assert.equal(f.service.snapshot().tasks[0].status, "cancelled");
  } finally {
    await f.close();
  }
});

test("target pause, account identity, and environment stamp changes are checked before each step", async () => {
  for (const change of ["pause", "identity", "environment"]) {
    const f = await fixture();
    try {
      f.configure();
      await f.step(2);
      if (change === "pause") {
        const target = f.targets.target("tiebatarget_auto1")!;
        target.paused = true;
        target.pauseReason = "人工暂停";
        f.targets.saveTarget(target);
      }
      if (change === "identity") f.account.uid = "other";
      if (change === "environment") f.environmentChanged = true;
      await f.step(3);
      assert.equal(f.counts.generate, 0);
      assert.equal(f.service.snapshot().tasks[0].status, "cancelled");
    } finally {
      await f.close();
    }
  }
});

test("explicit disable immediately before the website checkpoint blocks submission", async () => {
  const f = await fixture();
  try {
    f.configure("publish");
    await f.step(3);
    f.beforeSubmit = async () => {
      f.stop();
    };
    await f.step(3);
    assert.equal(f.counts.submit, 0);
    assert.equal(f.service.snapshot().tasks[0].status, "draft");
    assert.ok(f.data.drafts[0].body);
  } finally {
    await f.close();
  }
});

test("edited draft versions lose automatic submit authority", async () => {
  const f = await fixture();
  try {
    f.configure("publish");
    await f.step(3);
    f.data.drafts[0].version++;
    await f.step(3);
    assert.equal(f.counts.submit, 0);
    assert.equal(f.service.snapshot().tasks[0].status, "draft");
  } finally {
    await f.close();
  }
});

test("unknown generation is terminal attention; unknown submission only supports explicit read-only reconciliation", async () => {
  const f = await fixture();
  try {
    f.generateUnknown = true;
    f.configure("publish");
    await f.step(6);
    assert.equal(f.counts.generate, 1);
    assert.equal(f.counts.submit, 0);
    assert.equal(f.service.snapshot().tasks[0].status, "attention");
    await assert.rejects(
      f.service.reconcile({ taskId: f.service.snapshot().tasks[0].id }),
    );
  } finally {
    await f.close();
  }
  const g = await fixture();
  try {
    g.submitUnknown = true;
    g.configure("publish");
    await g.step(6);
    const task = g.service.snapshot().tasks[0];
    assert.equal(task.status, "uncertain");
    assert.equal(g.counts.submit, 1);
    await g.service.reconcile({ taskId: task.id });
    assert.equal(g.counts.reconcile, 1);
    assert.equal(g.counts.submit, 1);
    assert.equal(g.service.snapshot().tasks[0].status, "verified");
  } finally {
    await g.close();
  }
});

test("expired and cross-day work is not caught up, and a late batch ends at Beijing midnight", async () => {
  const f = await fixture();
  try {
    f.time = Date.parse("2026-11-07T15:30:00Z");
    const state = f.configure("publish", 2);
    assert.equal(state.run!.deadlineAt, "2026-11-07T16:00:00.000Z");
    assert.equal(
      state.tasks.filter((task) => task.status === "expired").length,
      1,
    );
    f.time += 31 * 60000;
    await f.step();
    const old = f.service
      .snapshot()
      .tasks.filter((task) => task.runId === state.run!.id);
    assert.ok(old.every((task) => task.status === "expired"));
    assert.equal(f.counts.generate, 0);
    assert.equal(f.counts.submit, 0);
  } finally {
    await f.close();
  }
});

test("restart revokes intent and preserves unknown submissions without replay", async () => {
  const f = await fixture();
  try {
    f.submitUnknown = true;
    f.configure("publish");
    await f.step(4);
    const id = f.service.snapshot().tasks[0].id;
    f.restart();
    await f.step(4);
    assert.equal(f.service.snapshot().enabled, false);
    assert.equal(f.counts.submit, 1);
    assert.equal(
      f.service.snapshot().tasks.find((task) => task.id === id)!.status,
      "uncertain",
    );
    await f.service.reconcile({ taskId: id });
    assert.equal(f.counts.reconcile, 1);
  } finally {
    await f.close();
  }
});

test("backup cleanup revokes execution authority and preserves original recovery records", async () => {
  const f = await fixture();
  try {
    f.submitUnknown = true;
    f.configure("publish");
    await f.step(4);
    stopTiebaAutomationForBackup(f.db);
    assert.equal(f.service.store.state().enabled, false);
    assert.deepEqual(f.service.store.state().authorities, []);
    assert.equal(f.service.snapshot().tasks[0].status, "uncertain");
    await f.step(4);
    assert.equal(f.counts.submit, 1);
  } finally {
    await f.close();
  }
});

test("dispose prevents in-flight continuation from accessing a closed database", async () => {
  const f = await fixture();
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const begun = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    f.configure("publish");
    await f.step(2);
    f.duringAi = async () => {
      entered();
      await pending;
    };
    const running = f.service.tick();
    await begun;
    f.service.dispose();
    f.closeDb();
    release();
    await running;
    assert.equal(f.counts.submit, 0);
  } finally {
    await f.close();
  }
});

test("temporary scheduler suspension can resume without closing or renewing authority", async () => {
  const f = await fixture();
  try {
    f.configure();
    const revision = f.service.snapshot().revision;
    f.service.start(false);
    await f.step(2);
    assert.equal(f.counts.discover, 0);
    assert.equal(f.service.snapshot().enabled, true);
    assert.equal(f.service.snapshot().revision, revision);
    f.service.start(true);
    await f.step(3);
    assert.equal(f.counts.generate, 1);
    assert.equal(f.counts.submit, 0);
  } finally {
    await f.close();
  }
});

test("an interrupted generation step loses authority at restart and cannot be replayed that day", async () => {
  const f = await fixture();
  try {
    f.configure("publish");
    await f.step(2);
    const task = f.service.store.tasks()[0];
    task.status = "running";
    f.service.store.saveTask(task);
    const deadline = f.service.snapshot().run!.deadlineAt;
    f.restart();
    assert.equal(f.service.snapshot().enabled, false);
    assert.equal(f.service.snapshot().tasks[0].status, "attention");
    f.service.toggle({
      enabled: true,
      revision: f.service.snapshot().revision,
      confirmed: true,
    });
    await f.step(5);
    assert.equal(f.counts.generate, 0);
    assert.equal(f.counts.submit, 0);
    assert.equal(f.service.snapshot().run!.deadlineAt, deadline);
  } finally {
    await f.close();
  }
});

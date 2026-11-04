import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../core/errors";
import { intelligentSupplyFixture } from "./intelligent-supply-fixture";
import { createIntelligentOperationsHandlers } from "../core/ipc/intelligent-operations";
import { reconcileOperationsRoutingRejection } from "../core/intelligent-operations/brain-reconciliation";
import type { OperationsBrainHost } from "../core/intelligent-operations/brain-types";
import type { IntelligentOperationsState } from "../core/intelligent-operations/state";
import { intelligentOperationsStateKey } from "../shared/intelligent-operations";

const callId = "ai_fixture_http404";
const evidence =
  "隔离合成证据：HTTP404发生在路由过滤阶段，原始轮次未返回工具；此测试未调用服务商或查询真实账单。";
async function uncertain(status: number | null = 404) {
  const f = await intelligentSupplyFixture(),
    account = await f.addAccount(),
    plan = f.plan([account.id]);
  f.respond(async (input) => {
    f.db.run(
      "INSERT INTO api_calls(id,endpoint,phase,units,request_count,estimated_micros,reserved_micros,confirmed_micros,status,message,created_at) VALUES(?,'openrouter',?,1,1,40418,40418,NULL,'uncertain',?,?)",
      callId,
      `agent:${input.budgetScope.planId}:${input.budgetScope.cycleId}`,
      "原始历史记录：账单未知，预留预算保留。",
      new Date(f.time).toISOString(),
    );
    throw new AppError(
      "AI_COST_UNCERTAIN",
      `自主运营模型请求未完成${status === null ? "" : `（HTTP ${status}）`}，调用记录 ${callId}；实际费用待核实，禁止自动重试。`,
      true,
    );
  });
  f.enable(plan);
  await f.ops.tick();
  const cycle = f.ops.brainCycles({ planId: plan.id }).items[0];
  assert.equal(cycle.status, "uncertain");
  assert.equal(cycle.steps.length, 0);
  f.ops.scheduler(false);
  f.ops.activate(plan.id, false);
  const input = {
    planId: plan.id,
    cycleId: cycle.id,
    callId,
    evidence,
    confirmed: true as const,
  };
  return { f, plan, cycle, input };
}

test("人工404核对只释放精确原预留，保留历史/证据/日志，不授权、不唤醒、不重放", async () => {
  const { f, plan, cycle, input } = await uncertain();
  try {
    const previous = f.db.get<{ message: string }>(
        "SELECT message FROM api_calls WHERE id=?",
        callId,
      )!.message,
      count = f.turns.length,
      handlers = createIntelligentOperationsHandlers({ intelligentOps: f.ops });
    const result =
      handlers["intelligentOps.brain.reconcileRoutingRejection"](input);
    const row = f.db.get<{
      status: string;
      message: string;
      confirmed_micros: number;
      reserved_micros: number;
      estimated_micros: number;
    }>("SELECT * FROM api_calls WHERE id=?", callId)!;
    assert.equal(row.status, "failed");
    assert.equal(row.confirmed_micros, 0);
    assert.equal(row.reserved_micros, 0);
    assert.equal(row.estimated_micros, 40418);
    assert.ok(row.message.startsWith(previous + "\n"));
    assert.match(row.message, /不是服务商账单查询或请求重试/);
    assert.ok(row.message.includes(evidence));
    assert.match(
      row.message,
      /https:\/\/openrouter.ai\/docs\/api_reference\/errors-and-debugging/,
    );
    const after = f.ops.brainCycles({ planId: plan.id }).items[0];
    assert.equal(after.id, cycle.id);
    assert.equal(after.status, "failed");
    assert.equal(after.costKnown, true);
    assert.equal(after.costMicros, 0);
    assert.equal(after.steps.length, 0);
    assert.ok(after.summary.startsWith(cycle.summary + "\n"));
    assert.equal(
      result.plans.find((p) => p.planId === plan.id)!.authorized,
      false,
    );
    assert.equal(f.ops.snapshot().runtime.running, false);
    assert.equal(
      f.ops.snapshot().plans.find((p) => p.id === plan.id)!.active,
      false,
    );
    await f.ops.tick();
    assert.equal(f.turns.length, count);
    assert.equal(f.submissions, 0);
    const log = f.ops.logs.read({ search: "routing_rejection_reconciled" })
      .items[0];
    assert.equal(log.details.priorReservedMicros, 40418);
    assert.equal(log.details.priorMessage, previous);
    assert.equal(log.details.evidence, evidence);
    assert.throws(() => f.ops.brainReconcileRoutingRejection(input), /原轮次/);
  } finally {
    await f.close();
  }
});

for (const status of [null, 408, 429, 502]) {
  test(`HTTP ${status ?? "未知/200正文错误"}不冒充明确路由404，继续保留unknown`, async () => {
    const { f, input } = await uncertain(status);
    try {
      assert.throws(
        () => f.ops.brainReconcileRoutingRejection(input),
        /HTTP 404 证据/,
      );
      const row = f.db.get<{
        status: string;
        reserved_micros: number;
        confirmed_micros: null;
      }>("SELECT * FROM api_calls WHERE id=?", callId)!;
      assert.equal(row.status, "uncertain");
      assert.equal(row.reserved_micros, 40418);
      assert.equal(row.confirmed_micros, null);
    } finally {
      await f.close();
    }
  });
}

test("404核对拒绝错误callID、额外API行、已知费用、仍在启用的计划及未确认参数", async () => {
  const { f, plan, input } = await uncertain();
  try {
    assert.throws(() =>
      f.ops.brainReconcileRoutingRejection({ ...input, confirmed: false }),
    );
    assert.throws(
      () =>
        f.ops.brainReconcileRoutingRejection({ ...input, callId: "ai_other" }),
      /精确对应/,
    );
    f.ops.activate(plan.id, true);
    assert.throws(
      () => f.ops.brainReconcileRoutingRejection(input),
      /完全停止/,
    );
    f.ops.activate(plan.id, false);
    const row = f.db.get<{ phase: string }>(
      "SELECT phase FROM api_calls WHERE id=?",
      callId,
    )!;
    f.db.run(
      "INSERT INTO api_calls(id,endpoint,phase,units,status,created_at) VALUES('ai_other','openrouter',?,1,'failed',?)",
      row.phase,
      new Date(f.time).toISOString(),
    );
    assert.throws(
      () => f.ops.brainReconcileRoutingRejection(input),
      /不是唯一/,
    );
    f.db.run("DELETE FROM api_calls WHERE id='ai_other'");
    f.db.run("UPDATE api_calls SET confirmed_micros=1 WHERE id=?", callId);
    assert.throws(
      () => f.ops.brainReconcileRoutingRejection(input),
      /不是唯一/,
    );
  } finally {
    await f.close();
  }
});

test("0steps不是免账证据：只要轮次存在任务、自产稿或记忆就拒绝404核对", async () => {
  const { f, plan, cycle, input } = await uncertain();
  try {
    const state = f.db.setting<IntelligentOperationsState>(
        intelligentOperationsStateKey,
        {} as IntelligentOperationsState,
      ),
      host: OperationsBrainHost = {
        d: { db: f.db } as OperationsBrainHost["d"],
        state: () => state,
        plan: () => state.plans.find((p) => p.id === plan.id)!,
        running: () => false,
        closed: () => false,
        now: () => f.time,
        persist: () => {
          assert.fail("Rejected reconciliation must not persist");
        },
        saveTask: () => {
          throw new Error("Unexpected task write");
        },
        accountPolicy: () => {
          throw new Error("Unexpected policy call");
        },
        baseReason: () => null,
        publicationSlot: () => null,
        execute: async () => {
          assert.fail("Never execute tools");
        },
        stopOwned: () => {
          assert.fail("Never cancel existing tasks");
        },
        log: () => {
          assert.fail("Rejected reconciliation must not log success");
        },
      };
    state.tasks.push({
      brainCycleId: cycle.id,
    } as IntelligentOperationsState["tasks"][number]);
    assert.throws(
      () => reconcileOperationsRoutingRejection(host, input),
      /已有任务或业务产物/,
    );
    state.tasks = [];
    state.brain.provenance.push({
      cycleId: cycle.id,
    } as IntelligentOperationsState["brain"]["provenance"][number]);
    assert.throws(
      () => reconcileOperationsRoutingRejection(host, input),
      /已有任务或业务产物/,
    );
    state.brain.provenance = [];
    state.brain.memory.push({
      cycleId: cycle.id,
    } as IntelligentOperationsState["brain"]["memory"][number]);
    assert.throws(
      () => reconcileOperationsRoutingRejection(host, input),
      /已有任务或业务产物/,
    );
    assert.equal(
      f.db.get<{ status: string }>(
        "SELECT status FROM api_calls WHERE id=?",
        callId,
      )!.status,
      "uncertain",
    );
  } finally {
    await f.close();
  }
});

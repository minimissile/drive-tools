import test from "node:test";
import assert from "node:assert/strict";
import { intelligentSupplyFixture } from "./intelligent-supply-fixture";
import type { OperationsTask } from "../shared/intelligent-operations";
import { intelligentOperationsStateKey } from "../shared/intelligent-operations";
import { restoreIntelligentOperationsState } from "../core/intelligent-operations/state";

type Fixture = Awaited<ReturnType<typeof intelligentSupplyFixture>>;
const pending = (f: Fixture, planId: string) =>
  f.ops.tasks({ planId, horizon: "all" }).items;
async function supplied(f: Fixture, accountId: string) {
  const p = f.plan([accountId]),
    draft = await f.readySupply(p.id, accountId),
    delivered = await f.supply.deliver({
      id: draft.id,
      version: draft.version,
      channel: "zhihu",
      accountId,
      confirmed: true,
    }),
    delivery = delivered.draft.deliveries[0],
    content = f.service.store.get("zhihu_contents", delivery.targetId);
  f.service.review(content.id, content.version);
  const linked = f.supply.linkPlan(
    delivered.draft.id,
    delivered.draft.version,
    "zhihu",
  );
  assert.equal(linked.deliveries[0].planLinked, true);
  return {
    plan: f.ops.snapshot().plans.find((v) => v.id === p.id)!,
    materialId: `zhihu:${content.id}`,
    content,
    draft: linked,
  };
}
function publishSequence(
  f: Fixture,
  planId: string,
  materialId: string,
  accountId: string,
) {
  let index = 0;
  f.respond(async (input) => {
    assert.equal(
      input.tools.some((v) => v.function.name === "create_original"),
      false,
    );
    assert.equal(
      input.tools.some((v) => v.function.name === "review_own"),
      false,
    );
    const step = index++;
    if (step === 0) return f.tool("inspect_material", { materialId });
    if (step === 1)
      return f.tool("schedule_publication", {
        materialId,
        accountId,
        earliestAt: new Date(f.time).toISOString(),
        reason: "按本人已审来源稿安排，遵守账号额度与出口错峰。",
      });
    if (step === 2) {
      const task = pending(f, planId).find((t) => t.materialId === materialId)!;
      assert.ok(task, "The model must execute the original planned task");
      return f.tool("execute_task", { taskId: task.id });
    }
    return f.tool("finish", {
      summary: "已读取真实工具结果，保留原发布任务与回执。",
    });
  });
}

test(
  "供稿关联：本地神评与图片可交付；外部稿未自动审核，空scope精确追加且幂等",
  { timeout: 10000 },
  async () => {
    const f = await intelligentSupplyFixture();
    try {
      const a = await f.addAccount(),
        b = await f.addAccount("模拟8号", 1),
        p = f.plan([a.id, b.id]),
        draft = await f.readySupply(p.id, a.id);
      const invalid = f.supply.save({
        id: draft.id,
        version: draft.version,
        editorial: {
          ...draft.editorial,
          commentBasis: "unknown",
          commentEvidence: "",
        },
      });
      await assert.rejects(
        f.supply.deliver({
          id: invalid.id,
          version: invalid.version,
          channel: "zhihu",
          accountId: a.id,
          confirmed: true,
        }),
        /使用依据/,
      );
      assert.equal(f.service.snapshot().contents.length, 0);
      const valid = f.supply.save({
          id: invalid.id,
          version: invalid.version,
          editorial: draft.editorial,
        }),
        first = await f.supply.deliver({
          id: valid.id,
          version: valid.version,
          channel: "zhihu",
          accountId: a.id,
          confirmed: true,
        }),
        targetId = first.draft.deliveries[0].targetId,
        content = f.service.store.get("zhihu_contents", targetId);
      assert.equal(content.reviewed, false);
      assert.equal(content.source!.provider, "pipix");
      assert.equal(content.source!.editorial!.accountId, a.id);
      assert.equal(content.images.length, 1);
      assert.match(content.body, /引用评论（热心网友）/);
      assert.equal(content.source!.editorial!.rights.length, 3);
      const duplicate = await f.supply.deliver({
        id: first.draft.id,
        version: first.draft.version,
        channel: "zhihu",
        accountId: a.id,
        confirmed: true,
      });
      assert.equal(duplicate.existing, true);
      assert.equal(f.service.snapshot().contents.length, 1);
      assert.throws(
        () => f.ops.linkSuppliedMaterial(p.id, `zhihu:${targetId}`, b.id),
        /其他账号/,
      );
      const linked = f.supply.linkPlan(
          first.draft.id,
          first.draft.version,
          "zhihu",
        ),
        updated = f.ops.snapshot().plans.find((plan) => plan.id === p.id)!;
      assert.equal(linked.deliveries[0].planLinked, true);
      assert.deepEqual(updated.materialIds, [`zhihu:${targetId}`]);
      assert.equal(updated.active, false);
      const revision = updated.revision;
      f.ops.linkSuppliedMaterial(p.id, `zhihu:${targetId}`, a.id);
      assert.equal(
        f.ops.snapshot().plans.find((plan) => plan.id === p.id)!.revision,
        revision,
      );
      assert.equal(f.submissions, 0);
      assert.equal(f.turns.length, 0);
      assert.equal(
        f.db.get<{ n: number }>(
          "SELECT COUNT(*) n FROM api_calls WHERE endpoint='tikhub:pipix'",
        )!.n,
        0,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "完整隔离闭环：来源供稿→本人准确审阅→brain排期→原managed执行器→回执，未伪造原创来源",
  { timeout: 10000 },
  async () => {
    const f = await intelligentSupplyFixture();
    try {
      const a = await f.addAccount(),
        packet = await supplied(f, a.id);
      publishSequence(f, packet.plan.id, packet.materialId, a.id);
      f.enable(packet.plan);
      await f.ops.tick();
      const task = pending(f, packet.plan.id).find(
        (t) => t.materialId === packet.materialId,
      )!;
      assert.equal(task.status, "completed", task.reason);
      assert.equal(task.url, "https://zhuanlan.zhihu.com/p/10001");
      assert.ok(task.submittedAt);
      assert.equal(f.submissions, 1);
      assert.equal(
        f.service.snapshot().running,
        false,
        "Managed execution must not start the domain auto allocator",
      );
      assert.equal(f.service.snapshot().tasks.length, 1);
      assert.equal(f.service.snapshot().tasks[0].id, task.linkedTaskId);
      const state = f.db.setting<{ brain: { provenance: unknown[] } }>(
        intelligentOperationsStateKey,
        { brain: { provenance: [] } },
      );
      assert.deepEqual(state.brain.provenance, []);
      assert.equal(
        f.service.store.get("zhihu_contents", packet.content.id).source!.itemId,
        packet.content.source!.itemId,
      );
      assert.equal(
        f.ops.brainCycles({ planId: packet.plan.id }).items[0].costMicros,
        0,
      );
      await f.ops.tick();
      assert.equal(f.submissions, 1, "Completed content is never replayed");
    } finally {
      await f.close();
    }
  },
);

test(
  "双号目标：一个已达Lv5仍为未达账号继续；全部官方达标后不再请求模型或取消已提交历史",
  { timeout: 10000 },
  async () => {
    const f = await intelligentSupplyFixture();
    try {
      const a = await f.addAccount("模拟7号", 4),
        b = await f.addAccount("模拟8号", 1),
        packet = await supplied(f, a.id),
        p = f.ops.save({
          ...packet.plan,
          accounts: [
            { accountId: a.id, channel: "zhihu" },
            { accountId: b.id, channel: "zhihu" },
          ],
        });
      publishSequence(f, p.id, packet.materialId, a.id);
      f.enable(p);
      await f.ops.tick();
      const original = pending(f, p.id).find(
        (t) => t.materialId === packet.materialId,
      )!;
      assert.equal(original.status, "completed");
      f.levels.set(a.id, 5);
      await f.service.checkProgress(a.id);
      const before = f.turns.length;
      f.respond(async () =>
        f.tool("finish", {
          summary: "7号已达标，8号尚未达标，本计划继续观察8号。",
        }),
      );
      f.ops.brainWake(p.id);
      await f.ops.tick();
      assert.equal(f.turns.length, before + 1);
      assert.equal(
        f.ops.brainSnapshot().plans.find((v) => v.planId === p.id)!.authorized,
        true,
      );
      f.levels.set(b.id, 5);
      await f.service.checkProgress(b.id);
      const turns = f.turns.length;
      await f.ops.tick();
      const runtime = f.ops
        .brainSnapshot()
        .plans.find((v) => v.planId === p.id)!;
      assert.equal(runtime.authorized, false);
      assert.equal(runtime.nextWakeAt, null);
      assert.match(runtime.message, /全部知乎养号账号.*目标/);
      assert.equal(f.turns.length, turns);
      assert.deepEqual(
        pending(f, p.id).find((t) => t.id === original.id),
        original,
      );
      assert.equal(f.service.snapshot().tasks[0].status, "published");
      assert.throws(
        () =>
          f.ops.brainActivate(
            p.id,
            true,
            { read: true, create: false, reviewOwn: false, publish: true },
            p.revision,
          ),
        /目标等级/,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "官方进度工具在轮次中确认达标时，后续模型请求立即停止；人工等级不冒充官方目标完成",
  { timeout: 10000 },
  async () => {
    const f = await intelligentSupplyFixture();
    try {
      const a = await f.addAccount(),
        p = f.plan([a.id]);
      f.enable(p);
      f.service.record(a.id, true, 5, "隔离测试人工登记，尚不能替代官方核验。");
      f.respond(async () =>
        f.tool("finish", { summary: "人工记录不能替代官方目标核验。" }),
      );
      await f.ops.tick();
      assert.equal(f.turns.length, 1);
      assert.equal(
        f.ops.brainSnapshot().plans.find((v) => v.planId === p.id)!.authorized,
        true,
      );
      f.levels.set(a.id, 4);
      await f.service.checkProgress(a.id);
      f.ops.brainWake(p.id);
      f.levels.set(a.id, 5);
      f.respond(async () => f.tool("read_progress", { accountId: a.id }));
      await f.ops.tick();
      assert.equal(
        f.turns.length,
        2,
        "No extra finish/model turn is charged after the official goal is reached",
      );
      const cycle = f.ops.brainCycles({ planId: p.id }).items[0];
      assert.equal(cycle.status, "stopped");
      assert.match(cycle.summary, /全部知乎养号账号/);
      assert.equal(f.submissions, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "未知提交：保留submittedAt与原任务、撤自主授权，后续tick及恢复均不重发",
  { timeout: 10000 },
  async () => {
    const f = await intelligentSupplyFixture();
    try {
      const a = await f.addAccount(),
        packet = await supplied(f, a.id);
      publishSequence(f, packet.plan.id, packet.materialId, a.id);
      f.setUnknown(true);
      f.enable(packet.plan);
      await f.ops.tick();
      const task = pending(f, packet.plan.id).find(
        (t) => t.materialId === packet.materialId,
      )!;
      assert.equal(task.status, "attention", task.reason);
      assert.ok(task.submittedAt);
      assert.equal(f.submissions, 1);
      assert.equal(
        f.ops.brainSnapshot().plans.find((v) => v.planId === packet.plan.id)!
          .authorized,
        false,
      );
      const calls = f.turns.length;
      await f.ops.tick();
      f.advance(3600000);
      await f.ops.tick();
      assert.equal(f.turns.length, calls);
      assert.equal(f.submissions, 1);
      const restored = restoreIntelligentOperationsState(
          f.db.setting(intelligentOperationsStateKey, {}),
        ),
        restoredTask = restored.tasks.find((t) => t.id === task.id)!;
      assert.equal(restoredTask.submittedAt, task.submittedAt);
      assert.equal(restoredTask.linkedTaskId, task.linkedTaskId);
      assert.equal(restored.plans[0].active, false);
    } finally {
      await f.close();
    }
  },
);

test(
  "提交前暂停：填写期间撤权可阻止实际提交，原执行记录保留不自动重排",
  { timeout: 10000 },
  async () => {
    const f = await intelligentSupplyFixture();
    try {
      const a = await f.addAccount(),
        packet = await supplied(f, a.id);
      publishSequence(f, packet.plan.id, packet.materialId, a.id);
      f.before(async () => {
        f.ops.activate(packet.plan.id, false);
      });
      f.enable(packet.plan);
      await f.ops.tick();
      const task = pending(f, packet.plan.id).find(
        (t) => t.materialId === packet.materialId,
      )!;
      assert.equal(f.submissions, 0);
      assert.equal(task.status, "attention");
      assert.equal(task.submittedAt, null);
      assert.ok(task.linkedTaskId);
      assert.equal(
        f.ops.brainSnapshot().plans.find((v) => v.planId === packet.plan.id)!
          .authorized,
        false,
      );
      await f.ops.tick();
      assert.equal(f.service.snapshot().tasks.length, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  "已审核版本变更：模型安排旧版本后原稿变动，不填写也不提交",
  { timeout: 10000 },
  async () => {
    const f = await intelligentSupplyFixture();
    try {
      const a = await f.addAccount(),
        packet = await supplied(f, a.id);
      let index = 0;
      f.respond(async () => {
        if (index++ === 0)
          return f.tool("schedule_publication", {
            accountId: a.id,
            materialId: packet.materialId,
            earliestAt: new Date(f.time).toISOString(),
            reason: "使用准确审阅版本，修改后重新审阅。",
          });
        if (index === 2) {
          const c = f.service.store.get("zhihu_contents", packet.content.id);
          f.service.saveContent({
            ...c,
            body: `${c.body}\n新加一句尚未经审阅的判断。`,
          });
          const t = pending(f, packet.plan.id).find(
            (t) => t.materialId === packet.materialId,
          )!;
          return f.tool("execute_task", { taskId: t.id });
        }
        return f.tool("finish", {
          summary: "内容已变化，需要本人重新审阅准确版本。",
        });
      });
      f.enable(packet.plan);
      await f.ops.tick();
      assert.equal(f.submissions, 0);
      assert.equal(f.service.snapshot().tasks.length, 0);
      assert.equal(
        f.service.store.get("zhihu_contents", packet.content.id).reviewed,
        false,
      );
      const task: OperationsTask = pending(f, packet.plan.id).find(
        (t) => t.materialId === packet.materialId,
      )!;
      assert.notEqual(task.status, "completed");
    } finally {
      await f.close();
    }
  },
);

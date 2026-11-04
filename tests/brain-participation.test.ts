import test from "node:test";
import assert from "node:assert/strict";
import { intelligentSupplyFixture } from "./intelligent-supply-fixture";
import {
  executeParticipationTool,
  preparedParticipationAnswers,
} from "../core/intelligent-operations/brain-participation";
import {
  executeOperationsBrainTool,
  operationsBrainTools,
} from "../core/intelligent-operations/brain-tools";
import type { OperationsBrainToolContext } from "../core/intelligent-operations/brain-types";
import type { IntelligentOperationsState } from "../core/intelligent-operations/state";
import {
  intelligentOperationsStateKey,
  type OperationsPlan,
} from "../shared/intelligent-operations";
import type { OperationsBrainPermissions } from "../shared/operations-brain";

type Fixture = Awaited<ReturnType<typeof intelligentSupplyFixture>>;
const question = "https://www.zhihu.com/question/123456789";
const permissions: OperationsBrainPermissions = {
  read: true,
  create: true,
  reviewOwn: true,
  publish: true,
};
const readOnly: OperationsBrainPermissions = {
  read: true,
  create: false,
  reviewOwn: false,
  publish: false,
};
function installPort(f: Fixture) {
  let calls = 0;
  f.ports.zhihuParticipation = {
    discover: async () => {
      calls++;
      return [
        {
          kind: "question",
          url: question,
          title: "怎样记录具体观察？",
          excerpt: "公开问题摘要，尚未读取完整背景。",
        },
      ];
    },
    inspect: async () => {
      calls++;
      return {
        kind: "question",
        url: question,
        title: "怎样记录具体观察？",
        text: "问题：怎样区分看到的事实和自己的推测？补充：希望给出日常可以尝试的简单记录方法。",
        observedAt: new Date().toISOString(),
        related: [],
      };
    },
  };
  return () => calls;
}
/** Narrow helper context for permission rejection; execution integration below uses the real runtime. */
function context(
  f: Fixture,
  plan: OperationsPlan,
  allowed = permissions,
): OperationsBrainToolContext {
  const state = f.db.setting<IntelligentOperationsState>(
    intelligentOperationsStateKey,
    {
      version: 1,
      plans: [],
      tasks: [],
      brain: { cycles: [], memory: [], provenance: [], drafts: [] },
    },
  );
  return {
    plan,
    permissions: allowed,
    toolCallId: "fixture-permission-call",
    cycle: {
      id: "iocycle_fixture",
      planId: plan.id,
      planRevision: plan.revision,
      status: "running",
      model: "mock/operations-tools",
      startedAt: new Date(f.time).toISOString(),
      finishedAt: null,
      nextWakeAt: null,
      summary: "隔离权限边界",
      costMicros: 0,
      costKnown: true,
      steps: [],
    },
    guard: (permission = "read") => {
      if (!allowed[permission]) throw new Error(`没有${permission}权限`);
    },
    host: {
      d: f.dependencies,
      state: () => state,
      plan: () => plan,
      running: () => true,
      closed: () => false,
      now: () => f.time,
      persist: () => {
        assert.fail("Permission helper should not persist central state");
      },
      saveTask: () => {
        throw new Error("Unexpected task creation in helper check");
      },
      accountPolicy: () => plan.channels[0],
      baseReason: () => null,
      publicationSlot: () => null,
      execute: async () => {
        assert.fail("Only the actual runtime may execute test publications");
      },
      stopOwned: () => {},
      log: () => {},
    },
  };
}
async function preparedFixture() {
  const f = await intelligentSupplyFixture({ participation: true });
  const calls = installPort(f),
    account = await f.addAccount(),
    base = f.plan([account.id]),
    plan = f.ops.save({ ...base, brain: { ...base.brain, permissions } });
  let step = 0;
  f.respond(async () => {
    if (step++ === 0)
      return f.tool("discover_zhihu", {
        accountId: account.id,
        query: "生活观察",
        kind: "question",
      });
    const candidate = f.participation!.snapshot().candidates[0];
    if (step === 2)
      return f.tool("read_zhihu", {
        accountId: account.id,
        candidateId: candidate.id,
      });
    if (step === 3)
      return f.tool("plan_zhihu_participation", {
        accountId: account.id,
        candidateId: candidate.id,
        kind: "answer",
        reason: "依据已保存的问题背景，先准备可供本人审阅的具体方法。",
      });
    const activity = f.participation!.snapshot().activities[0];
    if (step === 4)
      return f.tool("prepare_zhihu_answer", {
        activityId: activity.id,
        title: "先分开记录事实与解释",
        body: "先用两栏记录：第一栏写实际观察到的细节，第二栏写自己的解释。回看时逐项检查哪些解释仍有证据，具体方法应按自己的场景调整。",
        basis:
          "依据本次官方问题和补充给出通用方法，没有声称亲测或伪造经历、数据。",
      });
    if (step === 5)
      return f.tool("inspect_material", {
        materialId: `zhihu:${activity.contentId}`,
      });
    return f.tool("finish", {
      summary: "回答草稿已保存，等待本人审核准确版本；尚未发布。",
    });
  });
  f.enable(plan, permissions);
  await f.ops.tick();
  const activity = f.participation!.snapshot().activities[0];
  assert.equal(activity.status, "prepared");
  assert.ok(activity.contentId);
  return {
    f,
    plan,
    account,
    activity,
    calls,
    materialId: `zhihu:${activity.contentId}`,
  };
}
function scheduleAndExecute(
  f: Fixture,
  planId: string,
  accountId: string,
  materialId: string,
  future = false,
) {
  let step = 0;
  f.respond(async () => {
    if (step++ === 0)
      return f.tool("schedule_publication", {
        accountId,
        materialId,
        earliestAt: new Date(f.time + (future ? 3600000 : 0)).toISOString(),
        reason: "只使用已人工审核的账号专用准确版本，并遵守原发布规则。",
      });
    if (!future && step === 2) {
      const task = f.ops
        .tasks({ planId, horizon: "all" })
        .items.find((t) => t.materialId === materialId)!;
      return f.tool("execute_task", { taskId: task.id });
    }
    return f.tool("finish", {
      summary: "保留真实排期和执行结果，未宣称人工互动或升级完成。",
    });
  });
  f.ops.brainWake(planId);
}

test("原生参与工具只认当前计划启用账号；read不能创建回答，其他计划任务不能认领", async () => {
  const f = await intelligentSupplyFixture({ participation: true });
  try {
    const count = installPort(f),
      a = await f.addAccount(),
      b = await f.addAccount("暂停模拟账号"),
      outside = await f.addAccount("计划外模拟账号"),
      base = f.plan([a.id, b.id]),
      p = f.ops.save({
        ...base,
        accounts: base.accounts.map((item) => ({
          ...item,
          paused: item.accountId === b.id,
        })),
        brain: { ...base.brain, permissions },
      }),
      ctx = context(f, p);
    assert.equal(
      operationsBrainTools(readOnly).some(
        (tool) => tool.function.name === "prepare_zhihu_answer",
      ),
      false,
    );
    await assert.rejects(
      executeParticipationTool(ctx, "discover_zhihu", {
        accountId: b.id,
        query: "生活观察",
        kind: "question",
      }),
      /计划已启用的知乎范围/,
    );
    await assert.rejects(
      executeParticipationTool(ctx, "discover_zhihu", {
        accountId: outside.id,
        query: "生活观察",
        kind: "question",
      }),
      /计划已启用的知乎范围/,
    );
    assert.equal(count(), 0);
    await executeParticipationTool(ctx, "discover_zhihu", {
      accountId: a.id,
      query: "生活观察",
      kind: "question",
    });
    const candidate = f.participation!.snapshot().candidates[0];
    await executeParticipationTool(ctx, "read_zhihu", {
      accountId: a.id,
      candidateId: candidate.id,
    });
    const current = f.participation!.snapshot().candidates[0],
      other = f.plan([a.id]),
      activity = f.participation!.plan({
        accountId: a.id,
        candidateId: current.id,
        version: current.version,
        kind: "answer",
        reason: "这是另一计划准备的回答任务，不得被当前计划认领。",
        planId: other.id,
      }),
      args = {
        activityId: activity.id,
        title: "只准备本计划稿件",
        body: "这份方法围绕问题背景给出建议，必须先核实任务所属计划与账号，并保留完整来源和待审状态。",
        basis: "依据已保存的公开问题背景，不代表外部作品授权。",
      };
    await assert.rejects(
      executeParticipationTool(
        context(f, p, readOnly),
        "prepare_zhihu_answer",
        args,
      ),
      /没有create权限/,
    );
    await assert.rejects(
      executeParticipationTool(ctx, "prepare_zhihu_answer", args),
      /任务不属于此计划/,
    );
    assert.equal(f.service.snapshot().contents.length, 0);
  } finally {
    await f.close();
  }
});

test("真实参与服务通过native发现→阅读→安排→起草；稿件可inspect但不可冒充own自审或未审发布", async () => {
  const { f, plan, account, activity, materialId, calls } =
    await preparedFixture();
  try {
    assert.equal(calls(), 2);
    const content = f.service.store.get("zhihu_contents", activity.contentId!);
    assert.equal(content.accountId, account.id);
    assert.equal(content.reviewed, false);
    assert.equal(content.aiAssisted, true);
    assert.equal(preparedParticipationAnswers(f.dependencies, plan).length, 1);
    const state = f.db.setting<IntelligentOperationsState>(
      intelligentOperationsStateKey,
      {} as IntelligentOperationsState,
    );
    assert.deepEqual(state.brain.provenance, []);
    const cycle = f.ops.brainCycles({ planId: plan.id }).items[0];
    assert.ok(
      cycle.steps.some(
        (step) => step.tool === "inspect_material" && step.success,
      ),
    );
    await assert.rejects(
      executeOperationsBrainTool(context(f, plan), "review_own", {
        materialId,
        fingerprint: "untrusted",
        original: true,
        grounded: true,
        noPromotion: true,
        reason: "企图把参与稿冒充本轮原创稿并自行审核，这是禁止路径。",
      }),
      /只能审核本智能体/,
    );
    let step = 0;
    f.respond(async () =>
      step++ === 0
        ? f.tool("schedule_publication", {
            accountId: account.id,
            materialId,
            earliestAt: new Date(f.time).toISOString(),
            reason: "稿件尚未本人审核，应停在待审阶段。",
          })
        : f.tool("finish", { summary: "准确版本仍待本人审核，没有提交。" }),
    );
    f.ops.brainWake(plan.id);
    await f.ops.tick();
    const task = f.ops
      .tasks({ planId: plan.id, horizon: "all" })
      .items.find((item) => item.materialId === materialId)!;
    assert.equal(task.status, "review");
    assert.equal(f.service.snapshot().tasks.length, 0);
    assert.equal(f.submissions, 0);
  } finally {
    await f.close();
  }
});

test("参与回答经本人精确审核后，native沿原managed发布门禁执行并保存回答回执", async () => {
  const { f, plan, account, activity, materialId } = await preparedFixture();
  try {
    const content = f.service.store.get("zhihu_contents", activity.contentId!);
    f.service.review(content.id, content.version);
    scheduleAndExecute(f, plan.id, account.id, materialId);
    await f.ops.tick();
    const task = f.ops
      .tasks({ planId: plan.id, horizon: "all" })
      .items.find((item) => item.materialId === materialId)!;
    assert.equal(task.status, "completed", task.reason);
    assert.equal(task.url, `${question}/answer/10001`);
    assert.ok(task.linkedTaskId);
    assert.ok(task.submittedAt);
    assert.equal(f.submissions, 1);
    assert.equal(f.service.snapshot().running, false);
    assert.equal(f.service.snapshot().tasks.length, 1);
    assert.equal(
      f.participation!.snapshot().activities[0].resolution,
      null,
      "Publishing does not fabricate a user interaction record",
    );
  } finally {
    await f.close();
  }
});

test("本人skipped撤销未来排期scope；done在填写中撤销scope后，末次原guard仍阻止提交", async () => {
  for (const outcome of ["skipped", "done"] as const) {
    const { f, plan, account, activity, materialId } = await preparedFixture();
    try {
      const content = f.service.store.get(
        "zhihu_contents",
        activity.contentId!,
      );
      f.service.review(content.id, content.version);
      const resolve = () => {
        const current = f
          .participation!.snapshot()
          .activities.find((item) => item.id === activity.id)!;
        f.participation!.resolve({
          id: current.id,
          version: current.version,
          outcome,
          note: "本人记录此参与任务已处理，撤销原任务的隐式库存授权。",
          confirmed: true,
        });
      };
      if (outcome === "done")
        f.before(async () => {
          resolve();
        });
      scheduleAndExecute(
        f,
        plan.id,
        account.id,
        materialId,
        outcome === "skipped",
      );
      await f.ops.tick();
      if (outcome === "skipped") {
        const planned = f.ops
          .tasks({ planId: plan.id, horizon: "all" })
          .items.find((item) => item.materialId === materialId)!;
        assert.equal(planned.status, "planned");
        resolve();
        f.respond(async () =>
          f.tool("finish", {
            summary: "本人已跳过此参与任务，不再使用原稿安排发布。",
          }),
        );
        f.advance(3600001);
        await f.ops.tick();
        assert.equal(
          f.service.snapshot().tasks.length,
          0,
          "Revoked scope must fail before enqueue",
        );
      } else {
        assert.equal(f.service.snapshot().tasks.length, 1);
        assert.equal(
          f.service.snapshot().tasks[0].submittedAt ?? null,
          null,
          "The final managed guard must fail before submit intent",
        );
      }
      assert.equal(
        preparedParticipationAnswers(f.dependencies, plan).length,
        0,
      );
      const task = f.ops
        .tasks({ planId: plan.id, horizon: "all" })
        .items.find((item) => item.materialId === materialId)!;
      assert.ok(["blocked", "attention"].includes(task.status), task.reason);
      assert.match(task.reason, /授权计划范围/);
      assert.equal(f.submissions, 0);
    } finally {
      await f.close();
    }
  }
});

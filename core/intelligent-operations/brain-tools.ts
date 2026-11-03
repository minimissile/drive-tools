import { z } from "zod";
import { id } from "../database";
import { AppError } from "../errors";
import { cleanKnowledge } from "../knowledge-response";
import type { AgentToolDefinition } from "../../shared/ai-agent";
import type {
  OperationsMaterial,
  OperationsTask,
} from "../../shared/intelligent-operations";
import { operationsInventory, operationsFingerprint } from "./inventory";
import type { OperationsBrainToolContext } from "./brain-types";

const fail = (message: string): never => {
  throw new AppError("OPERATIONS_BRAIN_TOOL_BLOCKED", message);
};
const args = {
  observe: z.object({}),
  inspect_material: z.object({ materialId: z.string().max(180) }),
  read_progress: z.object({ accountId: z.string().max(150) }),
  read_feedback: z.object({
    accountId: z.string().max(150),
    url: z.string().max(2000),
  }),
  create_original: z.object({
    accountId: z.string().max(150),
    title: z.string().trim().min(1).max(100),
    body: z.string().trim().min(30).max(12000),
    visibility: z.enum(["public", "self"]),
  }),
  review_own: z.object({
    materialId: z.string().max(180),
    fingerprint: z.string().max(128),
    original: z.literal(true),
    grounded: z.literal(true),
    noPromotion: z.boolean(),
    reason: z.string().trim().min(20).max(2000),
  }),
  schedule_publication: z.object({
    accountId: z.string().max(150),
    materialId: z.string().max(180),
    earliestAt: z.iso.datetime({ offset: true }),
    reason: z.string().trim().min(5).max(1000),
  }),
  execute_task: z.object({ taskId: z.string().max(150) }),
  remember: z.object({ text: z.string().trim().min(5).max(1500) }),
  finish: z.object({ summary: z.string().trim().min(1).max(2000) }),
};
type ToolName = keyof typeof args;
const descriptions: Record<ToolName, string> = {
  observe:
    "读取当前计划范围内账号、渠道规则、选中库存、本人任务、近期结果和有限记忆。不是全库读取。",
  inspect_material: "读取本计划允许使用的指定素材的完整正文、审核状态及版本。",
  read_progress:
    "从本计划知乎账号的官方创作者页面读取当前等级与创作分；不可解除人工暂停。",
  read_feedback:
    "读取本计划已有微博发布回执的真实反馈；URL必须来自observe返回的receipts。",
  create_original:
    "创建你本轮原创的纯文字渠道稿，必须符合计划方向并标注AI辅助，不复制外部文章；不会自动审核或发布。公众号只保存本地稿待交接。",
  review_own:
    "核验并审核本智能体为当前计划创建的准确版本；不能审核既有或外部素材。必须说明原创、依据和推广检查。",
  schedule_publication:
    "为选定账号安排指定素材，系统计算不早于earliestAt的合法时段；未获发布权限时只准备等待授权的任务。不会修改账号规则或解除暂停。",
  execute_task:
    "执行本计划由模型安排且已审核、到期的一个任务；平台规则、身份、提交前权限和间隔会再检查，未知结果不重发。",
  remember:
    "将简短、基于工具反馈的经验写入当前计划长期记忆，不可记录凭据或推测成事实。",
  finish:
    "结束本轮，概述已发生的动作、阻塞与下一步；不要虚构发布、升级、涨粉或效果。",
};
export function operationsBrainTools(
  permissions: OperationsBrainToolContext["permissions"],
): AgentToolDefinition[] {
  const names = (Object.keys(args) as ToolName[]).filter(
    (name) =>
      !(name === "create_original" && !permissions.create) &&
      !(name === "review_own" && !permissions.reviewOwn) &&
      !(name === "execute_task" && !permissions.publish),
  );
  return names.map((name) => ({
    type: "function",
    function: {
      name,
      description: descriptions[name],
      parameters: z.toJSONSchema(args[name], { target: "draft-7" }) as Record<
        string,
        unknown
      >,
    },
  }));
}
const stamp = (ctx: OperationsBrainToolContext) =>
  new Date(ctx.host.now()).toISOString();
function binding(ctx: OperationsBrainToolContext, accountId: string) {
  const a =
    ctx.plan.accounts.find((a) => a.accountId === accountId) ??
    fail("账号不在当前计划范围内");
  if (a.paused) fail("此账号由本人暂停，不得恢复或执行");
  if (!ctx.plan.channels.some((c) => c.channel === a.channel && c.enabled))
    fail("账号对应平台策略未启用");
  return a;
}
function materials(ctx: OperationsBrainToolContext) {
  const owned = new Set(
    ctx.host
      .state()
      .brain.provenance.filter((p) => p.planId === ctx.plan.id)
      .map((p) => p.materialId),
  );
  return operationsInventory(ctx.host.d).materials.filter(
    (m) => ctx.plan.materialIds.includes(m.id) || owned.has(m.id),
  );
}
function material(
  ctx: OperationsBrainToolContext,
  materialId: string,
): OperationsMaterial {
  return (
    materials(ctx).find((m) => m.id === materialId) ??
    fail("素材不在当前计划选择或本智能体创建的范围内")
  );
}
function receipts(ctx: OperationsBrainToolContext) {
  const out = ctx.host
    .state()
    .tasks.filter(
      (t) => t.planId === ctx.plan.id && t.channel === "weibo" && t.url,
    )
    .map((t) => ({ accountId: t.accountId, url: t.url!, title: t.title }));
  for (const m of materials(ctx).filter((m) => m.channel === "weibo")) {
    const p = ctx.host.d.weiboPosts.get(m.id.slice(6));
    if (p.url) out.push({ accountId: p.accountId, url: p.url, title: m.title });
  }
  return out.filter(
    (r, i, a) =>
      a.findIndex((o) => o.accountId === r.accountId && o.url === r.url) === i,
  );
}
export function observeOperationsBrain(ctx: OperationsBrainToolContext) {
  ctx.guard("read");
  const stock = materials(ctx),
    zh = ctx.host.d.zhihu.snapshot();
  return cleanKnowledge({
    plan: {
      name: ctx.plan.name,
      goal: ctx.plan.goal,
      audience: ctx.plan.audience,
      direction: ctx.plan.direction,
      knowledge: ctx.plan.knowledge,
      channels: ctx.plan.channels,
      accounts: ctx.plan.accounts,
    },
    now: stamp(ctx),
    accounts: ctx.plan.accounts.map((a) => ({
      accountId: a.accountId,
      channel: a.channel,
      paused: a.paused,
      positioning: a.positioning,
      progress:
        a.channel === "zhihu"
          ? zh.accounts.find((z) => z.id === a.accountId)?.plan.progress
          : null,
      reason: ctx.host.baseReason(ctx.plan, a.accountId, "publish"),
    })),
    stockCount: stock.length,
    materials: stock.slice(0, 30).map((m) => ({
      ...m,
      preview: m.preview.slice(0, 1000),
      images: undefined,
    })),
    tasks: ctx.host
      .state()
      .tasks.filter((t) => t.planId === ctx.plan.id)
      .slice(-30)
      .map((t) => ({
        id: t.id,
        kind: t.kind,
        status: t.status,
        accountId: t.accountId,
        materialId: t.materialId,
        scheduledAt: t.scheduledAt,
        reason: t.reason,
        url: t.url,
      })),
    receipts: receipts(ctx).slice(-20),
    memory: ctx.host
      .state()
      .brain.memory.filter((m) => m.planId === ctx.plan.id)
      .slice(-50),
    lastCycles: ctx.host
      .state()
      .brain.cycles.filter(
        (c) => c.planId === ctx.plan.id && c.id !== ctx.cycle.id,
      )
      .slice(-5)
      .map((c) => ({
        status: c.status,
        summary: c.summary,
        finishedAt: c.finishedAt,
      })),
    permissions: ctx.permissions,
  });
}
export async function executeOperationsBrainTool(
  ctx: OperationsBrainToolContext,
  name: string,
  raw: unknown,
): Promise<{ result: unknown; finish?: string }> {
  ctx.guard("read");
  if (!Object.hasOwn(args, name))
    fail("不支持的业务工具，不提供任意网页、shell或IPC操作");
  if (name === "observe") {
    args.observe.parse(raw);
    return { result: observeOperationsBrain(ctx) };
  }
  if (name === "inspect_material") {
    const v = args.inspect_material.parse(raw);
    return { result: material(ctx, v.materialId) };
  }
  if (name === "read_progress") {
    const v = args.read_progress.parse(raw),
      a = binding(ctx, v.accountId);
    if (a.channel !== "zhihu") fail("此工具仅适用于知乎账号");
    const progress = await ctx.host.d.zhihu.checkProgress(a.accountId, () =>
      ctx.guard("read"),
    );
    ctx.guard("read");
    return { result: progress };
  }
  if (name === "read_feedback") {
    const v = args.read_feedback.parse(raw),
      a = binding(ctx, v.accountId);
    if (
      a.channel !== "weibo" ||
      !receipts(ctx).some((r) => r.accountId === a.accountId && r.url === v.url)
    )
      fail("仅可读取本计划本人微博的已有回执");
    const feedback = await ctx.host.d.weiboStatistics.refresh(
      a.accountId,
      v.url,
      () => ctx.guard("read"),
    );
    ctx.guard("read");
    return { result: feedback.slice(0, 1) };
  }
  if (name === "create_original") {
    ctx.guard("create");
    const v = args.create_original.parse(raw),
      a = binding(ctx, v.accountId),
      state = ctx.host.state(),
      policy = ctx.host.accountPolicy(ctx.plan, a.accountId);
    if (
      state.brain.provenance.filter((p) => p.cycleId === ctx.cycle.id).length >=
      3
    )
      fail("每轮最多创建3份原创稿，请先核验已有稿件");
    if (
      state.brain.provenance.filter((p) => p.planId === ctx.plan.id).length >=
      500
    )
      fail("此计划原创稿库存达到500份，请整理现有内容后继续");
    const normal = (body: string) => body.replace(/\s/g, "");
    if (
      materials(ctx).some(
        (m) =>
          normal(m.preview) === normal(v.body) ||
          normal(m.preview).replace(/（[^）]*AI[^）]*）$/i, "") ===
            normal(v.body),
      )
    )
      fail("当前计划已有相同正文，不能重复创建供稿");
    if (
      policy.purpose === "warming" &&
      /https?:\/\/|www\.|私信|加群|扫码|提取码|领取|购买|下单|推广|优惠/.test(
        `${v.title}\n${v.body}`,
      )
    )
      fail("养号原创稿含推广或引流内容，不能创建为养号素材");
    const body = /AI辅助/.test(v.body)
      ? v.body
      : `${v.body}\n\n（本文由AI辅助创作）`;
    let materialId: string;
    if (a.channel === "zhihu") {
      if (body.length < 80 || body.length > 8000)
        fail("知乎原创文章需80至8000字符");
      const c = ctx.host.d.zhihu.saveContent({
        kind: "article",
        purpose: policy.purpose,
        category: ctx.plan.direction.slice(0, 40) || "原创文字",
        title: v.title,
        body,
        questionUrl: "",
        aiAssisted: true,
      });
      materialId = `zhihu:${c.id}`;
    } else if (a.channel === "weibo") {
      if (body.length > 2000) fail("微博文案含AI说明须不超过2000字符");
      const p = ctx.host.d.weiboPosts.save({
        accountId: a.accountId,
        text: body,
        visibility: v.visibility,
        aiAssisted: true,
      });
      materialId = `weibo:${p.id}`;
    } else {
      const draft = {
        id: id("iobdraft"),
        planId: ctx.plan.id,
        accountId: a.accountId,
        title: v.title,
        body,
        createdAt: stamp(ctx),
        reviewed: false,
        aiAssisted: true as const,
      };
      state.brain.drafts.push(draft);
      materialId = `wechat:${draft.id}`;
      ctx.host.persist();
    }
    ctx.guard("create");
    const created =
      operationsInventory(ctx.host.d).materials.find(
        (m) => m.id === materialId,
      ) ?? fail("新稿未能从库存读取，停止核对");
    state.brain.provenance.push({
      id: id("ioprov"),
      planId: ctx.plan.id,
      cycleId: ctx.cycle.id,
      toolCallId: ctx.toolCallId,
      materialId,
      accountId: a.accountId,
      fingerprint: created.fingerprint!,
      createdAt: stamp(ctx),
      reviewedFingerprint: null,
      reviewReason: null,
      reviewedAt: null,
    });
    ctx.host.persist();
    return {
      result: {
        materialId,
        title: created.title,
        fingerprint: created.fingerprint,
        reviewed: false,
        aiAssisted: true,
        message: "原创稿已保存，未审核、未发布",
      },
    };
  }
  if (name === "review_own") {
    ctx.guard("reviewOwn");
    const v = args.review_own.parse(raw),
      state = ctx.host.state(),
      owned =
        state.brain.provenance.find(
          (p) => p.planId === ctx.plan.id && p.materialId === v.materialId,
        ) ?? fail("只能审核本智能体为此计划创建的稿件");
    binding(ctx, owned.accountId);
    const m = material(ctx, v.materialId);
    if (m.fingerprint !== v.fingerprint || owned.fingerprint !== v.fingerprint)
      fail("原创稿准确版本已变化，不能自动审核被修改的版本");
    const policy = ctx.host.accountPolicy(ctx.plan, owned.accountId);
    if (
      policy.purpose === "warming" &&
      (!v.noPromotion ||
        /https?:\/\/|www\.|私信|加群|扫码|提取码|领取|购买|下单|推广|优惠/.test(
          `${m.title}\n${m.preview}`,
        ))
    )
      fail("无推广核验未通过，养号稿不得自动审核");
    if (!/AI辅助/.test(m.preview)) fail("原创稿未保留AI辅助说明");
    if (m.channel === "zhihu") {
      const c = ctx.host.d.zhihu.store.get("zhihu_contents", m.id.slice(6));
      ctx.host.d.zhihu.review(c.id, c.version);
    } else if (m.channel === "wechat") {
      const draft =
        state.brain.drafts.find((d) => `wechat:${d.id}` === m.id) ??
        fail("公众号自制稿不存在");
      draft.reviewed = true;
    }
    owned.reviewedFingerprint = v.fingerprint;
    owned.reviewReason = v.reason;
    owned.reviewedAt = stamp(ctx);
    ctx.host.persist();
    return {
      result: {
        materialId: m.id,
        fingerprint: v.fingerprint,
        reviewed: true,
        reviewReason: v.reason,
        message: "仅此自制准确版本通过机器核验；未发布",
      },
    };
  }
  if (name === "schedule_publication") {
    const v = args.schedule_publication.parse(raw),
      a = binding(ctx, v.accountId),
      m = material(ctx, v.materialId),
      state = ctx.host.state();
    if (m.channel !== a.channel || (m.accountId && m.accountId !== a.accountId))
      fail("素材与目标渠道/账号不匹配");
    if (
      a.channel === "zhihu" &&
      m.purpose !== ctx.host.accountPolicy(ctx.plan, a.accountId).purpose
    )
      fail("素材用途与当前平台策略不匹配");
    const history = state.tasks.filter(
      (t) =>
        t.planId === ctx.plan.id &&
        t.materialId === m.id &&
        ["publish", "handoff"].includes(t.kind),
    );
    if (
      history.some(
        (t) =>
          t.status === "cancelled" &&
          (t.cancelOrigin === "user" ||
            (!t.cancelOrigin && /^本人取消/.test(t.reason))),
      )
    )
      fail("本人已单独取消这份素材，不能重新建立或复活");
    let existing = history.at(-1);
    if (existing?.status === "cancelled") {
      const policyChange =
        existing.cancelOrigin === "policy" ||
        (!existing.cancelOrigin && /^计划规则已修改/.test(existing.reason));
      if (
        !policyChange ||
        existing.planRevision === ctx.plan.revision ||
        existing.attemptedAt ||
        existing.submittedAt ||
        existing.linkedTaskId
      )
        fail("原任务已取消或已有执行历史，不能重建");
      existing = undefined;
    }
    if (existing) {
      if (
        existing.accountId !== a.accountId ||
        existing.fingerprint !== m.fingerprint ||
        existing.planRevision !== ctx.plan.revision ||
        !existing.brainCycleId
      )
        fail("原任务的账号、版本或来源不同，不能自动接管");
      if (
        existing.attemptedAt ||
        existing.submittedAt ||
        existing.linkedTaskId ||
        ["completed", "attention", "running"].includes(existing.status)
      )
        return {
          result: {
            taskId: existing.id,
            status: existing.status,
            reason: existing.reason,
            message: "仅保留原任务记录，不重放提交或重建任务",
          },
        };
    }
    if (
      !existing &&
      a.channel === "zhihu" &&
      ctx.host.d.zhihu
        .snapshot()
        .tasks.some(
          (t) => `zhihu:${t.contentId}` === m.id && t.status !== "cancelled",
        )
    )
      fail("这份内容已有原知乎发布历史，请核对原任务，不能重复安排");
    if (a.channel === "weibo") {
      const post = ctx.host.d.weiboPosts.get(m.id.slice(6));
      if (post.stage !== "editing" || post.submittedAt)
        fail("原微博稿已有填写或提交记录，不能再次安排；请核对原任务");
    }
    if (
      state.tasks.some(
        (t) =>
          t.materialId === m.id &&
          t.id !== existing?.id &&
          (t.attemptedAt ||
            t.linkedTaskId ||
            t.submittedAt ||
            ["completed", "attention"].includes(t.status)),
      )
    )
      fail("该内容已有执行或待核对历史，不能重发");
    if (
      state.tasks.some(
        (t) =>
          t.materialId === m.id &&
          t.planId !== ctx.plan.id &&
          t.status !== "cancelled",
      )
    )
      fail("该内容已被其他计划安排，不能争抢或重复分发");
    const at = Date.parse(v.earliestAt);
    if (at < ctx.host.now() - 60000 || at > ctx.host.now() + 7 * 86400000)
      fail("模型排期必须在当前至未来7天内");
    const owned = state.brain.provenance.find(
        (p) => p.planId === ctx.plan.id && p.materialId === m.id,
      ),
      reviewed = owned
        ? owned.reviewedFingerprint === m.fingerprint ||
          (m.channel === "zhihu" && m.reviewed) ||
          existing?.approvedFingerprint === m.fingerprint
        : m.reviewed || existing?.approvedFingerprint === m.fingerprint;
    if (owned && owned.accountId !== a.accountId)
      fail("智能体自制稿只允许用于其创建时绑定的账号，不能跨号自动审核发布");
    const reason = ctx.host.baseReason(
      ctx.plan,
      a.accountId,
      a.channel === "wechat" ? "handoff" : "publish",
    );
    const t: OperationsTask = {
      id:
        existing?.id ??
        `iotask_${operationsFingerprint(`${ctx.plan.id}:${m.id}:${m.fingerprint}:${ctx.cycle.id}`).slice(0, 32)}`,
      key: `brain:${ctx.plan.id}:${m.id}:${m.fingerprint}`,
      planId: ctx.plan.id,
      planRevision: ctx.plan.revision,
      channel: a.channel,
      accountId: a.accountId,
      accountLabel:
        operationsInventory(ctx.host.d).accounts.find(
          (x) => x.id === a.accountId,
        )?.label ?? a.accountId,
      kind: a.channel === "wechat" ? "handoff" : "publish",
      title: m.title,
      reason: reason ?? `模型安排：${v.reason}`,
      status:
        a.channel === "wechat"
          ? "handoff"
          : !ctx.permissions.publish || reason
            ? "blocked"
            : reviewed
              ? "planned"
              : "review",
      scheduledAt: new Date(
        Math.max(
          at,
          ctx.host.now(),
          existing?.manualScheduledAt
            ? Date.parse(existing.manualScheduledAt)
            : 0,
        ),
      ).toISOString(),
      brainCycleId: existing?.brainCycleId ?? ctx.cycle.id,
      manualScheduledAt: existing?.manualScheduledAt ?? v.earliestAt,
      createdAt: existing?.createdAt ?? stamp(ctx),
      updatedAt: stamp(ctx),
      materialId: m.id,
      fingerprint: m.fingerprint!,
      approvedFingerprint: reviewed ? m.fingerprint! : null,
      linkedTaskId: null,
      attemptedAt: null,
      submittedAt: null,
      url: null,
    };
    if (t.kind === "publish") {
      const slot = ctx.host.publicationSlot(
        t,
        ctx.plan,
        Date.parse(t.scheduledAt!),
        true,
      );
      t.scheduledAt = slot;
      if (!slot) {
        t.status = "blocked";
        t.reason = "未来7天暂无额度、间隔和时段均允许的执行时间";
      } else
        t.reason = !ctx.permissions.publish
          ? "未授权自主发布，模型已准备任务等待本人授权"
          : (reason ??
            (!reviewed
              ? "当前版本尚未审核，等待本人或自制稿核验"
              : `模型安排：${v.reason}`));
    } else
      t.reason =
        "公众号原生原创稿/选中素材已准备，仅等待本人交接，不会自动群发";
    ctx.host.saveTask(t);
    return {
      result: {
        taskId: t.id,
        status: t.status,
        scheduledAt: t.scheduledAt,
        reason: t.reason,
      },
    };
  }
  if (name === "execute_task") {
    ctx.guard("publish");
    const v = args.execute_task.parse(raw),
      t =
        ctx.host
          .state()
          .tasks.find((t) => t.id === v.taskId && t.planId === ctx.plan.id) ??
        fail("任务不在当前计划内");
    if (
      !t.brainCycleId ||
      t.kind !== "publish" ||
      !["planned", "delegated"].includes(t.status)
    )
      fail("仅执行模型安排且已审核的发文任务，不重放其他任务");
    if (!t.scheduledAt || Date.parse(t.scheduledAt) > ctx.host.now())
      return {
        result: {
          status: t.status,
          scheduledAt: t.scheduledAt,
          message: "尚未到时，保留原排期",
        },
      };
    await ctx.host.execute(t);
    ctx.guard("publish");
    const result = ctx.host.state().tasks.find((s) => s.id === t.id)!;
    if (result.status === "attention")
      fail(`发布任务待核对，停止自主授权：${result.reason}`);
    return {
      result: {
        taskId: result.id,
        status: result.status,
        reason: result.reason,
        url: result.url,
      },
    };
  }
  if (name === "remember") {
    const v = args.remember.parse(raw),
      state = ctx.host.state(),
      text = String(cleanKnowledge(v.text));
    state.brain.memory.push({
      id: id("iomemory"),
      planId: ctx.plan.id,
      cycleId: ctx.cycle.id,
      createdAt: stamp(ctx),
      text,
    });
    const own = state.brain.memory.filter((m) => m.planId === ctx.plan.id);
    if (own.length > 50) {
      const remove = new Set(own.slice(0, -50).map((m) => m.id));
      state.brain.memory = state.brain.memory.filter((m) => !remove.has(m.id));
    }
    ctx.host.persist();
    return { result: { saved: true, text } };
  }
  const v = args.finish.parse(raw);
  return { result: { finished: true, summary: v.summary }, finish: v.summary };
}

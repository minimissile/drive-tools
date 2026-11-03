import type {
  OperationsPlan,
  OperationsTask,
} from "../../shared/intelligent-operations";
import type {
  IntelligentOperationsDependencies,
  OperationsChannelPolicy,
} from "./types";
import type { IntelligentOperationsState } from "./state";
import {
  operationsFingerprint,
  existingOperationsState,
  type operationsInventory,
} from "./inventory";
import {
  findOperationsSlot,
  terminalOperationsTask,
  awaitingOperationsTask as awaiting,
} from "./policy";

/** Typed local planning boundary; all platform submission remains outside this module. */
export interface OperationsPlanningContext {
  state: IntelligentOperationsState;
  inventory: ReturnType<typeof operationsInventory>;
  now: number;
  d: Pick<
    IntelligentOperationsDependencies,
    "zhihu" | "weiboPosts" | "weiboStatistics"
  >;
  plan(id: string): OperationsPlan;
  baseReason(
    plan: OperationsPlan,
    accountId: string,
    kind: OperationsTask["kind"],
  ): string | null;
  accountPolicy(
    plan: OperationsPlan,
    accountId: string,
  ): OperationsChannelPolicy;
  network(accountId: string): string;
  stamp(): string;
  saveTask(task: OperationsTask): OperationsTask;
}

export function planOperations(
  context: OperationsPlanningContext,
  planId?: string,
) {
  const { inventory, now } = context,
    horizon = now + 7 * 86400000;
  for (const t of [...context.state.tasks]) {
    const current = existingOperationsState(context.d, t);
    if (
      current &&
      Object.entries(current).some(
        ([k, v]) => t[k as keyof OperationsTask] !== v,
      )
    )
      context.saveTask({ ...t, ...current });
  }
  const reservations: { at: string; accountId: string; network: string }[] =
    inventory.zhihu.tasks
      .filter((t) => !!t.attemptedAt)
      .map((t) => ({
        at: t.attemptedAt!,
        accountId: t.accountId,
        network: t.networkKey ?? "",
      }));
  for (const t of context.state.tasks.filter(
    (t) => t.channel !== "zhihu" && t.kind === "publish" && !!t.attemptedAt,
  ))
    reservations.push({
      at: t.attemptedAt!,
      accountId: t.accountId,
      network: context.network(t.accountId),
    });
  for (const t of context.state.tasks.filter(
    (t) =>
      t.kind === "publish" &&
      (terminalOperationsTask(t) ||
        (context.plan(t.planId).active &&
          context.plan(t.planId).mode === "autonomous" &&
          ["planned", "review", "delegated"].includes(t.status))) &&
      t.status !== "cancelled" &&
      !!t.scheduledAt &&
      !t.attemptedAt,
  ))
    reservations.push({
      at: t.scheduledAt!,
      accountId: t.accountId,
      network: context.network(t.accountId),
    });
  const seen = new Set<string>();
  const assignment = new Map<string, string>();
  for (const p of context.state.plans.filter(
    (p) => p.mode !== "autonomous" && (!planId || p.id === planId),
  )) {
    const counts = new Map<string, number>();
    for (const m of inventory.materials.filter((m) =>
      p.materialIds.includes(m.id),
    )) {
      const candidates = p.accounts.filter(
        (a) =>
          !a.paused &&
          a.channel === m.channel &&
          (!m.accountId || m.accountId === a.accountId) &&
          p.channels.some(
            (c) =>
              c.channel === a.channel &&
              c.enabled &&
              (a.channel !== "zhihu" || c.purpose === m.purpose),
          ),
      );
      const ready = candidates.filter(
        (a) =>
          !context.baseReason(
            p,
            a.accountId,
            a.channel === "wechat" ? "handoff" : "publish",
          ),
      );
      const chosen = (ready.length ? ready : candidates).sort(
        (a, b) =>
          (counts.get(a.accountId) ?? 0) - (counts.get(b.accountId) ?? 0),
      )[0];
      if (chosen) {
        assignment.set(`${p.id}:${m.id}`, chosen.accountId);
        counts.set(chosen.accountId, (counts.get(chosen.accountId) ?? 0) + 1);
      }
    }
  }
  const allocated = new Set(
    context.state.tasks
      .filter(
        (t) =>
          !!t.materialId &&
          t.status !== "cancelled" &&
          (terminalOperationsTask(t) ||
            (context.plan(t.planId).active &&
              context.plan(t.planId).mode === "autonomous") ||
            (!!planId && t.planId !== planId && context.plan(t.planId).active)),
      )
      .map((t) => t.materialId),
  );
  const add = (
    p: OperationsPlan,
    a: OperationsPlan["accounts"][number],
    kind: OperationsTask["kind"],
    suffix: string,
    title: string,
    at: string | null,
    reason: string,
    status: OperationsTask["status"],
    materialId: string | null = null,
    fingerprint: string | null = null,
    url: string | null = null,
  ) => {
    const key = `${p.id}:${p.revision}:${a.accountId}:${kind}:${suffix}`,
      previous = context.state.tasks.find((t) => t.key === key);
    if (previous) seen.add(previous.id);
    if (previous && terminalOperationsTask(previous)) return previous;
    const manualAt =
      previous?.manualScheduledAt &&
      Date.parse(previous.manualScheduledAt) >= now
        ? previous.manualScheduledAt
        : null;
    const value: OperationsTask = {
      id: previous?.id ?? `iotask_${operationsFingerprint(key).slice(0, 32)}`,
      key,
      planId: p.id,
      planRevision: p.revision,
      channel: a.channel,
      accountId: a.accountId,
      accountLabel:
        inventory.accounts.find((i) => i.id === a.accountId)?.label ??
        a.accountId,
      kind,
      title,
      scheduledAt: manualAt ?? at,
      manualScheduledAt: manualAt,
      reason,
      status,
      materialId,
      fingerprint,
      approvedFingerprint:
        previous?.approvedFingerprint === fingerprint ? fingerprint : null,
      linkedTaskId: null,
      attemptedAt: null,
      submittedAt: null,
      url,
      createdAt: previous?.createdAt ?? context.stamp(),
      updatedAt: context.stamp(),
    };
    seen.add(value.id);
    if (
      value.channel === "weibo" &&
      kind === "publish" &&
      status === "planned" &&
      value.approvedFingerprint !== fingerprint
    ) {
      value.status = "review";
      value.reason = "待审核准确微博正文、图片与可见范围；审核后才可执行";
    }
    return context.saveTask(value);
  };
  for (const p of context.state.plans
    .filter((p) => p.mode !== "autonomous" && (!planId || p.id === planId))
    .sort((a, b) => Number(b.active) - Number(a.active)))
    for (const a of p.accounts) {
      const policy = context.accountPolicy(p, a.accountId);
      if (!policy.enabled) continue;
      if (
        !inventory.accounts.some(
          (v) => v.id === a.accountId && v.channel === a.channel,
        )
      ) {
        add(
          p,
          a,
          "supply",
          "missing-account",
          "账号需要重新关联",
          null,
          "账号已移除，请编辑计划重新选择；其他账号继续独立规划",
          "blocked",
        );
        continue;
      }
      const base = context.baseReason(p, a.accountId, "progress"),
        limits = {
          daily: Math.min(policy.dailyLimit, a.dailyLimit ?? 10),
          gap: Math.max(policy.gapMinutes, a.gapMinutes ?? 60),
        };
      if (a.channel === "zhihu") {
        const checked = inventory.zhihu.accounts.find(
            (v) => v.id === a.accountId,
          )?.plan.progress?.checkedAt,
          due = Math.max(
            now,
            checked ? Date.parse(checked) + policy.checkHours * 3600000 : now,
          ),
          slot = Math.floor(due / (policy.checkHours * 3600000));
        const at = findOperationsSlot(
          due,
          policy,
          100,
          1,
          [],
          a.accountId,
          "",
          horizon,
        );
        add(
          p,
          a,
          "progress",
          String(slot),
          "检查官方等级与创作分",
          at,
          base ?? "按检查频率读取官方创作进度，不推算等级",
          base ? "blocked" : "planned",
        );
        for (const source of inventory.zhihu.tasks.filter(
          (t) => t.accountId === a.accountId && t.status === "attention",
        ))
          add(
            p,
            a,
            "reconcile",
            source.id,
            `核对发布结果：${source.title}`,
            null,
            "请在原知乎任务核实官方结果；未知提交不会自动重发",
            "attention",
            null,
            null,
            source.url ?? null,
          );
      } else if (a.channel === "weibo") {
        for (const target of context.d.weiboStatistics
          .list(a.accountId)
          .slice(0, 3)) {
          const last = context.d.weiboStatistics.get(a.accountId, target.url)[0]
              ?.observedAt,
            due = Math.max(
              now,
              last ? Date.parse(last) + policy.checkHours * 3600000 : now,
            ),
            slot = Math.floor(due / (policy.checkHours * 3600000));
          add(
            p,
            a,
            "statistics",
            `${operationsFingerprint(target.url).slice(0, 16)}:${slot}`,
            `读取微博反馈：${target.text}`,
            findOperationsSlot(
              due,
              policy,
              100,
              1,
              [],
              a.accountId,
              "",
              horizon,
            ),
            base ?? "按检查频率读取本账号已发布微博的官方反馈",
            base ? "blocked" : "planned",
            null,
            null,
            target.url,
          );
        }
        for (const source of context.d.weiboPosts
          .list(a.accountId)
          .filter((p) =>
            ["uncertain", "submitting", "filled", "attention"].includes(
              p.stage,
            ),
          ))
          add(
            p,
            a,
            "reconcile",
            source.id,
            `核对原微博任务：${source.text.slice(0, 50)}`,
            null,
            "请回原微博任务核对编辑器或回执；中心不接管旧网页草稿",
            "attention",
            null,
            null,
            source.url,
          );
      }
      const selected = inventory.materials.filter(
        (m) =>
          p.materialIds.includes(m.id) &&
          assignment.get(`${p.id}:${m.id}`) === a.accountId &&
          m.channel === a.channel &&
          (!m.accountId || m.accountId === a.accountId) &&
          (a.channel !== "zhihu" || m.purpose === policy.purpose),
      );
      let eligible = 0;
      for (const material of selected) {
        if (allocated.has(material.id)) {
          if (!p.active)
            add(
              p,
              a,
              a.channel === "wechat" ? "handoff" : "publish",
              `${material.id}:${material.fingerprint}`,
              material.title,
              null,
              "素材已被启用计划预订或已执行；此暂停预览不占用库存",
              "blocked",
              material.id,
              material.fingerprint ?? null,
            );
          continue;
        }
        if (
          a.channel === "zhihu" &&
          inventory.zhihu.tasks.some(
            (t) =>
              `zhihu:${t.contentId}` === material.id &&
              t.status !== "cancelled",
          )
        )
          continue;
        const original =
          a.channel === "weibo"
            ? context.d.weiboPosts.get(material.id.slice(6))
            : null;
        if (original && (original.stage !== "editing" || original.submittedAt))
          continue;
        eligible++;
        const block =
          context.baseReason(
            p,
            a.accountId,
            a.channel === "wechat" ? "handoff" : "publish",
          ) ??
          (a.channel === "zhihu" && !material.reviewed
            ? "知乎素材当前版本尚未审核"
            : null) ??
          (a.channel === "weibo" &&
          policy.purpose === "warming" &&
          /https?:\/\/|私信|加群|扫码|领取|推广|优惠|下单/.test(
            material.preview,
          )
            ? "养号素材含推广或引流内容，请修改并重新审核"
            : null);
        let daily = limits.daily,
          gap = limits.gap;
        if (a.channel === "zhihu") {
          const source = inventory.zhihu.accounts.find(
            (v) => v.id === a.accountId,
          )!;
          daily = Math.min(daily, source.plan.dailyLimit);
          gap = Math.max(gap, source.plan.gapMinutes);
        }
        const at = findOperationsSlot(
          now,
          policy,
          daily,
          gap,
          reservations,
          a.accountId,
          context.network(a.accountId),
          horizon,
        );
        const item = add(
          p,
          a,
          a.channel === "wechat" ? "handoff" : "publish",
          `${material.id}:${material.fingerprint}`,
          material.title,
          at,
          block ??
            (at
              ? a.channel === "wechat"
                ? "公众号内容计划已准备，等待本人交接"
                : "按时段、额度及账号/同出口间隔安排；执行前再次核对"
              : "未来7天暂无符合额度和间隔的时段"),
          block || !at
            ? "blocked"
            : a.channel === "wechat"
              ? "handoff"
              : "planned",
          material.id,
          material.fingerprint ?? null,
        );
        if (p.active && item.status !== "cancelled") {
          allocated.add(material.id);
          if (at)
            reservations.push({
              at: item.scheduledAt ?? at,
              accountId: a.accountId,
              network: context.network(a.accountId),
            });
        }
      }
      if (!eligible)
        add(
          p,
          a,
          "supply",
          "inventory",
          "等待可用内容",
          null,
          base ??
            "所选内容为空、已分配或已使用；请选择该账号的本地内容，不自动生成新素材",
          "blocked",
        );
    }
  for (const t of context.state.tasks.filter(
    (t) =>
      context.plan(t.planId).mode !== "autonomous" &&
      (!planId || t.planId === planId) &&
      awaiting(t) &&
      !seen.has(t.id),
  ))
    context.saveTask({
      ...t,
      status: "cancelled",
      cancelOrigin: "system",
      approvedFingerprint: null,
      reason: "内容、身份或计划条件已变化，旧排期停止；历史保留",
    });
}

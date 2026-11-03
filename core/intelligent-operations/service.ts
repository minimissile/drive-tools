import { z } from "zod";
import { id } from "../database";
import { AppError, safeMessage } from "../errors";
import { RuntimeLog } from "../runtime-log";
import {
  intelligentOperationsStateKey,
  operationsPlanInput,
  type OperationsPlan,
  type OperationsTask,
  type OperationsTaskPage,
  type OperationsSnapshot,
  type OperationsAdvice,
} from "../../shared/intelligent-operations";
import {
  restoreIntelligentOperationsState,
  type IntelligentOperationsState,
} from "./state";
import { operationsInventory, existingOperationsState } from "./inventory";
import { planOperations } from "./planner";
import { queryOperationsTasks, queryOperationsLogs } from "./queries";
import { requestOperationsAdvice } from "./advice";
import { OperationsBrainRuntime } from "./brain-runtime";
import type { OperationsBrainPermissions } from "../../shared/operations-brain";
import {
  operationalDay,
  findOperationsSlot,
  awaitingOperationsTask as awaiting,
} from "./policy";
import type {
  IntelligentOperationsDependencies,
  OperationsChannelPolicy,
} from "./types";

const fail = (message: string): never => {
  throw new AppError("INTELLIGENT_OPERATIONS_BLOCKED", message);
};
/** Cross-channel orchestration. Platform services remain the submission authority. */
export class IntelligentOperations {
  readonly logs: RuntimeLog;
  private state: IntelligentOperationsState;
  private running = false;
  private executing = false;
  private advising = new Set<string>();
  private closed = false;
  private generation = 0;
  private lastHeartbeatAt: string | null = null;
  private lastPlanning = 0;
  private timer: ReturnType<typeof setInterval>;
  private time: () => number;
  private brainRuntime: OperationsBrainRuntime;
  constructor(private d: IntelligentOperationsDependencies) {
    this.time = d.clock ?? Date.now;
    this.logs = new RuntimeLog(d.db, d.dataPath, "intelligent-operations");
    const raw = d.db.setting<unknown>(intelligentOperationsStateKey, {
      version: 1,
      plans: [],
      tasks: [],
    });
    this.state = restoreIntelligentOperationsState(raw);
    for (const t of this.state.tasks) {
      if (t.channel === "zhihu" && t.linkedTaskId) {
        const original = d.zhihu
          .snapshot()
          .tasks.find((v) => v.id === t.linkedTaskId);
        if (
          original?.status === "queued" &&
          !original.attemptedAt &&
          !original.submittedAt
        ) {
          d.zhihu.cancel(original.id);
          t.status = "cancelled";
          t.cancelOrigin = "restart";
          t.reason = "应用重启，已取消本中心尚未执行的原知乎任务；未重发";
        }
      }
    }
    this.persist(false);
    this.brainRuntime = new OperationsBrainRuntime({
      d: this.d,
      state: () => this.state,
      plan: (id) => this.plan(id),
      running: () => this.running,
      closed: () => this.closed,
      now: () => this.time(),
      persist: () => this.persist(),
      saveTask: (task) => this.saveTask(task),
      accountPolicy: (plan, id) => this.accountPolicy(plan, id),
      baseReason: (plan, id, kind) => this.baseReason(plan, id, kind),
      publicationSlot: (task, plan, startAt, reservations) =>
        this.publicationSlot(task, plan, startAt, reservations),
      execute: (task) => this.execute(task, this.generation),
      stopOwned: (planId) => this.stopOwnedTasks(planId),
      log: (event, message, planId, details, level = "info") => {
        if (!this.closed)
          this.logs.record({
            level,
            event,
            message,
            details: { ...details, planId },
          });
      },
    });
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        this.running = false;
      });
    }, 5000);
    this.timer.unref();
  }
  get isBusy() {
    return (
      this.executing || this.advising.size > 0 || !!this.brainRuntime?.isBusy
    );
  }
  brainSnapshot() {
    return this.brainRuntime.snapshot();
  }
  brainCycles(raw: unknown = {}) {
    return this.brainRuntime.cycles(raw);
  }
  brainActivate(
    planId: string,
    active: boolean,
    permissions: OperationsBrainPermissions,
    planRevision?: number,
  ) {
    return this.brainRuntime.activate(
      planId,
      active,
      permissions,
      planRevision,
    );
  }
  brainWake(planId: string) {
    return this.brainRuntime.wake(planId);
  }
  private stamp() {
    return new Date(this.time()).toISOString();
  }
  private persist(changed = true) {
    if (this.closed) return;
    this.d.db.setSetting(intelligentOperationsStateKey, this.state);
    if (changed) this.d.changed();
  }
  private plan(id: string) {
    return (
      this.state.plans.find((p) => p.id === id) ??
      fail("运营计划不存在，请刷新后重试")
    );
  }
  private task(id: string) {
    return (
      this.state.tasks.find((t) => t.id === id) ??
      fail("任务不存在，请刷新后重试")
    );
  }
  private event(
    event: string,
    message: string,
    planId?: string,
    task?: OperationsTask,
    level: "info" | "warning" | "error" = "info",
  ) {
    if (this.closed) return;
    this.logs.record({
      event,
      message,
      level,
      accountId: task?.accountId || undefined,
      taskId: task?.id,
      details: {
        planId: planId ?? task?.planId ?? null,
        channel: task?.channel ?? null,
        scheduledAt: task?.scheduledAt ?? null,
        linkedTaskId: task?.linkedTaskId ?? null,
      },
    });
  }
  private saveTask(task: OperationsTask) {
    if (this.closed) return task;
    const previous = this.state.tasks.find((t) => t.id === task.id);
    const value = { ...task, updatedAt: this.stamp() };
    if (previous) this.state.tasks[this.state.tasks.indexOf(previous)] = value;
    else this.state.tasks.push(value);
    if (
      !previous ||
      previous.status !== value.status ||
      previous.reason !== value.reason ||
      previous.scheduledAt !== value.scheduledAt
    )
      this.event(
        `task.${value.status}`,
        value.reason,
        value.planId,
        value,
        value.status === "attention"
          ? "error"
          : value.status === "blocked"
            ? "warning"
            : "info",
      );
    this.persist();
    if (
      value.status === "attention" &&
      value.brainCycleId &&
      this.plan(value.planId).mode === "autonomous"
    )
      this.brainRuntime.stop(
        value.planId,
        `原自主任务待核对，已停止相应自主权限：${value.reason}`,
      );
    return value;
  }
  snapshot(): OperationsSnapshot {
    const inventory = operationsInventory(this.d);
    let configured = false;
    try {
      this.d.ai.assertTextConfigured("analysis");
      configured = true;
    } catch {
      /* Readiness only; no remote calls. */
    }
    return {
      plans: this.state.plans,
      accounts: inventory.accounts,
      materials: inventory.materials,
      runtime: {
        running: this.running,
        busy: this.isBusy,
        lastHeartbeatAt: this.lastHeartbeatAt,
        message: this.running
          ? "按已启用计划和已审核内容运行"
          : "本地调度已停止；计划预览不会发布",
      },
      capabilities: [
        {
          channel: "zhihu",
          automatic: true,
          description:
            "复用已审核素材和原发布任务；原账号计划须启用，原自动调度须停止",
        },
        {
          channel: "weibo",
          automatic: true,
          description: "准确正文、可见范围及附件审核后，填写并提交原微博草稿",
        },
        {
          channel: "wechat",
          automatic: false,
          description: "内容计划与人工交接，尚未接入公众号自动发布",
        },
      ],
      aiDefaults: {
        model: this.d.ai.modelFor("analysis"),
        configured,
        dailyBudgetMicros: this.d.db.setting<number | null>(
          "dailyAiBudgetMicros",
          null,
        ),
      },
      logFolder: this.logs.folder,
    };
  }
  save(raw: unknown) {
    const input = operationsPlanInput.parse(raw),
      inventory = operationsInventory(this.d);
    for (const a of input.accounts) {
      const source = inventory.accounts.find(
        (s) => s.id === a.accountId && s.channel === a.channel,
      );
      if (!source)
        fail("所选账号不存在或渠道不匹配，请先连接账号/公众号内容绑定");
      const policy =
        input.channels.find((c) => c.channel === a.channel) ??
        fail("所选账号缺少对应平台策略");
      if (a.dailyLimit !== null && a.dailyLimit > policy.dailyLimit)
        fail("账号额度覆盖只能收紧，不能超过平台策略");
      if (a.gapMinutes !== null && a.gapMinutes < policy.gapMinutes)
        fail("账号间隔覆盖只能加长，不能短于平台策略");
      const start = a.windowStart ?? policy.windowStart,
        end = a.windowEnd ?? policy.windowEnd;
      if (start < policy.windowStart || end > policy.windowEnd || start >= end)
        fail("账号执行时段只能在平台时段内缩窄，结束须晚于开始");
    }
    for (const material of input.materialIds)
      if (!inventory.materials.some((m) => m.id === material))
        fail("所选内容已不存在，请刷新素材列表");
    const existing = input.id ? this.plan(input.id) : null;
    if (
      existing &&
      this.state.tasks.some(
        (t) =>
          t.planId === existing.id &&
          ["running", "delegated"].includes(t.status),
      )
    )
      fail("此计划仍有执行中的任务，请先暂停并等待结果后编辑");
    if (existing)
      this.brainRuntime.stop(
        existing.id,
        "计划已修改，自主授权已撤销；异步返回不得继续业务写入",
      );
    const p: OperationsPlan = {
      ...input,
      id: existing?.id ?? id("ioplan"),
      revision: (existing?.revision ?? 0) + 1,
      active: false,
      createdAt: existing?.createdAt ?? this.stamp(),
      updatedAt: this.stamp(),
      advice: existing?.advice ?? null,
    };
    if (existing) this.state.plans[this.state.plans.indexOf(existing)] = p;
    else this.state.plans.push(p);
    for (const t of this.state.tasks.filter(
      (t) => t.planId === p.id && awaiting(t),
    ))
      this.saveTask({
        ...t,
        status: "cancelled",
        cancelOrigin: "policy",
        approvedFingerprint: null,
        reason: "计划规则已修改，旧排期保留历史；新任务需重新规划",
      });
    this.event("plan.saved", "运营计划已保存并暂停；请生成排期后检查", p.id);
    this.persist();
    return p;
  }
  /** Explicit local supply handoff; preserve unrestricted inventories and never activate. */
  linkSuppliedMaterial(planId: string, materialId: string, accountId: string) {
    const plan = this.plan(planId),
      inventory = operationsInventory(this.d),
      material =
        inventory.materials.find((m) => m.id === materialId) ??
        fail("渠道稿已不存在，请刷新库存");
    if (plan.active) fail("请先暂停运营计划，再加入新供稿");
    if (
      !plan.accounts.some(
        (a) => a.accountId === accountId && a.channel === material.channel,
      )
    )
      fail("此稿目标账号未加入该计划，请先在计划中核对账号");
    if (!plan.materialIds.length || plan.materialIds.includes(materialId))
      return;
    this.save({ ...plan, materialIds: [...plan.materialIds, materialId] });
  }
  activate(id: string, active: boolean) {
    const p = this.plan(id);
    if (!active) this.brainRuntime.stop(id, "本人暂停运营计划，自主授权已撤销");
    if (active) {
      const enabled = p.accounts.filter(
        (a) =>
          !a.paused &&
          p.channels.some((c) => c.enabled && c.channel === a.channel),
      );
      if (!enabled.length) fail("请至少启用一个平台策略并选择未暂停的账号");
      for (const other of this.state.plans.filter(
        (o) => o.active && o.id !== id,
      ))
        if (
          other.accounts.some(
            (a) =>
              !a.paused &&
              other.channels.some(
                (c) => c.enabled && c.channel === a.channel,
              ) &&
              enabled.some((e) => e.accountId === a.accountId),
          )
        )
          fail(`账号已由“${other.name}”调度，请先暂停另一运营计划`);
    } else this.stopOwnedTasks(id);
    const previous = p.active;
    p.active = active;
    p.updatedAt = this.stamp();
    this.event(
      active ? "plan.activated" : "plan.paused",
      active
        ? "运营计划已启用；仍需启动全局调度"
        : "运营计划已暂停，尚未提交的中心任务已停止",
      id,
    );
    try {
      this.replan({ planId: id });
    } catch (e) {
      p.active = previous;
      this.persist();
      throw e;
    }
    this.persist();
    return p;
  }
  private stopOwnedTasks(planId?: string) {
    for (const t of this.state.tasks.filter(
      (t) =>
        (!planId || t.planId === planId) &&
        t.channel === "zhihu" &&
        t.linkedTaskId,
    )) {
      const source = this.d.zhihu
        .snapshot()
        .tasks.find((o) => o.id === t.linkedTaskId);
      if (
        source?.status === "queued" &&
        !source.attemptedAt &&
        !source.submittedAt
      ) {
        this.d.zhihu.cancel(source.id);
        this.saveTask({
          ...t,
          status: "cancelled",
          cancelOrigin: "system",
          reason: "调度或计划已暂停，已取消本中心未执行的原知乎任务",
        });
      }
    }
  }
  scheduler(running: boolean) {
    if (this.closed) fail("调度已关闭");
    if (running && !this.state.plans.some((p) => p.active))
      fail("请先启用至少一个运营计划");
    if (!running) this.brainRuntime.stopAll("本人停止统一调度，自主授权已撤销");
    this.running = running;
    this.generation++;
    if (!running) this.stopOwnedTasks();
    this.event(
      running ? "scheduler.started" : "scheduler.stopped",
      running ? "智能运营调度已启动" : "智能运营调度已停止；已提交结果仍需核对",
    );
    if (running) {
      try {
        this.replan({});
      } catch (e) {
        this.running = false;
        this.generation++;
        this.d.changed();
        throw e;
      }
    }
    this.d.changed();
    return running;
  }
  private baseReason(
    plan: OperationsPlan,
    accountId: string,
    kind: OperationsTask["kind"],
  ): string | null {
    if (!plan.active) return "运营计划已暂停，此为本地计划预览";
    const binding = plan.accounts.find((a) => a.accountId === accountId),
      policy = plan.channels.find((c) => c.channel === binding?.channel);
    if (!binding || !policy?.enabled) return "此账号的平台策略未启用";
    if (binding.paused) return "此账号在运营计划中已独立暂停";
    if (binding.channel === "wechat")
      return kind === "handoff" ? null : "公众号当前仅支持人工内容交接";
    let a;
    try {
      a = this.d.accounts.get(accountId);
    } catch {
      return "账号已移除，请编辑运营计划重新选择账号";
    }
    if (
      !a.uid ||
      a.status !== "connected" ||
      !this.d.environments.identityCurrent({ kind: "website", id: accountId })
    )
      return "登录身份尚未核实，请先检查账号";
    if (kind === "publish" && binding.channel === "zhihu") {
      const s = this.d.zhihu.snapshot(),
        source = s.accounts.find((a) => a.id === accountId);
      if (!source?.plan.active)
        return "原知乎账号养号计划已暂停，请在账号与养号中明确启用";
      if (s.running)
        return "知乎原调度正在运行，请先停止原调度，避免与运营中心重复分配素材";
      if (!source.plan.progress?.creator || source.plan.progress.level === null)
        return "知乎创作者状态/等级待检查";
      if (
        policy.purpose === "warming" &&
        source.plan.progress.level >= source.plan.targetLevel
      )
        return "已达到账号目标等级，养号发文停止";
      if (
        policy.purpose === "regular" &&
        source.plan.progress.level < source.plan.targetLevel
      )
        return "尚未达到账号目标等级，正式运营发文等待";
      if (
        s.tasks.some(
          (t) => t.accountId === accountId && t.status === "attention",
        )
      )
        return "此知乎账号有待核对的原发布任务";
      const owned = new Set(
        this.state.tasks
          .filter((t) => t.channel === "zhihu" && !!t.linkedTaskId)
          .map((t) => t.linkedTaskId),
      );
      if (
        s.tasks.some(
          (t) =>
            t.accountId === accountId &&
            ["queued", "running", "submitting"].includes(t.status) &&
            !owned.has(t.id),
        )
      )
        return "此账号有其他模块安排的知乎任务，请先处理原队列，避免重复调度";
    }
    if (
      kind === "publish" &&
      binding.channel === "weibo" &&
      this.d.weiboPosts
        .list(accountId)
        .some((p) =>
          [
            "uncertain",
            "submitting",
            "filling",
            "filled",
            "attention",
          ].includes(p.stage),
        )
    )
      return "此微博账号有未完成的网页填写或待核对结果，请先处理原任务";
    return null;
  }
  private network(accountId: string) {
    try {
      return (
        this.d.environments.forAccount({ kind: "website", id: accountId })
          .network?.ip ?? ""
      );
    } catch {
      return "";
    }
  }
  private accountPolicy(
    plan: OperationsPlan,
    accountId: string,
  ): OperationsChannelPolicy {
    const a =
        plan.accounts.find((a) => a.accountId === accountId) ??
        fail("计划账号不存在"),
      p =
        plan.channels.find((p) => p.channel === a.channel) ??
        fail("平台策略不存在");
    return {
      ...p,
      windowStart: a.windowStart ?? p.windowStart,
      windowEnd: a.windowEnd ?? p.windowEnd,
    };
  }
  replan(raw: unknown = {}) {
    const { planId } = z
      .object({ planId: z.string().max(150).optional() })
      .parse(raw);
    if (planId) this.plan(planId);
    planOperations(
      {
        state: this.state,
        inventory: operationsInventory(this.d),
        now: this.time(),
        d: this.d,
        plan: (id) => this.plan(id),
        baseReason: (plan, accountId, kind) =>
          this.baseReason(plan, accountId, kind),
        accountPolicy: (plan, accountId) => this.accountPolicy(plan, accountId),
        network: (id) => this.network(id),
        stamp: () => this.stamp(),
        saveTask: (task) => this.saveTask(task),
      },
      planId,
    );
    this.lastPlanning = this.time();
    this.persist();
    return this.tasks({ planId: planId ?? "" });
  }
  tasks(raw: unknown = {}): OperationsTaskPage {
    return queryOperationsTasks(this.state.tasks, this.time(), raw);
  }
  cancel(id: string) {
    const t = this.task(id);
    if (t.channel === "zhihu" && t.linkedTaskId) {
      const source = this.d.zhihu
        .snapshot()
        .tasks.find((v) => v.id === t.linkedTaskId);
      if (
        source?.status === "queued" &&
        !source.attemptedAt &&
        !source.submittedAt
      ) {
        this.d.zhihu.cancel(source.id);
        return this.saveTask({
          ...t,
          status: "cancelled",
          reason: "本人取消本中心尚未执行的原知乎任务；原任务历史保留",
          cancelOrigin: "user",
        });
      }
    }
    if (
      t.attemptedAt ||
      t.submittedAt ||
      ["running", "delegated", "completed", "attention"].includes(t.status)
    )
      fail("任务已执行或待核对，不能当作未发任务取消");
    return this.saveTask({
      ...t,
      status: "cancelled",
      cancelOrigin: "user",
      reason: "本人取消尚未执行任务；重排不会复活此任务",
    });
  }
  schedule(id: string, scheduledAt: string) {
    const at = z.iso.datetime({ offset: true }).parse(scheduledAt),
      t = this.task(id);
    if (!awaiting(t) || t.status === "handoff" || t.kind === "supply")
      fail("仅可调整尚未执行的计划任务");
    if (
      Date.parse(at) < this.time() ||
      Date.parse(at) > this.time() + 7 * 86400000
    )
      fail("请选择未来7天内的时间");
    return this.saveTask({
      ...t,
      scheduledAt: new Date(at).toISOString(),
      manualScheduledAt: new Date(at).toISOString(),
      reason: "本人调整预计时间；执行时仍检查时段、额度及间隔",
    });
  }
  review(id: string, fingerprint: string) {
    const t = this.task(id);
    const owned = this.state.brain.provenance.find(
      (p) =>
        p.planId === t.planId &&
        p.materialId === t.materialId &&
        p.accountId === t.accountId,
    );
    if (
      !awaiting(t) ||
      t.kind !== "publish" ||
      !(
        t.channel === "weibo" ||
        (t.channel === "zhihu" && !!t.brainCycleId && !!owned)
      )
    )
      fail("仅可审核未执行的微博或自产知乎发文任务");
    const material = operationsInventory(this.d).materials.find(
      (m) => m.id === t.materialId,
    );
    if (
      !material ||
      !fingerprint ||
      material.fingerprint !== fingerprint ||
      t.fingerprint !== fingerprint
    )
      fail("内容版本已变化，请重新规划并核对准确正文、图片与可见范围");
    if (t.channel === "zhihu") {
      const c = this.d.zhihu.store.get(
        "zhihu_contents",
        t.materialId!.slice(6),
      );
      this.d.zhihu.review(c.id, c.version);
    }
    if (owned) {
      owned.reviewedFingerprint = fingerprint;
      owned.reviewedAt = this.stamp();
      owned.reviewReason =
        "本人通过运营中心显式审阅并确认此准确版本；非模型自动审批";
    }
    const p = this.plan(t.planId),
      block = this.baseReason(p, t.accountId, "publish");
    return this.saveTask({
      ...t,
      approvedFingerprint: fingerprint,
      status: block ? "blocked" : "planned",
      reason: block ?? "本人已审核此准确内容版本，等待符合规则的执行时间",
    });
  }
  handoff(id: string, url?: string) {
    const t = this.task(id);
    if (t.kind !== "handoff" || !["handoff", "blocked"].includes(t.status))
      fail("仅公众号待交接任务可登记完成");
    const material = operationsInventory(this.d).materials.find(
      (m) => m.id === t.materialId,
    );
    if (!material || material.fingerprint !== t.fingerprint)
      fail("内容已变化，请重新规划后交接");
    if (url) {
      const u = new URL(url);
      if (
        u.protocol !== "https:" ||
        u.hostname !== "mp.weixin.qq.com" ||
        u.username ||
        u.password
      )
        fail("请填写公众号官方HTTPS文章链接");
    }
    return this.saveTask({
      ...t,
      status: "completed",
      url: url ?? null,
      reason: url
        ? "本人完成公众号交接并登记官方链接"
        : "本人已完成内容交接；未登记远端发布回执",
    });
  }
  readLogs(raw: unknown = {}) {
    return queryOperationsLogs(this.d.db, this.logs.folder, raw);
  }
  async advice(planId: string): Promise<OperationsAdvice> {
    const p = this.plan(planId);
    if (this.advising.has(planId)) fail("此计划的AI建议正在生成");
    this.d.ai.assertTextConfigured("analysis");
    this.advising.add(planId);
    this.d.changed();
    const revision = p.revision,
      model = this.d.ai.modelFor("analysis");
    try {
      const output = await requestOperationsAdvice(
        this.d.ai,
        p,
        operationsInventory(this.d).materials,
        this.state.tasks,
        model,
      );
      if (this.closed) fail("应用已关闭，建议未写入；费用记录由AI服务保存");
      const advice = {
        ...output,
        createdAt: this.stamp(),
        model,
      };
      if (this.plan(planId).revision !== revision)
        fail("生成期间计划已修改，建议未写入新版本；本次调用费用仍有记录");
      this.plan(planId).advice = advice;
      this.event(
        "advice.created",
        "AI建议已保存，仅供审阅，未改变计划或执行任务",
        planId,
      );
      this.persist();
      return advice;
    } catch (e) {
      this.event("advice.failed", safeMessage(e), planId, undefined, "error");
      throw e;
    } finally {
      this.advising.delete(planId);
      if (!this.closed) this.d.changed();
    }
  }
  private assertCurrent(t: OperationsTask, generation: number) {
    if (this.closed || !this.running || this.generation !== generation)
      fail("智能运营已暂停，未继续提交");
    const p = this.plan(t.planId);
    if (p.revision !== t.planRevision) fail("计划规则已变化，原任务停止");
    if (t.kind === "publish") this.brainRuntime.assertPublication(t);
    const block = this.baseReason(p, t.accountId, t.kind);
    if (block) fail(block);
    if (t.materialId) {
      const material = operationsInventory(this.d).materials.find(
        (m) => m.id === t.materialId,
      );
      if (!material || material.fingerprint !== t.fingerprint)
        fail("内容版本已变化，原审核失效");
      if (t.channel === "weibo" && t.approvedFingerprint !== t.fingerprint)
        fail("微博当前内容尚未审核");
    }
    const policy = this.accountPolicy(p, t.accountId);
    const clock = new Date(this.time() + 8 * 3600000)
      .toISOString()
      .slice(11, 16);
    if (clock < policy.windowStart || clock >= policy.windowEnd)
      fail("当前不在配置执行时段");
    return p;
  }
  /** Read fresh domain attempt records; exclude this exact in-flight submission. */
  private publicationSlot(
    t: OperationsTask,
    p: OperationsPlan,
    startAt = this.time(),
    includeReservations = false,
  ) {
    const policy = this.accountPolicy(p, t.accountId),
      binding =
        p.accounts.find((a) => a.accountId === t.accountId) ??
        fail("账号不再属于此计划");
    const actual: { at: string; accountId: string; network: string }[] = [];
    for (const source of this.d.zhihu
      .snapshot()
      .tasks.filter((o) => !!o.attemptedAt && o.id !== t.linkedTaskId))
      actual.push({
        at: source.attemptedAt!,
        accountId: source.accountId,
        network: source.networkKey ?? "",
      });
    const ownedWeibo = new Set<string>();
    for (const source of this.d.weiboPosts.list()) {
      if (source.id === t.linkedTaskId) continue;
      const at = (source as typeof source & { attemptedAt?: string })
        .attemptedAt;
      if (at) {
        actual.push({
          at,
          accountId: source.accountId,
          network: this.network(source.accountId),
        });
        ownedWeibo.add(source.id);
      }
    }
    for (const o of this.state.tasks.filter(
      (o) =>
        o.channel === "weibo" &&
        o.id !== t.id &&
        o.kind === "publish" &&
        o.attemptedAt,
    )) {
      if (o.linkedTaskId && ownedWeibo.has(o.linkedTaskId)) continue;
      actual.push({
        at: o.attemptedAt!,
        accountId: o.accountId,
        network: this.network(o.accountId),
      });
    }
    if (includeReservations) {
      const linked = new Set<string>();
      for (const other of this.state.tasks.filter(
        (o) =>
          o.id !== t.id &&
          o.kind === "publish" &&
          !!o.scheduledAt &&
          !o.attemptedAt &&
          ["planned", "review", "delegated"].includes(o.status) &&
          this.plan(o.planId).active,
      )) {
        if (other.linkedTaskId) linked.add(other.linkedTaskId);
        actual.push({
          at: other.scheduledAt!,
          accountId: other.accountId,
          network: this.network(other.accountId),
        });
      }
      for (const other of this.d.zhihu
        .snapshot()
        .tasks.filter(
          (o) =>
            o.id !== t.linkedTaskId &&
            o.status === "queued" &&
            !o.attemptedAt &&
            !linked.has(o.id),
        ))
        actual.push({
          at: other.scheduledAt,
          accountId: other.accountId,
          network: other.networkKey ?? this.network(other.accountId),
        });
    }
    return findOperationsSlot(
      Math.max(this.time(), startAt),
      policy,
      Math.min(policy.dailyLimit, binding.dailyLimit ?? 10),
      Math.max(policy.gapMinutes, binding.gapMinutes ?? 60),
      actual,
      t.accountId,
      this.network(t.accountId),
      this.time() + 7 * 86400000,
    );
  }
  private assertPublicationSlot(t: OperationsTask, p: OperationsPlan) {
    const at = this.publicationSlot(t, p);
    if (!at || Date.parse(at) > this.time() + 1000)
      fail(
        "提交前发现额度或同出口间隔变化，原任务停止；请核对并重新规划，未自动重发",
      );
  }
  private async execute(t: OperationsTask, generation: number) {
    const p = this.assertCurrent(t, generation);
    if (t.kind === "publish") {
      const at = this.publicationSlot(t, p);
      if (!at || Date.parse(at) > this.time() + 1000) {
        this.saveTask({
          ...t,
          scheduledAt: at,
          manualScheduledAt: t.manualScheduledAt ? at : null,
          status: at ? (t.linkedTaskId ? "delegated" : "planned") : "blocked",
          reason: at
            ? "执行前重新检查额度/同出口间隔，原任务已顺延"
            : "未来7天暂无符合规则的执行时段",
        });
        return;
      }
    }
    let current = this.saveTask({
      ...t,
      status: "running",
      reason: "正在通过平台原执行器处理",
    });
    try {
      if (t.kind === "progress") {
        current = this.saveTask({ ...current, attemptedAt: this.stamp() });
        await this.d.zhihu.checkProgress(t.accountId);
        this.saveTask({
          ...current,
          status: "completed",
          reason: "已读取官方创作者状态与可识别分数",
        });
      } else if (t.kind === "statistics" && t.url) {
        current = this.saveTask({ ...current, attemptedAt: this.stamp() });
        await this.d.weiboStatistics.refresh(t.accountId, t.url);
        this.saveTask({
          ...current,
          status: "completed",
          reason: "已保存本人微博的官方反馈快照",
        });
      } else if (
        t.kind === "publish" &&
        t.channel === "zhihu" &&
        t.materialId
      ) {
        this.assertCurrent(t, generation);
        const linked = t.linkedTaskId
          ? (this.d.zhihu
              .snapshot()
              .tasks.find((o) => o.id === t.linkedTaskId) ??
            fail("原知乎任务不存在，不能重建"))
          : this.d.zhihu.enqueue(
              t.accountId,
              t.materialId.slice(6),
              t.scheduledAt!,
            );
        if (
          linked.status !== "queued" ||
          linked.attemptedAt ||
          linked.submittedAt
        )
          fail("原知乎任务已执行或提交，不能再次执行");
        current = this.saveTask({
          ...current,
          status: "delegated",
          linkedTaskId: linked.id,
          reason: "已转交原知乎任务，仅执行此任务，不启动原自动分配",
        });
        await this.d.zhihu.executeManaged(linked.id, () => {
          const plan = this.assertCurrent(current, generation);
          this.assertPublicationSlot(current, plan);
          return true;
        });
        if (this.closed) return;
        const result = existingOperationsState(this.d, current);
        if (result) this.saveTask({ ...current, ...result });
      } else if (
        t.kind === "publish" &&
        t.channel === "weibo" &&
        t.materialId
      ) {
        const post = this.d.weiboPosts.get(t.materialId.slice(6));
        if (post.stage !== "editing" || post.submittedAt)
          fail("微博原草稿已有执行/提交记录，停止并核对原任务；请勿重发");
        current = this.saveTask({
          ...current,
          attemptedAt: this.stamp(),
          linkedTaskId: post.id,
        });
        const filled = await this.d.weiboPosts.fill(post.id);
        if (this.closed) return;
        if (filled.stage !== "filled") fail(filled.message);
        // baseReason excludes existing filled drafts, so this owned draft must be
        // checked by exact id and fingerprint rather than treated as a new draft.
        const gate = () => {
          this.assertOwnedWeibo(current, generation);
        };
        gate();
        const result = await this.d.weiboPosts.submit(post.id, gate);
        if (this.closed) return;
        current = {
          ...current,
          submittedAt: ["submitted", "uncertain", "submitting"].includes(
            result.stage,
          )
            ? this.stamp()
            : null,
          url: result.url,
        };
        this.saveTask({
          ...current,
          status:
            result.stage === "submitted" && result.url
              ? "completed"
              : "attention",
          reason: result.message,
        });
      } else fail("此任务需要人工交接或核对，不能自动执行");
    } catch (e) {
      if (this.closed) return;
      const linked = existingOperationsState(this.d, current);
      this.saveTask({
        ...current,
        ...linked,
        status: linked?.status === "completed" ? "completed" : "attention",
        reason:
          linked?.status === "completed" ? linked.reason! : safeMessage(e),
      });
    }
  }
  private assertOwnedWeibo(t: OperationsTask, generation: number) {
    if (this.closed || !this.running || generation !== this.generation)
      fail("智能运营已暂停，未继续提交");
    this.brainRuntime.assertPublication(t);
    const p = this.plan(t.planId),
      binding = p.accounts.find((a) => a.accountId === t.accountId),
      policy = p.channels.find((c) => c.channel === "weibo");
    if (
      !p.active ||
      p.revision !== t.planRevision ||
      !binding ||
      binding.paused ||
      !policy?.enabled
    )
      fail("计划或账号已暂停/修改，未继续提交");
    const a = this.d.accounts.get(t.accountId);
    if (
      a.status !== "connected" ||
      !this.d.environments.identityCurrent({ kind: "website", id: a.id })
    )
      fail("微博登录身份需重新核实");
    const material = operationsInventory(this.d).materials.find(
      (m) => m.id === t.materialId,
    );
    if (
      !material ||
      material.fingerprint !== t.fingerprint ||
      t.approvedFingerprint !== t.fingerprint
    )
      fail("微博内容或审核版本已变化，未继续提交");
    const window = this.accountPolicy(p, t.accountId),
      clock = new Date(this.time() + 8 * 3600000).toISOString().slice(11, 16);
    if (clock < window.windowStart || clock >= window.windowEnd)
      fail("当前已超出账号执行时段，未继续提交");
    if (
      this.d.weiboPosts
        .list(t.accountId)
        .some(
          (o) =>
            o.id !== t.linkedTaskId &&
            [
              "filled",
              "filling",
              "attention",
              "uncertain",
              "submitting",
            ].includes(o.stage),
        )
    )
      fail("其他微博任务出现未完成结果，请先核对原任务");
    this.assertPublicationSlot(t, p);
  }
  async tick() {
    if (this.closed || !this.running || this.executing) return;
    this.executing = true;
    const generation = this.generation;
    try {
      this.lastHeartbeatAt = this.stamp();
      if (this.time() - this.lastPlanning >= 30000) this.replan({});
      await this.brainRuntime.tick();
      if (this.closed || !this.running || generation !== this.generation)
        return;
      const next = this.state.tasks
        .filter(
          (t) =>
            this.plan(t.planId).active &&
            (t.status === "planned" ||
              (t.status === "delegated" &&
                t.channel === "zhihu" &&
                !!t.linkedTaskId &&
                !t.attemptedAt &&
                !t.submittedAt)) &&
            t.scheduledAt &&
            Date.parse(t.scheduledAt) <= this.time(),
        )
        .sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!))[0];
      if (next) {
        try {
          await this.execute(next, generation);
        } catch (error) {
          if (!this.closed)
            this.saveTask({
              ...next,
              status:
                next.attemptedAt || next.linkedTaskId ? "attention" : "blocked",
              reason: safeMessage(error),
            });
        }
      }
    } catch (e) {
      this.event(
        "scheduler.failed",
        safeMessage(e),
        undefined,
        undefined,
        "error",
      );
    } finally {
      this.executing = false;
      if (!this.closed) this.d.changed();
    }
  }
  close() {
    if (this.closed) return;
    this.running = false;
    this.brainRuntime.close();
    this.generation++;
    clearInterval(this.timer);
    this.stopOwnedTasks();
    this.closed = true;
  }
}

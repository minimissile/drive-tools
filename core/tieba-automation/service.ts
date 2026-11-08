import type { z } from "zod";
import { id, type Database } from "../database";
import { AppError, safeMessage } from "../errors";
import type { WebsiteAccounts } from "../website-accounts";
import type { BrowserEnvironments } from "../browser-environments";
import type { TiebaParticipation } from "../tieba-participation/service";
import { TiebaAutocareStore } from "../tieba-autocare/store";
import { RuntimeLog } from "../runtime-log";
import type { EnvironmentStamp } from "../../shared/browser-environments";
import {
  tiebaAutomationConfigSchema,
  type TiebaAutomationSnapshot,
  type TiebaAutomationStatus,
  type tiebaAutomationSaveSchema,
  type tiebaAutomationToggleSchema,
} from "../../shared/tieba-automation";
import type { TiebaReplyDraft } from "../../shared/tieba-participation";
import {
  TiebaAutomationStore,
  type AutomationTaskRecord,
  type AutomationAuthority,
} from "./store";

type Participation = Pick<
  TiebaParticipation,
  | "isBusy"
  | "snapshot"
  | "discover"
  | "read"
  | "generate"
  | "submit"
  | "reconcile"
>;
type Dependencies = {
  db: Database;
  participation: Participation;
  accounts: Pick<WebsiteAccounts, "get">;
  environments: Pick<BrowserEnvironments, "forAccount" | "assertStamp">;
  dataPath: string;
  changed(): void;
  clock?(): number;
};
const day = (time: number) =>
  new Date(time + 8 * 3600000).toISOString().slice(0, 10);
const sameStamp = (a: EnvironmentStamp, b: EnvironmentStamp) =>
  a.environmentId === b.environmentId &&
  a.revision === b.revision &&
  a.identityId === b.identityId &&
  a.identityRevision === b.identityRevision;
const live = (task: AutomationTaskRecord) =>
  ["pending", "running"].includes(task.status);

/** A bounded rule runner. All website and model work belongs to the participation service. */
export class TiebaAutomation {
  readonly store: TiebaAutomationStore;
  readonly logs: RuntimeLog;
  private targets: TiebaAutocareStore;
  private working = false;
  private closed = false;
  private suspended = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private d: Dependencies) {
    this.store = new TiebaAutomationStore(d.db);
    this.targets = new TiebaAutocareStore(d.db);
    this.logs = new RuntimeLog(d.db, d.dataPath, "tieba-automation");
    const state = this.store.state();
    // An enabled setting is intent, never a reusable authorization after restart.
    if (
      state.enabled ||
      state.authorities.length ||
      this.store.tasks().some(live)
    ) {
      state.enabled = false;
      state.authorities = [];
      state.revision++;
      if (state.run) state.run.status = "stopped";
      this.store.saveState(state);
      for (const task of this.store.tasks().filter(live)) {
        const draft = this.findDraft(task);
        if (draft) this.captureDraft(task, draft);
        this.finish(
          task,
          draft
            ? this.statusFor(draft)
            : task.status === "running" && task.step === "generate"
              ? "attention"
              : "cancelled",
          "后台重启已停止本批次；原稿和可能已发生的请求仅供人工检查，不自动重放。",
        );
      }
    }
  }
  get isBusy() {
    return this.working;
  }
  private time() {
    return this.d.clock?.() ?? Date.now();
  }
  private now() {
    return new Date(this.time()).toISOString();
  }
  private alive() {
    if (this.closed)
      throw new AppError("TIEBA_AUTOMATION_CLOSED", "贴吧自动批次已停止。");
  }
  private event(
    event: string,
    message: string,
    task?: AutomationTaskRecord,
    level: "info" | "warning" | "error" = "info",
  ) {
    if (!this.closed)
      this.logs.record({
        event,
        message,
        taskId: task?.id,
        accountId: task?.accountId,
        level,
      });
  }
  private finish(
    task: AutomationTaskRecord,
    status: TiebaAutomationStatus,
    message: string,
  ) {
    this.alive();
    task.status = status;
    task.message = message;
    task.updatedAt = this.now();
    this.store.saveTask(task);
    this.event(
      "task.result",
      message,
      task,
      ["attention", "uncertain", "failed"].includes(status)
        ? "warning"
        : "info",
    );
  }
  private authority(targetId: string): AutomationAuthority {
    const target = this.targets.target(targetId);
    if (!target || target.paused)
      throw new AppError(
        "TIEBA_AUTOMATION_TARGET",
        target?.pauseReason || "请选择存在且未暂停的贴吧。",
      );
    const account = this.d.accounts.get(target.accountId);
    if (
      account.provider !== "tieba" ||
      account.status !== "connected" ||
      !account.uid ||
      account.uid !== target.uid
    )
      throw new AppError(
        "TIEBA_AUTOMATION_IDENTITY",
        "请先核实所选贴吧绑定的原账号身份。",
      );
    const ref = { kind: "website" as const, id: account.id };
    if (this.d.environments.forAccount(ref).engine !== "bitbrowser")
      throw new AppError(
        "TIEBA_AUTOMATION_ENVIRONMENT",
        "自动批次需要账号绑定的指纹浏览器环境。",
      );
    this.d.environments.assertStamp(ref, target.stamp);
    return {
      targetId,
      accountId: account.id,
      uid: account.uid,
      forumId: target.forumId,
      stamp: target.stamp,
    };
  }
  private guard(task: AutomationTaskRecord) {
    this.alive();
    if (this.suspended)
      throw new AppError(
        "TIEBA_AUTOMATION_REVOKED",
        "自动批次正在暂时停止，未继续此步骤。",
      );
    const state = this.store.state();
    if (
      !state.enabled ||
      state.revision !== task.configRevision ||
      state.run?.id !== task.runId ||
      state.run.status !== "running" ||
      !state.config.targetIds.includes(task.targetId) ||
      state.config.mode !== task.mode
    )
      throw new AppError(
        "TIEBA_AUTOMATION_REVOKED",
        "自动开关、配置或批次已变化，已停止此步骤。",
      );
    if (
      task.day !== day(this.time()) ||
      Date.parse(task.deadlineAt) <= this.time()
    )
      throw new AppError(
        "TIEBA_AUTOMATION_EXPIRED",
        "本批次已跨日或到期，不补跑后续步骤。",
      );
    const original = state.authorities.find(
      (entry) => entry.targetId === task.targetId,
    );
    const current = this.authority(task.targetId);
    if (
      !original ||
      current.accountId !== task.accountId ||
      current.uid !== task.uid ||
      current.forumId !== task.forumId ||
      original.uid !== task.uid ||
      !sameStamp(original.stamp, task.stamp) ||
      !sameStamp(current.stamp, task.stamp)
    )
      throw new AppError(
        "TIEBA_AUTOMATION_SCOPE",
        "原账号、贴吧或环境已变化，需重新检查后明确开启。",
      );
  }
  snapshot(): TiebaAutomationSnapshot {
    this.alive();
    const state = this.store.state(),
      tasks = this.store.tasks();
    const pending = tasks.filter(
      (task) => live(task) || ["attention", "uncertain"].includes(task.status),
    );
    const history = tasks
      .filter((task) => !pending.some((row) => row.id === task.id))
      .slice(0, 300);
    return {
      revision: state.revision,
      enabled: state.enabled,
      busy: this.working,
      config: state.config,
      run: state.run,
      accounts: this.d.db
        .all<{ id: string }>(
          "SELECT id FROM website_accounts WHERE provider='tieba' ORDER BY created_at",
        )
        .map(({ id }) => this.d.accounts.get(id)),
      targets: this.targets
        .targets()
        .map(({ stamp: _stamp, ...target }) => target),
      tasks: [...pending, ...history].map(({ stamp: _stamp, ...task }) => task),
      logs: this.logs.read({}),
      message: state.enabled
        ? "已授权范围内的低频批次；每步重查身份与范围，结果未知只供核对。"
        : "自动批次已关闭。开启会授权所选范围内的模型费用；发布模式另含自动提交。",
    };
  }
  private revision(expected: number) {
    const state = this.store.state();
    if (state.revision !== expected)
      throw new AppError(
        "TIEBA_AUTOMATION_REVISION",
        "自动配置已在其他窗口更新，请刷新后重试。",
      );
    return state;
  }
  private cancelPending(message: string) {
    for (const task of this.store.tasks())
      if (task.status === "pending") this.finish(task, "cancelled", message);
  }
  save(input: z.infer<typeof tiebaAutomationSaveSchema>) {
    this.alive();
    const state = this.revision(input.revision),
      config = tiebaAutomationConfigSchema.parse(input.config);
    for (const targetId of config.targetIds) this.authority(targetId);
    state.config = config;
    state.revision++;
    state.enabled = false;
    state.authorities = [];
    if (state.run) state.run.status = "stopped";
    this.store.saveState(state);
    this.cancelPending(
      "配置已修改，原自动授权已撤销；已生成正文保留供人工操作。",
    );
    this.event(
      "config.saved",
      "配置已保存，自动开关保持关闭，需明确授权后开启。",
    );
    this.d.changed();
    return this.snapshot();
  }
  toggle(input: z.infer<typeof tiebaAutomationToggleSchema>) {
    this.alive();
    const state = this.revision(input.revision);
    if (input.confirmed !== true)
      throw new AppError(
        "TIEBA_AUTOMATION_CONFIRMATION",
        "请明确确认此模式的模型费用和执行范围。",
      );
    if (state.enabled === input.enabled) return this.snapshot();
    if (input.enabled && !state.config.targetIds.length)
      throw new AppError(
        "TIEBA_AUTOMATION_TARGET",
        "请先选择至少一个未暂停的贴吧。",
      );
    const authorities = input.enabled
      ? state.config.targetIds.map((targetId) => this.authority(targetId))
      : [];
    state.revision++;
    state.enabled = input.enabled;
    state.authorities = authorities;
    if (!input.enabled && state.run) state.run.status = "stopped";
    this.store.saveState(state);
    if (input.enabled) this.plan();
    else
      this.cancelPending(
        "自动开关已关闭，取消未执行步骤，原稿保留供人工检查。",
      );
    this.event(
      "automation.toggled",
      input.enabled
        ? "已明确授权当前模式和所选贴吧；当日批次不延长，停止的步骤不重放。"
        : "已关闭自动批次。",
    );
    this.d.changed();
    return this.snapshot();
  }
  private expire() {
    for (const task of this.store.tasks())
      if (
        task.status === "pending" &&
        (task.day !== day(this.time()) ||
          Date.parse(task.deadlineAt) <= this.time())
      )
        this.finish(task, "expired", "原批次已到期或跨日，未追赶执行。");
    const state = this.store.state();
    if (
      state.run?.status === "running" &&
      (state.run.day !== day(this.time()) ||
        Date.parse(state.run.deadlineAt) <= this.time())
    ) {
      state.run.status = "ended";
      this.store.saveState(state);
    }
  }
  private plan() {
    const state = this.store.state(),
      today = day(this.time());
    if (!state.enabled || state.run?.day === today) return;
    const deadline = Math.min(
      this.time() + 2 * 3600000,
      Date.parse(`${today}T16:00:00Z`),
    );
    state.run = {
      id: id("tiebaautorun"),
      day: today,
      startedAt: this.now(),
      deadlineAt: new Date(deadline).toISOString(),
      status: "running",
    };
    this.store.saveState(state);
    const targets = state.config.targetIds;
    // Rotate the starting forum each day; the daily limit is global, not multiplied by targets.
    const offset =
      Math.floor((this.time() + 8 * 3600000) / 86400000) % targets.length;
    for (let i = 0; i < state.config.dailyLimit; i++) {
      const targetId = targets[(offset + i) % targets.length],
        target = this.targets.target(targetId);
      const authority = state.authorities.find(
        (entry) => entry.targetId === targetId,
      );
      if (!target || !authority) continue;
      const planned = this.time() + i * 45 * 60000;
      const task: AutomationTaskRecord = {
        id: id("tiebaauto"),
        runId: state.run.id,
        day: today,
        targetId,
        accountId: authority.accountId,
        uid: authority.uid,
        forumId: authority.forumId,
        forumName: target.name,
        mode: state.config.mode,
        configRevision: state.revision,
        step: "discover",
        status: planned < deadline ? "pending" : "expired",
        candidateId: null,
        draftId: null,
        draftVersion: null,
        stamp: authority.stamp,
        plannedAt: new Date(planned).toISOString(),
        deadlineAt: state.run.deadlineAt,
        startedAt: null,
        createdAt: this.now(),
        updatedAt: this.now(),
        message: "等待低频批次读取帖子。",
      };
      this.store.saveTask(task);
    }
  }
  private findDraft(task: AutomationTaskRecord) {
    return this.d.participation
      .snapshot()
      .drafts.find((draft) =>
        task.draftId
          ? draft.id === task.draftId
          : !!task.candidateId && draft.candidateId === task.candidateId,
      );
  }
  private captureDraft(task: AutomationTaskRecord, draft: TiebaReplyDraft) {
    task.draftId = draft.id;
    task.draftVersion = draft.version;
  }
  private statusFor(draft: TiebaReplyDraft): TiebaAutomationStatus {
    if (draft.status === "verified") return "verified";
    if (
      draft.status === "uncertain" ||
      (draft.status === "submitting" && draft.submittedAt)
    )
      return "uncertain";
    if (["generating", "attention"].includes(draft.status)) return "attention";
    if (draft.status === "skipped") return "skipped";
    if (draft.status === "failed") return "failed";
    return "draft";
  }
  private advance(
    task: AutomationTaskRecord,
    step: AutomationTaskRecord["step"],
    message: string,
  ) {
    this.guard(task);
    task.step = step;
    task.status = "pending";
    task.message = message;
    task.updatedAt = this.now();
    this.store.saveTask(task);
  }
  private async execute(task: AutomationTaskRecord) {
    this.guard(task);
    task.status = "running";
    task.startedAt ??= this.now();
    task.updatedAt = this.now();
    this.store.saveTask(task);
    const p = this.d.participation;
    if (task.step === "discover") {
      const result = await p.discover({ targetId: task.targetId });
      this.guard(task);
      const candidate = result.candidates.find(
        (row) =>
          row.targetId === task.targetId &&
          row.uid === task.uid &&
          row.status !== "skipped" &&
          !result.drafts.some(
            (draft) => draft.uid === row.uid && draft.threadId === row.threadId,
          ),
      );
      if (!candidate)
        return this.finish(
          task,
          "skipped",
          "没有新的可参与主题；已有草稿或参与记录不自动重试。",
        );
      task.candidateId = candidate.id;
      return this.advance(task, "read", "候选已保存，等待读取完整上下文。");
    }
    if (task.step === "read") {
      const result = await p.read({ candidateId: task.candidateId! });
      this.guard(task);
      const candidate = result.candidates.find(
        (row) => row.id === task.candidateId,
      );
      if (candidate?.status !== "read")
        return this.finish(
          task,
          "skipped",
          candidate?.message || "帖子上下文不可用，跳过自动生成。",
        );
      return this.advance(
        task,
        "generate",
        "上下文已读取，等待按授权模式生成。",
      );
    }
    if (task.step === "generate") {
      const result = await p.generate(
        { candidateId: task.candidateId!, confirmed: true },
        () => this.guard(task),
      );
      this.alive();
      const draft = result.drafts.find(
        (row) => row.candidateId === task.candidateId,
      );
      if (!draft)
        return this.finish(
          task,
          "attention",
          "生成操作没有返回可追踪草稿，请人工检查费用记录，不重试。",
        );
      this.captureDraft(task, draft);
      this.guard(task);
      if (draft.status === "ready" && task.mode === "publish")
        return this.advance(
          task,
          "submit",
          "稿件检查通过，等待授权范围内的下一步提交。",
        );
      task.step = "done";
      return this.finish(
        task,
        this.statusFor(draft),
        draft.status === "ready"
          ? "本轮仅生成草稿，正文已保存供人工审阅。"
          : draft.message,
      );
    }
    if (task.step === "submit") {
      const draft = this.findDraft(task);
      if (
        !draft ||
        draft.version !== task.draftVersion ||
        draft.status !== "ready"
      )
        return this.finish(
          task,
          "draft",
          "草稿已被编辑或状态变化，取消自动提交，保留人工处理。",
        );
      const result = await p.submit(
        { draftId: draft.id, version: task.draftVersion!, confirmed: true },
        () => this.guard(task),
      );
      this.alive();
      const updated = result.drafts.find((row) => row.id === draft.id);
      if (!updated)
        return this.finish(
          task,
          "attention",
          "原提交记录不可读取，请人工核对，不重试。",
        );
      this.captureDraft(task, updated);
      task.step = "done";
      return this.finish(task, this.statusFor(updated), updated.message);
    }
  }
  async tick() {
    if (
      this.closed ||
      this.suspended ||
      this.working ||
      this.d.participation.isBusy
    )
      return;
    this.expire();
    this.plan();
    if (!this.store.state().enabled) return;
    const task = this.store
      .tasks()
      .filter(
        (row) =>
          row.status === "pending" && Date.parse(row.plannedAt) <= this.time(),
      )
      .sort((a, b) => a.plannedAt.localeCompare(b.plannedAt))[0];
    if (!task) return;
    this.working = true;
    this.d.changed();
    try {
      await this.execute(task);
    } catch (error) {
      if (this.closed) return;
      const draft = this.findDraft(task);
      if (draft) this.captureDraft(task, draft);
      const expired =
        task.day !== day(this.time()) ||
        Date.parse(task.deadlineAt) <= this.time();
      this.finish(
        task,
        draft
          ? this.statusFor(draft)
          : expired
            ? "expired"
            : error instanceof AppError &&
                /REVOKED|SCOPE|TARGET|IDENTITY|ENVIRONMENT/.test(error.code)
              ? "cancelled"
              : "failed",
        `${safeMessage(error)}${draft ? "；原稿保留，不自动重放。" : "；本任务停止，不补跑。"}`,
      );
    } finally {
      this.working = false;
      if (!this.closed) this.d.changed();
    }
  }
  async reconcile(input: { taskId: string }) {
    this.alive();
    if (this.working || this.d.participation.isBusy)
      throw new AppError(
        "TIEBA_AUTOMATION_BUSY",
        "请等待当前帖子操作结束后核对。",
      );
    const task = this.store.task(input.taskId);
    if (!task || task.status !== "uncertain" || !task.draftId)
      throw new AppError(
        "TIEBA_AUTOMATION_RECONCILE",
        "只有提交结果未知的原任务可执行只读核对。",
      );
    this.working = true;
    this.d.changed();
    try {
      const result = await this.d.participation.reconcile({
        draftId: task.draftId,
      });
      this.alive();
      const draft = result.drafts.find((row) => row.id === task.draftId);
      if (draft) {
        this.captureDraft(task, draft);
        this.finish(task, this.statusFor(draft), draft.message);
      }
      return this.snapshot();
    } finally {
      this.working = false;
      if (!this.closed) this.d.changed();
    }
  }
  start(enabled = true) {
    this.alive();
    if (!enabled) {
      this.suspended = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    this.suspended = false;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        if (!this.closed)
          this.event(
            "automation.error",
            safeMessage(error),
            undefined,
            "error",
          );
      });
    }, 15000);
    this.timer.unref?.();
  }
  dispose() {
    if (this.closed) return;
    if (this.timer) clearInterval(this.timer);
    const state = this.store.state();
    if (state.enabled) {
      state.enabled = false;
      state.authorities = [];
      state.revision++;
      if (state.run) state.run.status = "stopped";
      this.store.saveState(state);
    }
    this.cancelPending("后台停止已撤销自动执行授权，原稿保留，不重放。");
    this.closed = true;
  }
}

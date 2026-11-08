import { tiebaFollowWriteState } from "../tieba-autocare/store";
import { tiebaPublishingWriteState } from "../tieba-publishing/store";
import type { z } from "zod";
import type { Database } from "../database";
import { id } from "../database";
import type { AppPorts } from "../ports";
import type { WebsiteAccounts } from "../website-accounts";
import type { BrowserEnvironments } from "../browser-environments";
import type { BrowserEnvironmentQueue } from "../browser-environment-queue";
import { AppError, safeMessage } from "../errors";
import { RuntimeLog } from "../runtime-log";
import {
  tiebaAutocareConfigSchema,
  tiebaAutocareObserveSchema,
  tiebaAutocareFollowSchema,
  tiebaAutocareAddSchema,
  type TiebaAutocareSnapshot,
  type TiebaForumReading,
  type tiebaAutocareSaveSchema,
  type tiebaAutocareToggleSchema,
  type tiebaAutocarePauseSchema,
} from "../../shared/tieba-autocare";
import {
  decodeTiebaForumUrlName,
  normalizeTiebaForumName,
} from "../../shared/tieba-forums";
import {
  tiebaFindForumsSchema,
  type TiebaForumDiscoveryResult,
} from "../../shared/tieba-forum-discovery";
import type { EnvironmentStamp } from "../../shared/browser-environments";
import type { WebsiteAccount } from "../../shared/website-accounts";
import {
  TiebaAutocareStore,
  type AutocareState,
  type TargetRecord,
  type TaskRecord,
} from "./store";
import {
  tiebaForumReadingFields as readingFields,
  verifiedTiebaFollowState,
} from "./follow-state";

const runDuration = 2 * 60 * 60 * 1000;
const taskGap = 60 * 1000;
const ref = (id: string) => ({ kind: "website" as const, id });
export const tiebaAutocareStateKey = "tiebaAutocare:v1";
export function tiebaDay(time: number | string) {
  return new Date(
    (typeof time === "number" ? time : Date.parse(time)) + 8 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);
}
type Dependencies = {
  db: Database;
  accounts: WebsiteAccounts;
  environments: BrowserEnvironments;
  queue: BrowserEnvironmentQueue;
  ports: AppPorts;
  dataPath: string;
  changed(): void;
  clock?(): number;
};
type OperationScope = { assert(): void; failed?(error: unknown): void };

/** Rule authority is independent of AI and cannot expand when new forums are synced. */
export class TiebaAutocare {
  readonly logs: RuntimeLog;
  readonly store: TiebaAutocareStore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private working = false;
  private operations = 0;
  private controllers = new Set<AbortController>();
  private following = new Set<string>();
  private adding = new Set<string>();
  constructor(private d: Dependencies) {
    this.logs = new RuntimeLog(d.db, d.dataPath, "tieba-autocare");
    this.store = new TiebaAutocareStore(d.db);
    for (const target of this.store.targets())
      if (target.followIntent?.status === "submitting") {
        target.followIntent.status = "uncertain";
        target.followIntent.message =
          "上次关注请求已中断，只能只读核对原关系，不重复关注。";
        this.store.saveTarget(target);
      }
    for (const task of this.store.tasks()) {
      if (
        task.status === "submitting" ||
        (task.status === "running" && task.submittedAt)
      )
        this.finish(
          task,
          "uncertain",
          "上次签到提交已中断，请只读核对原结果，不会自动重签。",
        );
      else if (task.status === "running")
        this.finish(
          task,
          this.expired(task) ? "expired" : "pending",
          "上次执行在提交前中断，保留原排期。",
        );
    }
    this.expirePending();
    // Reconcile persisted configuration with its queue after an interrupted save.
    if (this.store.state().enabled) this.d.db.transaction(() => this.plan());
  }
  get isBusy() {
    return this.operations > 0 || this.working || this.adding.size > 0;
  }
  private time() {
    return this.d.clock?.() ?? Date.now();
  }
  private now() {
    return new Date(this.time()).toISOString();
  }
  private assertAlive() {
    if (this.disposed)
      throw new AppError(
        "TIEBA_SERVICE_CLOSED",
        "贴吧调度已停止，原任务保留供下次启动核对。",
      );
  }
  private matchesTaskDay(task: TaskRecord, reading: TiebaForumReading) {
    return (
      Number.isFinite(Date.parse(reading.checkedAt)) &&
      tiebaDay(reading.checkedAt) === task.day &&
      tiebaDay(this.time()) === task.day
    );
  }
  private browser() {
    if (!this.d.ports.tieba)
      throw new AppError(
        "TIEBA_BROWSER_UNAVAILABLE",
        "当前后端尚未接入贴吧操作，请应用更新后重试。",
      );
    return this.d.ports.tieba;
  }
  private account(accountId: string) {
    const account = this.d.accounts.get(accountId);
    if (account.provider !== "tieba")
      throw new AppError("TIEBA_ACCOUNT_REQUIRED", "请选择贴吧账号。");
    if (this.d.environments.forAccount(ref(account.id)).engine !== "bitbrowser")
      throw new AppError(
        "TIEBA_BROWSER_REQUIRED",
        "贴吧自动养号需要账号关联指纹浏览器环境，请在账号管理中检查。",
      );
    return account;
  }
  private revision(expected: number) {
    const state = this.store.state();
    if (state.revision !== expected)
      throw new AppError(
        "TIEBA_CONFIG_CHANGED",
        "设置已在其他窗口变化，请刷新后再保存。",
      );
    return state;
  }
  private selected(state: AutocareState) {
    return state.config.targetIds.map((targetId) => {
      const target = this.store.target(targetId);
      if (!target)
        throw new AppError(
          "TIEBA_TARGET_MISSING",
          "目标贴吧已不存在，请重新选择。",
        );
      if (target.source === "observed")
        throw new AppError(
          "TIEBA_OBSERVED_NOT_FOLLOWED",
          `「${target.name}吧」仍是观察吧，仅可读取；请在官网关注后同步关注吧，再选择签到。`,
        );
      const account = this.account(target.accountId);
      if (
        !account.uid ||
        account.uid !== target.uid ||
        account.status !== "connected"
      )
        throw new AppError(
          "TIEBA_IDENTITY_CHANGED",
          "目标贴吧的账号身份未核实，请检查登录并重新同步关注吧。",
        );
      this.d.environments.assertStamp(ref(account.id), target.stamp);
      return target;
    });
  }
  private authorities(state: AutocareState) {
    return this.selected(state).map((target) => ({
      targetId: target.id,
      uid: target.uid,
      stamp: target.stamp,
    }));
  }
  snapshot(): TiebaAutocareSnapshot {
    this.assertAlive();
    const state = this.store.state(),
      day = tiebaDay(this.time());
    const accounts: WebsiteAccount[] = this.d.db
      .all<{ id: string }>(
        "SELECT id FROM website_accounts WHERE provider='tieba' ORDER BY created_at",
      )
      .map(({ id }) => this.d.accounts.get(id));
    const targets = this.store
      .targets()
      .map(({ stamp: _stamp, ...target }) => ({
        ...target,
        source: target.source ?? "followed",
        signed: tiebaDay(target.checkedAt) === day ? target.signed : null,
        canSign: tiebaDay(target.checkedAt) === day ? target.canSign : null,
      }));
    const tasks = this.store
      .tasks()
      .slice(0, 500)
      .map(({ stamp: _stamp, configSnapshot: _config, ...task }) => task);
    const today = tasks.filter((task) => task.day === day);
    const issues = today.some((task) =>
      ["uncertain", "failed"].includes(task.status),
    );
    const pending = today.some((task) =>
      ["pending", "running", "submitting"].includes(task.status),
    );
    const allPaused =
      state.config.targetIds.length > 0 &&
      state.config.targetIds.every(
        (id) => targets.find((target) => target.id === id)?.paused,
      );
    const message = this.adding.size
      ? "正在逐项添加贴吧并核实关注，签到范围保持原选择"
      : this.disposed
        ? "调度已停止"
        : !state.enabled
          ? this.isBusy
            ? "正在收尾，停止新的签到提交"
            : "已关闭，开启后按所选目标自动签到"
          : issues
            ? "部分任务需要处理，请查看具体原因，其他目标继续执行"
            : allPaused
              ? "所选目标均已暂停，请在目标行查看原因并恢复"
              : this.isBusy
                ? "正在核对账号和贴吧签到结果"
                : state.run &&
                    (state.run.status !== "running" ||
                      Date.parse(state.run.deadlineAt) <= this.time())
                  ? "本轮已结束，未完成任务保留原因，不集中补签"
                  : pending
                    ? "等待下一项签到任务"
                    : "本轮签到已完成，等待下一业务日";
    return {
      revision: state.revision,
      enabled: state.enabled,
      busy: this.isBusy,
      config: state.config,
      run: state.run,
      accounts,
      targets,
      tasks,
      logs: this.logs.read({}),
      message,
    };
  }
  save(input: z.infer<typeof tiebaAutocareSaveSchema>) {
    this.assertAlive();
    const state = this.revision(input.revision);
    const config = tiebaAutocareConfigSchema.parse(input.config);
    if (state.enabled && !config.targetIds.length)
      throw new AppError(
        "TIEBA_TARGET_REQUIRED",
        "开启期间请保留至少一个目标贴吧，或先关闭总开关。",
      );
    const next = { ...state, config, revision: state.revision + 1 };
    // Checking selected identities also prevents silently saving an unsupported engine.
    next.authorities = this.authorities(next);
    this.d.db.transaction(() => {
      this.store.saveState(next);
      this.cancelUnselected(next);
      if (next.enabled) this.plan(next);
    });
    this.event(
      "config.saved",
      "已保存目标贴吧设置，新的同步结果不会自动加入执行范围。",
    );
    this.d.changed();
    return this.snapshot();
  }
  toggle(input: z.infer<typeof tiebaAutocareToggleSchema>) {
    this.assertAlive();
    const state = this.revision(input.revision);
    if (input.enabled) {
      this.browser();
      if (!state.config.targetIds.length)
        throw new AppError(
          "TIEBA_TARGET_REQUIRED",
          "请先同步并选择至少一个目标贴吧。",
        );
      state.authorities = this.authorities(state);
      if (this.selected(state).every((target) => target.paused))
        throw new AppError(
          "TIEBA_TARGET_PAUSED",
          "所选目标均已暂停，请先恢复至少一个目标。",
        );
    }
    state.enabled = input.enabled;
    state.revision++;
    if (!input.enabled) {
      for (const controller of this.controllers) controller.abort();
      if (state.run?.status === "running") state.run.status = "stopped";
    }
    this.d.db.transaction(() => {
      this.store.saveState(state);
      if (input.enabled) this.plan(state);
      else
        for (const task of this.store.tasks())
          if (task.status === "pending")
            this.finish(
              task,
              "cancelled",
              "总开关已关闭，取消尚未提交的签到。",
            );
    });
    this.event(
      input.enabled ? "scheduler.enabled" : "scheduler.disabled",
      input.enabled
        ? "已开启自动签到，执行范围为当前选定账号与贴吧。"
        : "已关闭自动签到，已提交动作继续只读核对。",
    );
    this.d.changed();
    return this.snapshot();
  }
  pauseTarget(input: z.infer<typeof tiebaAutocarePauseSchema>) {
    this.assertAlive();
    const state = this.revision(input.revision),
      target = this.store.target(input.targetId);
    if (!target) throw new AppError("TIEBA_TARGET_MISSING", "目标贴吧不存在。");
    if (!input.paused) {
      const current = this.account(target.accountId);
      if (current.uid !== target.uid)
        throw new AppError(
          "TIEBA_IDENTITY_CHANGED",
          "账号身份已变化，请重新同步。",
        );
      this.d.environments.assertStamp(ref(current.id), target.stamp);
      if (state.config.targetIds.includes(target.id)) {
        state.authorities = state.authorities.filter(
          (entry) => entry.targetId !== target.id,
        );
        state.authorities.push({
          targetId: target.id,
          uid: target.uid,
          stamp: target.stamp,
        });
      }
    }
    target.paused = input.paused;
    target.pauseReason = input.paused ? "已手动暂停此目标贴吧" : null;
    state.revision++;
    this.d.db.transaction(() => {
      this.store.saveTarget(target);
      this.store.saveState(state);
      if (input.paused)
        for (const task of this.store.tasks())
          if (task.targetId === target.id && task.status === "pending")
            this.finish(
              task,
              "cancelled",
              "目标贴吧已暂停，未提交任务已取消。",
            );
      if (state.enabled) this.plan(state);
    });
    this.event(
      "target.pause",
      input.paused ? `已暂停 ${target.name}吧` : `已恢复 ${target.name}吧`,
      undefined,
      target.accountId,
    );
    this.d.changed();
    return this.snapshot();
  }
  async syncForums(input: { accountId: string }) {
    this.assertAlive();
    const account = this.account(input.accountId),
      browser = this.browser();
    await this.queued(account.id, "同步贴吧关注列表", async () => {
      this.assertAlive();
      const checked = await this.d.accounts.verify(account.id);
      this.assertAlive();
      if (checked.status !== "connected" || !checked.uid)
        throw new AppError(
          "TIEBA_LOGIN_REQUIRED",
          checked.message || "请先核实贴吧登录身份。",
        );
      const current = this.account(account.id),
        stamp = this.d.environments.stamp(ref(account.id));
      const readings = await browser.listForums(current, checked.uid);
      this.assertAlive();
      this.d.environments.assertStamp(ref(current.id), stamp);
      if (this.account(account.id).uid !== checked.uid)
        throw new AppError(
          "TIEBA_IDENTITY_CHANGED",
          "同步期间账号身份已变化，请重新同步。",
        );
      const existing = this.store.targets();
      this.d.db.transaction(() => {
        for (const reading of readings) {
          const previous = existing.find(
            (target) =>
              target.accountId === current.id &&
              target.uid === checked.uid &&
              target.forumId === reading.forumId,
          );
          this.store.saveTarget({
            ...previous,
            ...readingFields(reading),
            id: previous?.id ?? id("tiebatarget"),
            accountId: current.id,
            uid: checked.uid!,
            source: "followed",
            paused: previous?.paused ?? false,
            pauseReason: previous?.pauseReason ?? null,
            stamp,
            syncedAt: this.now(),
            ...(previous?.followIntent
              ? {
                  followIntent: {
                    ...previous.followIntent,
                    status: "verified",
                    checkedAt: reading.checkedAt,
                    message:
                      "官网完整关注列表已核实此吧已关注，原关注请求不重复执行。",
                  },
                }
              : {}),
            followed: true,
          });
        }
        for (const target of existing.filter(
          (target) =>
            target.accountId === current.id &&
            target.uid === checked.uid &&
            target.source !== "observed" &&
            !readings.some((reading) => reading.forumId === target.forumId),
        )) {
          target.paused = true;
          target.pauseReason = "当前关注列表中已无此吧，请核实后重新同步";
          this.store.saveTarget(target);
        }
      });
      this.event(
        "forums.synced",
        `已同步 ${readings.length} 个关注吧，执行范围保持原选择。`,
        undefined,
        account.id,
      );
    });
    this.assertAlive();
    this.d.changed();
    return this.snapshot();
  }
  async observe(
    raw: z.input<typeof tiebaAutocareObserveSchema>,
    operationScope?: OperationScope,
  ) {
    this.assertAlive();
    operationScope?.assert();
    const input = tiebaAutocareObserveSchema.parse(raw);
    const account = this.account(input.accountId),
      browser = this.browser();
    if (!browser.resolveForum)
      throw new AppError(
        "TIEBA_OBSERVE_UNAVAILABLE",
        "当前后台尚未接入观察吧读取，请应用更新后重试。",
      );
    const observation: NonNullable<TiebaAutocareSnapshot["observation"]> = {
      accountId: account.id,
      succeeded: [],
      failed: [],
    };
    try {
      await this.queued(account.id, "添加只读观察吧", async () => {
        this.assertAlive();
        operationScope?.assert();
        const checked = await this.d.accounts.verify(account.id);
        this.assertAlive();
        if (checked.status !== "connected" || !checked.uid)
          throw new AppError(
            "TIEBA_LOGIN_REQUIRED",
            checked.message || "请先核实贴吧登录身份。",
          );
        const current = this.account(account.id),
          stamp = this.d.environments.stamp(ref(account.id));
        const assertScope = () => {
          this.assertAlive();
          operationScope?.assert();
          this.d.environments.assertStamp(ref(current.id), stamp);
          const refreshed = this.account(current.id);
          if (refreshed.uid !== checked.uid || refreshed.status !== "connected")
            throw new AppError(
              "TIEBA_IDENTITY_CHANGED",
              "读取期间账号身份或登录状态已变化，停止继续添加观察吧。",
            );
        };
        for (const name of input.forumNames) {
          try {
            assertScope();
            const reading = await browser.resolveForum!(
              current,
              checked.uid,
              name,
            );
            assertScope();
            const actualName = normalizeTiebaForumName(reading.name);
            const url = new URL(reading.url);
            if (
              typeof reading.forumId !== "string" ||
              !/^[1-9]\d{0,19}$/.test(reading.forumId) ||
              actualName.toLowerCase() !== name.toLowerCase() ||
              url.origin !== "https://tieba.baidu.com" ||
              url.username ||
              url.password ||
              url.port ||
              !/^\/f\/?$/u.test(url.pathname) ||
              url.searchParams.getAll("kw").length !== 1 ||
              normalizeTiebaForumName(
                url.searchParams.get("kw") ?? "",
              ).toLowerCase() !== actualName.toLowerCase() ||
              !Number.isFinite(Date.parse(reading.checkedAt)) ||
              Date.parse(reading.checkedAt) > this.time() + 5000 ||
              Date.parse(reading.checkedAt) < this.time() - 10 * 60000
            )
              throw new AppError(
                "TIEBA_OBSERVE_READING_INVALID",
                "官网返回的贴吧名称、ID、地址或读取时间不匹配，未保存此观察吧。",
              );
            // Resolve again from storage after the network await: a pause in another
            // window must never be undone by an earlier target snapshot.
            const previous = this.store
              .targets()
              .find(
                (target) =>
                  target.accountId === current.id &&
                  target.uid === checked.uid &&
                  target.forumId === reading.forumId,
              );
            const next: TargetRecord = {
              ...previous,
              ...readingFields(reading),
              name: actualName,
              id: previous?.id ?? id("tiebatarget"),
              accountId: current.id,
              uid: checked.uid,
              source: previous ? (previous.source ?? "followed") : "observed",
              paused: previous?.paused ?? false,
              pauseReason: previous?.pauseReason ?? null,
              stamp,
              syncedAt: this.now(),
            };
            const updated = {
              ...next,
              ...verifiedTiebaFollowState(
                next,
                reading,
                { uid: checked.uid, stamp },
                this.time(),
              ),
            };
            this.store.saveTarget(updated);
            observation.succeeded.push(name);
            this.event(
              "forum.observed",
              updated.source === "followed" && reading.followed === true
                ? `已保存「${actualName}吧」的官网资料并只读核实已关注，签到执行范围保持原选择。`
                : `已保存「${actualName}吧」的官网资料，本次未执行关注或签到，执行范围保持原选择。`,
              undefined,
              current.id,
            );
            this.d.changed();
          } catch (error) {
            if (this.disposed) throw error;
            operationScope?.failed?.(error);
            observation.failed.push({ name, message: safeMessage(error) });
            this.logs.record({
              event: "forum.observe_failed",
              level: "warning",
              accountId: current.id,
              message: `「${name}吧」读取未完成：${safeMessage(error)}；已成功保存的观察吧保留。`,
            });
            if (
              error instanceof AppError &&
              /IDENTITY|UID|ENVIRONMENT_|LOGIN|CAPTCHA|VERIFICATION|RATE_LIMITED|SERVICE_CLOSED/.test(
                error.code,
              )
            )
              throw error;
          }
        }
        assertScope();
      });
    } catch (error) {
      if (this.disposed) throw error;
      operationScope?.failed?.(error);
      if (
        !observation.failed.length &&
        observation.succeeded.length === input.forumNames.length
      ) {
        const last = observation.succeeded.pop()!;
        observation.failed.push({
          name: last,
          message: `已保留读取记录，但返回前状态发生变化，请重新核实：${safeMessage(error)}`,
        });
      }
      for (const name of input.forumNames)
        if (
          !observation.succeeded.includes(name) &&
          !observation.failed.some((failure) => failure.name === name)
        )
          observation.failed.push({
            name,
            message: `未执行：${safeMessage(error)}`,
          });
    }
    this.assertAlive();
    this.logs.record({
      event: "forums.observed",
      level: observation.failed.length ? "warning" : "info",
      accountId: account.id,
      message: `观察吧读取完成：成功${observation.succeeded.length}个，未完成${observation.failed.length}个；不会自动关注或安排签到。`,
    });
    this.d.changed();
    return { ...this.snapshot(), observation };
  }
  async add(raw: z.input<typeof tiebaAutocareAddSchema>) {
    this.assertAlive();
    const input = tiebaAutocareAddSchema.parse(raw);
    this.revision(input.revision);
    const account = this.account(input.accountId);
    if (this.adding.has(account.id))
      throw new AppError(
        "TIEBA_ADD_BUSY",
        "此账号已有添加任务，请等待逐项结果。",
      );
    const addition: NonNullable<TiebaAutocareSnapshot["addition"]> = {
      accountId: account.id,
      items: [],
    };
    let uid: string | undefined,
      stamp: EnvironmentStamp | undefined,
      terminal: unknown;
    const fatal = (error: unknown) =>
      !(error instanceof AppError) ||
      /CONFIG_CHANGED|IDENTITY|UID|ENVIRONMENT|LOGIN|ACCOUNT_NOT_FOUND|CAPTCHA|VERIFICATION|RATE_LIMITED|SERVICE_CLOSED|FOLLOW_PENDING_BLOCK/.test(
        error.code,
      );
    const scope: OperationScope = {
      assert: () => {
        this.assertAlive();
        this.revision(input.revision);
        const current = this.account(account.id);
        if (
          !uid ||
          !stamp ||
          current.uid !== uid ||
          current.status !== "connected" ||
          current.unverified
        )
          throw new AppError(
            "TIEBA_ADD_IDENTITY_CHANGED",
            "添加期间账号身份或登录状态已变化，停止剩余贴吧。",
          );
        this.d.environments.assertStamp(ref(account.id), stamp);
      },
      failed: (error) => {
        if (fatal(error)) terminal = error;
      },
    };
    this.adding.add(account.id);
    this.d.changed();
    try {
      await this.queued(account.id, "核实添加贴吧账号", async () => {
        this.assertAlive();
        this.revision(input.revision);
        const checked = await this.d.accounts.verify(account.id);
        this.assertAlive();
        if (
          checked.status !== "connected" ||
          !checked.uid ||
          (account.uid && checked.uid !== account.uid)
        )
          throw new AppError(
            "TIEBA_LOGIN_REQUIRED",
            checked.message || "请先核实原贴吧账号身份。",
          );
        uid = checked.uid;
        stamp = this.d.environments.stamp(ref(account.id));
        scope.assert();
      });
      for (const name of input.forumNames) {
        let targetId: string | undefined,
          recorded = false;
        try {
          scope.assert();
          terminal = undefined;
          const observed = await this.observe(
            { accountId: account.id, forumNames: [name] },
            scope,
          );
          const target = this.store
            .targets()
            .find(
              (target) =>
                target.accountId === account.id &&
                target.uid === uid &&
                normalizeTiebaForumName(target.name).toLowerCase() ===
                  name.toLowerCase(),
            );
          targetId = target?.id;
          if (terminal) throw terminal;
          scope.assert();
          const failure = observed.observation?.failed.find(
            (item) => item.name === name,
          );
          if (failure || !target)
            throw new AppError(
              "TIEBA_ADD_OBSERVE_FAILED",
              failure?.message || "未取得此贴吧的准确官网资料，未执行关注。",
            );
          const result = await this.follow(
            { targetId: target.id, revision: input.revision, confirmed: true },
            scope,
          );
          const feedback = result.followResult;
          addition.items.push({
            name,
            targetId: target.id,
            status: feedback?.status ?? "failed",
            message: feedback?.message || "未取得可核对的关注结果。",
          });
          recorded = true;
          if (feedback?.status === "uncertain") {
            terminal = new AppError(
              "TIEBA_ADD_FOLLOW_UNCERTAIN",
              "前项关注结果待核对，尚未执行",
            );
            break;
          }
          if (terminal) throw terminal;
          scope.assert();
        } catch (error) {
          if (this.disposed) throw error;
          if (!recorded) {
            const intent = targetId
              ? this.store.target(targetId)?.followIntent
              : undefined;
            addition.items.push({
              name,
              ...(targetId ? { targetId } : {}),
              status:
                intent && ["submitting", "uncertain"].includes(intent.status)
                  ? "uncertain"
                  : "failed",
              message: safeMessage(error),
            });
          }
          if (fatal(error) || terminal) {
            terminal = error;
            break;
          }
        }
      }
    } catch (error) {
      if (this.disposed) throw error;
      terminal = error;
    } finally {
      this.adding.delete(account.id);
      if (!this.disposed) this.d.changed();
    }
    this.assertAlive();
    for (const name of input.forumNames)
      if (!addition.items.some((item) => item.name === name))
        addition.items.push({
          name,
          status: "failed",
          message:
            terminal instanceof AppError &&
            terminal.code === "TIEBA_ADD_FOLLOW_UNCERTAIN"
              ? terminal.message
              : `未执行：${terminal ? safeMessage(terminal) : "前项未完成，原有结果保留。"}`,
        });
    this.logs.record({
      event: "forums.added",
      level: addition.items.every((item) => item.status === "followed")
        ? "info"
        : "warning",
      accountId: account.id,
      message: `添加贴吧完成：已核实${addition.items.filter((item) => item.status === "followed").length}个，待核对${addition.items.filter((item) => item.status === "uncertain").length}个，未完成${addition.items.filter((item) => item.status === "failed").length}个；签到执行范围保持原选择。`,
    });
    return { ...this.snapshot(), addition };
  }
  async findForums(
    raw: z.input<typeof tiebaFindForumsSchema>,
  ): Promise<TiebaForumDiscoveryResult> {
    this.assertAlive();
    const input = tiebaFindForumsSchema.parse(raw),
      account = this.account(input.accountId),
      browser = this.browser();
    if (!browser.findForums)
      throw new AppError(
        "TIEBA_FIND_UNAVAILABLE",
        "当前后台尚未接入贴吧查找，请应用更新后重试。",
      );
    return this.queued(account.id, `查找贴吧 · ${input.keyword}`, async () => {
      this.assertAlive();
      const checked = await this.d.accounts.verify(account.id);
      this.assertAlive();
      if (
        checked.status !== "connected" ||
        !checked.uid ||
        (account.uid && checked.uid !== account.uid)
      )
        throw new AppError(
          "TIEBA_LOGIN_REQUIRED",
          checked.message || "请先核实贴吧账号身份。",
        );
      const stamp = this.d.environments.stamp(ref(account.id));
      const guard = () => {
        this.assertAlive();
        const current = this.account(account.id);
        if (
          current.uid !== checked.uid ||
          current.status !== "connected" ||
          current.unverified
        )
          throw new AppError(
            "TIEBA_FIND_IDENTITY_CHANGED",
            "查找期间账号身份已变化，未返回其他账号的候选。",
          );
        this.d.environments.assertStamp(ref(account.id), stamp);
      };
      guard();
      const result = await browser.findForums!(
        checked,
        checked.uid,
        input.keyword,
      );
      guard();
      const fresh = (at: string) =>
        Number.isFinite(Date.parse(at)) &&
        Date.parse(at) <= this.time() + 5000 &&
        Date.parse(at) >= this.time() - 10 * 60000;
      if (
        result.accountId !== account.id ||
        result.keyword !== input.keyword ||
        !fresh(result.checkedAt) ||
        result.items.length > 8
      )
        throw new AppError(
          "TIEBA_FIND_RESULT",
          "官网查找结果的账号、查找词、数量或读取时间不匹配。",
        );
      for (const item of result.items) {
        const name = normalizeTiebaForumName(item.name),
          urlName = decodeTiebaForumUrlName(item.url);
        if (
          !urlName ||
          normalizeTiebaForumName(urlName).toLowerCase() !==
            name.toLowerCase() ||
          (item.forumId !== null && !/^[1-9]\d{0,19}$/.test(item.forumId)) ||
          !fresh(item.checkedAt) ||
          [item.memberCount, item.postCount, item.threadCount].some(
            (value) =>
              value !== null && (!Number.isSafeInteger(value) || value < 0),
          ) ||
          !Number.isInteger(item.sampledThreads) ||
          item.sampledThreads < 0 ||
          item.sampledThreads > 30 ||
          !Number.isInteger(item.zeroReplyThreads) ||
          item.zeroReplyThreads < 0 ||
          item.zeroReplyThreads > item.sampledThreads
        )
          throw new AppError(
            "TIEBA_FIND_RESULT",
            "官网候选的名称、地址、读数或主题样本无法核实。",
          );
      }
      this.logs.record({
        event: "forums.found",
        level: "info",
        accountId: account.id,
        message: `已只读查找「${input.keyword}」，返回${result.items.length}个官网候选；尚未添加或关注。`,
      });
      return result;
    });
  }
  async follow(
    raw: z.input<typeof tiebaAutocareFollowSchema>,
    operationScope?: OperationScope,
  ) {
    this.assertAlive();
    operationScope?.assert();
    const input = tiebaAutocareFollowSchema.parse(raw);
    this.revision(input.revision);
    const original = this.store.target(input.targetId);
    if (!original)
      throw new AppError(
        "TIEBA_TARGET_MISSING",
        "目标贴吧已不存在，请重新添加观察吧。",
      );
    if (this.following.has(original.id))
      throw new AppError(
        "TIEBA_FOLLOW_BUSY",
        "此贴吧关注或核对正在进行，请等待结果。",
      );
    const account = this.account(original.accountId),
      browser = this.browser();
    const followResult: NonNullable<TiebaAutocareSnapshot["followResult"]> = {
      targetId: original.id,
      status: "failed",
      message: "本次关注未完成。",
    };
    this.following.add(original.id);
    try {
      await this.queued(
        account.id,
        `关注或核对 · ${original.name}吧`,
        async () => {
          this.assertAlive();
          operationScope?.assert();
          this.revision(input.revision);
          const checked = await this.d.accounts.verify(account.id);
          this.assertAlive();
          if (checked.status !== "connected" || checked.uid !== original.uid)
            throw new AppError(
              "TIEBA_IDENTITY_CHANGED",
              "请先核实此观察吧原账号的登录身份，未关注其他账号。",
            );
          const stamp = this.d.environments.stamp(ref(account.id));
          const scope = (writing = false) => {
            this.assertAlive();
            operationScope?.assert();
            this.revision(input.revision);
            const current = this.store.target(original.id),
              currentAccount = this.account(account.id);
            if (
              !current ||
              current.uid !== original.uid ||
              current.accountId !== original.accountId ||
              current.forumId !== original.forumId ||
              current.name !== original.name ||
              currentAccount.uid !== original.uid ||
              currentAccount.status !== "connected"
            )
              throw new AppError(
                "TIEBA_FOLLOW_SCOPE_CHANGED",
                "原账号或目标贴吧已变化，停止本次关注。",
              );
            if (writing && current.paused)
              throw new AppError(
                "TIEBA_TARGET_PAUSED",
                current.pauseReason || "此贴吧已暂停，未执行关注。",
              );
            if (
              writing &&
              tiebaFollowWriteState(this.d.db, original.uid, original.id)
                .uncertain
            )
              throw new AppError(
                "TIEBA_FOLLOW_PENDING_BLOCK",
                "该账号仍有其他关注结果待核对，请先核对原关注，尚未执行新的关注。",
              );
            this.d.environments.assertStamp(ref(account.id), stamp);
            return current;
          };
          const validate = (
            reading: TiebaForumReading,
            at = reading.checkedAt,
          ) => {
            const url = new URL(reading.url),
              name = normalizeTiebaForumName(reading.name);
            if (
              reading.forumId !== original.forumId ||
              name.toLowerCase() !== original.name.toLowerCase() ||
              url.origin !== "https://tieba.baidu.com" ||
              url.username ||
              url.password ||
              url.port ||
              !/^\/f\/?$/u.test(url.pathname) ||
              url.searchParams.getAll("kw").length !== 1 ||
              normalizeTiebaForumName(
                url.searchParams.get("kw") ?? "",
              ).toLowerCase() !== name.toLowerCase() ||
              [reading.checkedAt, at].some(
                (value) =>
                  !Number.isFinite(Date.parse(value)) ||
                  Date.parse(value) > this.time() + 5000 ||
                  Date.parse(value) < this.time() - 10 * 60000,
              )
            )
              throw new AppError(
                "TIEBA_FOLLOW_READING",
                "官网返回的目标、地址或关注核对时间不匹配，原记录保留。",
              );
          };
          const complete = (
            reading: TiebaForumReading,
            at: string,
            message: string,
          ) => {
            validate(reading, at);
            const current = scope();
            if (
              current.followIntent &&
              Date.parse(at) < Date.parse(current.followIntent.submittedAt)
            )
              throw new AppError(
                "TIEBA_FOLLOW_READING",
                "关注读数早于原请求，保留未知，不重复关注。",
              );
            const verified = reading.followed === true;
            this.store.saveTarget({
              ...current,
              ...readingFields(reading),
              stamp,
              syncedAt: this.now(),
              source: verified ? "followed" : current.source,
              ...(current.followIntent
                ? {
                    followIntent: {
                      ...current.followIntent,
                      status: verified ? "verified" : "uncertain",
                      checkedAt: at,
                      message,
                    },
                  }
                : {}),
            });
            followResult.status = verified ? "followed" : "uncertain";
            followResult.message = message;
          };
          let current = scope();
          const reading = await browser.readForum(
            checked,
            original.uid,
            current,
          );
          validate(reading);
          current = scope();
          this.store.saveTarget({
            ...current,
            ...readingFields(reading),
            stamp,
            syncedAt: this.now(),
          });
          if (reading.followed === true) {
            complete(
              reading,
              reading.checkedAt,
              "官网已核实此账号已关注，已加入关注目标；签到范围保持原选择。",
            );
            return;
          }
          if (
            current.followIntent &&
            ["submitting", "uncertain"].includes(current.followIntent.status)
          ) {
            complete(
              reading,
              reading.checkedAt,
              "尚未核实原关注结果，保留未知；本次仅只读核对，不会再次点击关注。",
            );
            return;
          }
          if (reading.followed !== false)
            throw new AppError(
              "TIEBA_FOLLOW_UNRECOGNIZED",
              "官网未能明确核实当前账号的关注关系，未点击关注。",
            );
          if (!browser.followForum)
            throw new AppError(
              "TIEBA_FOLLOW_UNAVAILABLE",
              "当前后台尚未接入官网关注，请应用更新后重试。",
            );
          scope(true);
          const receipt = await browser.followForum(
            checked,
            original.uid,
            current,
            async () => {
              const target = scope(true);
              if (
                target.followIntent &&
                ["submitting", "uncertain"].includes(target.followIntent.status)
              )
                throw new AppError(
                  "TIEBA_FOLLOW_ALREADY_SUBMITTED",
                  "已有关注检查点，本次只能只读核对。",
                );
              this.store.saveTarget({
                ...target,
                followIntent: {
                  status: "submitting",
                  submittedAt: this.now(),
                  checkedAt: null,
                  message: "已保存关注检查点，等待官网关系核实，不会重复关注。",
                },
              });
              this.event(
                "forum.follow_submitting",
                `已记录「${target.name}吧」关注请求，未安排签到。`,
                undefined,
                account.id,
              );
              this.d.changed();
            },
          );
          scope();
          validate(receipt.reading, receipt.checkedAt);
          if (
            receipt.uid !== original.uid ||
            (receipt.status === "followed" && receipt.reading.followed !== true)
          )
            throw new AppError(
              "TIEBA_FOLLOW_READING",
              "官网关注回执的身份或关系不匹配，保留原记录。",
            );
          complete(
            {
              ...receipt.reading,
              followed:
                receipt.status === "followed" &&
                receipt.reading.followed === true
                  ? true
                  : receipt.reading.followed === false
                    ? false
                    : null,
            },
            receipt.checkedAt,
            receipt.status === "followed"
              ? "官网已核实关注成功，已加入关注目标；不会自动勾选或提交签到。"
              : receipt.message || "关注结果待核对，不会再次点击关注。",
          );
        },
      );
    } catch (error) {
      if (this.disposed) throw error;
      operationScope?.failed?.(error);
      const current = this.store.target(original.id),
        message = safeMessage(error);
      if (
        current?.followIntent &&
        ["submitting", "uncertain"].includes(current.followIntent.status)
      ) {
        current.followIntent = {
          ...current.followIntent,
          status: "uncertain",
          message: `${message}；仅可只读核对，不重复关注。`,
        };
        this.store.saveTarget(current);
        followResult.status = "uncertain";
        followResult.message = current.followIntent.message;
      } else {
        followResult.status = "failed";
        followResult.message = message;
      }
    } finally {
      this.following.delete(original.id);
    }
    this.assertAlive();
    this.logs.record({
      event: "forum.follow_result",
      level: followResult.status === "followed" ? "info" : "warning",
      accountId: account.id,
      message: `「${original.name}吧」：${followResult.message}`,
    });
    this.d.changed();
    return { ...this.snapshot(), followResult };
  }
  private plan(state = this.store.state()) {
    if (!state.enabled || this.disposed) return;
    const day = tiebaDay(this.time());
    if (!state.run || state.run.day !== day) {
      state.run = {
        id: id("tiebarun"),
        day,
        startedAt: this.now(),
        deadlineAt: new Date(this.time() + runDuration).toISOString(),
        status: "running",
      };
    } else if (Date.parse(state.run.deadlineAt) > this.time())
      state.run.status = "running";
    else state.run.status = "ended";
    this.store.saveState(state);
    if (state.run.status !== "running") return;
    const tasks = this.store.tasks();
    let slot = Math.max(
      this.time(),
      ...tasks
        .filter((task) => task.submittedAt)
        .map((task) => Date.parse(task.submittedAt!) + taskGap),
    );
    for (const targetId of state.config.targetIds) {
      const target = this.store.target(targetId);
      if (!target || target.paused || target.source === "observed") continue;
      const authority = state.authorities.find(
        (entry) => entry.targetId === target.id,
      );
      if (!authority || authority.uid !== target.uid) continue;
      const previous = tasks.find(
        (task) =>
          task.uid === target.uid &&
          task.forumId === target.forumId &&
          task.day === day,
      );
      if (previous && !["pending", "cancelled"].includes(previous.status))
        continue;
      if (previous?.submittedAt) continue;
      const outOfWindow = slot >= Date.parse(state.run.deadlineAt);
      const task: TaskRecord = previous
        ? {
            ...previous,
            status: outOfWindow ? "expired" : "pending",
            configRevision: state.revision,
            configSnapshot: structuredClone(state.config),
            stamp: authority.stamp,
            plannedAt: new Date(
              Math.max(slot, Date.parse(previous.plannedAt)),
            ).toISOString(),
            updatedAt: this.now(),
            message: outOfWindow
              ? "本轮没有剩余排期时段，未提交签到，不集中补跑。"
              : "等待原批次中的下一个可用时段",
          }
        : {
            id: id("tiebatask"),
            targetId: target.id,
            accountId: target.accountId,
            uid: target.uid,
            forumId: target.forumId,
            forumName: target.name,
            action: "checkin",
            day,
            status: outOfWindow ? "expired" : "pending",
            plannedAt: new Date(slot).toISOString(),
            deadlineAt: state.run.deadlineAt,
            startedAt: null,
            submittedAt: null,
            checkedAt: null,
            message: outOfWindow
              ? "本轮没有剩余排期时段，未提交签到，不集中补跑。"
              : "等待自动签到",
            configRevision: state.revision,
            configSnapshot: structuredClone(state.config),
            stamp: authority.stamp,
            createdAt: this.now(),
            updatedAt: this.now(),
          };
      this.store.saveTask(task);
      slot = Date.parse(task.plannedAt) + taskGap;
    }
  }
  private cancelUnselected(state: AutocareState) {
    for (const task of this.store.tasks())
      if (
        task.status === "pending" &&
        !state.config.targetIds.includes(task.targetId)
      )
        this.finish(task, "cancelled", "此贴吧已移出执行范围。");
  }
  private expired(task: TaskRecord) {
    return (
      task.day !== tiebaDay(this.time()) ||
      Date.parse(task.deadlineAt) <= this.time()
    );
  }
  private deferForSubmissionGap(task: TaskRecord) {
    const reply = this.d.db.get<{ submitted_at: string }>(
      "SELECT submitted_at FROM (SELECT submitted_at FROM tieba_reply_drafts UNION ALL SELECT submitted_at FROM tieba_topic_drafts) WHERE submitted_at IS NOT NULL ORDER BY submitted_at DESC LIMIT 1",
    );
    const next = Math.max(
      0,
      reply ? Date.parse(reply.submitted_at) + taskGap : 0,
      Date.parse(
        tiebaPublishingWriteState(this.d.db, task.uid).lastMutationAt ?? "",
      ) + taskGap || 0,
      Date.parse(
        tiebaFollowWriteState(this.d.db, task.uid).lastMutationAt ?? "",
      ) + taskGap || 0,
      ...this.store
        .tasks()
        .filter((other) => other.id !== task.id && other.submittedAt)
        .map((other) => Date.parse(other.submittedAt!) + taskGap),
    );
    if (next <= this.time()) return false;
    task.plannedAt = new Date(next).toISOString();
    const outside =
      next >= Date.parse(task.deadlineAt) || tiebaDay(next) !== task.day;
    this.finish(
      task,
      outside ? "expired" : "pending",
      outside
        ? "提交间隔已超出原批次或业务日，保留原任务，不补跑。"
        : "等待真实提交记录要求的60秒间隔，原任务已顺延。",
    );
    return true;
  }
  private expirePending() {
    for (const task of this.store.tasks())
      if (task.status === "pending" && this.expired(task))
        this.finish(
          task,
          "expired",
          "已超过原批次或业务日，保留任务记录，不补跑。",
        );
    const state = this.store.state();
    if (
      state.run?.status === "running" &&
      Date.parse(state.run.deadlineAt) <= this.time()
    ) {
      state.run.status = "ended";
      this.store.saveState(state);
    }
  }
  private assertAllowed(task: TaskRecord) {
    this.assertAlive();
    const state = this.store.state(),
      target = this.store.target(task.targetId);
    if (target?.source === "observed")
      throw new AppError(
        "TIEBA_OBSERVED_NOT_FOLLOWED",
        "观察吧未取得关注列表证明，未执行签到。",
      );
    if (
      this.disposed ||
      !state.enabled ||
      !state.config.targetIds.includes(task.targetId) ||
      target?.paused
    )
      throw new AppError(
        "TIEBA_STOPPED",
        "任务已停止或目标已暂停，未进行新的签到提交。",
      );
    if (this.expired(task))
      throw new AppError(
        "TIEBA_BATCH_EXPIRED",
        "已超过原批次或业务日，未进行签到提交。",
      );
    if (
      task.configRevision !== state.revision ||
      !task.configSnapshot.targetIds.includes(task.targetId)
    )
      throw new AppError(
        "TIEBA_CONFIG_CHANGED",
        "设置在执行期间发生变化，未进行签到提交。",
      );
    const account = this.account(task.accountId),
      authority = state.authorities.find(
        (entry) => entry.targetId === task.targetId,
      );
    if (
      !target ||
      account.uid !== task.uid ||
      !authority ||
      authority.uid !== task.uid
    )
      throw new AppError(
        "TIEBA_IDENTITY_CHANGED",
        "账号身份或执行范围已变化，请核实后重新保存设置。",
      );
    this.d.environments.assertStamp(ref(account.id), task.stamp);
    // Queued work can acquire a pending/unknown write after tick selected this task.
    // Recheck at every execution boundary, including the durable check-in checkpoint.
    if (
      tiebaPublishingWriteState(this.d.db, task.uid).uncertain ||
      tiebaFollowWriteState(this.d.db, task.uid).uncertain ||
      this.d.db.get(
        "SELECT id FROM tieba_reply_drafts WHERE status IN ('uncertain','submitting') AND (uid=? OR json_extract(data,'$.accountId')=?) LIMIT 1",
        task.uid,
        task.accountId,
      ) ||
      this.d.db.get(
        "SELECT id FROM tieba_topic_drafts WHERE status IN ('uncertain','submitting','pending_review') AND (uid=? OR json_extract(data,'$.accountId')=?) LIMIT 1",
        task.uid,
        task.accountId,
      )
    )
      throw new AppError(
        "TIEBA_WRITE_UNCERTAIN_BLOCK",
        "该账号仍有回复或主题正在提交、结果未知或待审核，请先核对原记录，未执行新的签到。",
      );
    return { account, target };
  }
  private updateReading(target: TargetRecord, reading: TiebaForumReading) {
    this.assertAlive();
    if (!Number.isFinite(Date.parse(reading.checkedAt)))
      throw new AppError(
        "TIEBA_READING_INVALID",
        "官网状态缺少有效读取时间，未更新目标状态。",
      );
    if (reading.forumId !== target.forumId)
      throw new AppError(
        "TIEBA_TARGET_CHANGED",
        "官网返回了其他贴吧的状态，已停止核对。",
      );
    const current = this.store.target(target.id);
    if (!current || current.uid !== target.uid)
      throw new AppError(
        "TIEBA_TARGET_CHANGED",
        "目标贴吧已变化，未覆盖其最新状态。",
      );
    // A response must never undo a pause/configuration change made while it was in flight.
    this.store.saveTarget({
      ...current,
      ...readingFields(reading),
      ...verifiedTiebaFollowState(
        current,
        reading,
        { uid: target.uid, stamp: target.stamp },
        this.time(),
      ),
    });
  }
  private finish(
    task: TaskRecord,
    status: TaskRecord["status"],
    message: string,
  ) {
    this.assertAlive();
    task.status = status;
    task.message = message;
    task.updatedAt = this.now();
    this.store.saveTask(task);
  }
  private event(
    event: string,
    message: string,
    task?: TaskRecord,
    accountId?: string,
  ) {
    if (this.disposed) return;
    this.logs.record({
      event,
      message,
      level:
        task?.status === "failed"
          ? "error"
          : task?.status === "uncertain"
            ? "warning"
            : "info",
      accountId: task?.accountId ?? accountId,
      taskId: task?.id,
    });
  }
  private async queued<T>(
    accountId: string,
    label: string,
    action: () => Promise<T>,
  ) {
    this.assertAlive();
    const controller = new AbortController();
    this.controllers.add(controller);
    this.operations++;
    this.d.changed();
    try {
      return await this.d.queue.schedule(
        [ref(accountId)],
        label,
        action,
        controller.signal,
      );
    } finally {
      this.controllers.delete(controller);
      this.operations--;
      if (!this.disposed) this.d.changed();
    }
  }
  async tick() {
    if (this.working || this.disposed) return;
    this.working = true;
    try {
      this.expirePending();
      const state = this.store.state();
      if (state.enabled && state.run?.day !== tiebaDay(this.time()))
        this.plan(state);
      const allTasks = this.store.tasks();
      const task = allTasks
        .filter(
          (task) =>
            task.status === "pending" &&
            Date.parse(task.plannedAt) <= this.time() &&
            !allTasks.some(
              (other) =>
                other.accountId === task.accountId &&
                other.day === task.day &&
                ["uncertain", "submitting"].includes(other.status),
            ) &&
            !tiebaPublishingWriteState(this.d.db, task.uid).uncertain &&
            !tiebaFollowWriteState(this.d.db, task.uid).uncertain &&
            !this.d.db.get(
              "SELECT id FROM tieba_reply_drafts WHERE status IN ('uncertain','submitting') AND json_extract(data,'$.accountId')=? LIMIT 1",
              task.accountId,
            ) &&
            !this.d.db.get(
              "SELECT id FROM tieba_topic_drafts WHERE status IN ('uncertain','submitting','pending_review') AND json_extract(data,'$.accountId')=? LIMIT 1",
              task.accountId,
            ),
        )
        .sort((a, b) => a.plannedAt.localeCompare(b.plannedAt))[0];
      if (!task || !state.enabled) return;
      if (this.deferForSubmissionGap(task)) return;
      task.status = "running";
      task.startedAt = this.now();
      task.updatedAt = this.now();
      if (!this.store.claim(task)) return;
      await this.execute(task);
    } catch (error) {
      if (!this.disposed)
        this.logs.record({
          event: "scheduler.error",
          message: safeMessage(error),
          level: "error",
        });
    } finally {
      this.working = false;
      if (!this.disposed) this.d.changed();
    }
  }
  private async execute(task: TaskRecord) {
    try {
      this.assertAllowed(task);
      await this.queued(
        task.accountId,
        `贴吧签到 · ${task.forumName}`,
        async () => {
          const { account, target } = this.assertAllowed(task);
          const checked = await this.d.accounts.verify(account.id);
          this.assertAlive();
          if (checked.status !== "connected" || checked.uid !== task.uid)
            throw new AppError(
              "TIEBA_LOGIN_REQUIRED",
              checked.message || "贴吧账号身份未核实。",
            );
          this.assertAllowed(task);
          const browser = this.browser(),
            reading = await browser.readForum(account, task.uid, target);
          this.assertAlive();
          this.updateReading(target, reading);
          task.checkedAt = reading.checkedAt;
          if (this.expired(task) || !this.matchesTaskDay(task, reading))
            throw new AppError(
              "TIEBA_BATCH_EXPIRED",
              "读取完成时原批次或业务日已结束，未提交签到。",
            );
          if (reading.signed === true) {
            this.finish(
              task,
              "already_signed",
              "官网已确认今日签过，跳过重复签到。",
            );
            return;
          }
          if (reading.signed !== false || reading.canSign !== true)
            throw new AppError(
              "TIEBA_SIGN_UNAVAILABLE",
              reading.message || "官网未提供可核实的签到入口，未进行提交。",
            );
          const result = await browser.checkIn(
            account,
            task.uid,
            target,
            async () => {
              this.assertAllowed(task);
              if (this.deferForSubmissionGap(task))
                throw new AppError("TIEBA_DEFERRED", task.message);
              if (task.submittedAt)
                throw new AppError(
                  "TIEBA_ALREADY_SUBMITTED",
                  "此任务已有提交记录，只能核对原结果。",
                );
              // Durable boundary precedes the website click. Any subsequent ambiguity is read-only recovery.
              task.submittedAt = this.now();
              this.finish(
                task,
                "submitting",
                "已记录签到提交，正在核对官网结果。",
              );
              this.event("task.submitting", task.message, task);
              this.d.changed();
            },
          );
          this.assertAlive();
          this.updateReading(target, result);
          task.checkedAt = result.checkedAt;
          if (!this.matchesTaskDay(task, result))
            this.finish(
              task,
              task.submittedAt ? "uncertain" : "expired",
              "结果返回时业务日已变化，今日状态不能证明原签到，保留原记录。",
            );
          else if (result.signed === true)
            this.finish(
              task,
              task.submittedAt ? "verified" : "already_signed",
              task.submittedAt
                ? "官网已确认今日签到成功。"
                : "官网已确认今日签过，未重复提交。",
            );
          else
            this.finish(
              task,
              task.submittedAt ? "uncertain" : "failed",
              result.message || "尚未核实签到结果，请只读核对原任务。",
            );
        },
      );
    } catch (error) {
      if (this.disposed) return;
      if (error instanceof AppError && error.code === "TIEBA_DEFERRED") {
        this.event(
          `task.${task.status}`,
          `${task.forumName}吧：${task.message}`,
          task,
        );
        return;
      }
      const message = safeMessage(error);
      const stopped =
        this.disposed ||
        !this.store.state().enabled ||
        this.store.target(task.targetId)?.paused;
      this.finish(
        task,
        task.submittedAt
          ? "uncertain"
          : stopped ||
              (error instanceof AppError &&
                ["TIEBA_STOPPED", "TIEBA_CONFIG_CHANGED"].includes(error.code))
            ? "cancelled"
            : this.expired(task)
              ? "expired"
              : "failed",
        message,
      );
      if (
        error instanceof AppError &&
        /LOGIN|IDENTITY|UID|ENVIRONMENT_CHANGED|CAPTCHA|VERIFICATION|RATE_LIMITED/.test(
          error.code,
        )
      ) {
        for (const target of this.store
          .targets()
          .filter((target) => target.accountId === task.accountId)) {
          target.paused = true;
          target.pauseReason = message;
          this.store.saveTarget(target);
        }
      }
    }
    if (this.disposed) return;
    this.event(
      `task.${task.status}`,
      `${task.forumName}吧：${task.message}`,
      task,
    );
    if (
      task.status === "cancelled" &&
      !this.disposed &&
      task.configRevision !== this.store.state().revision
    )
      this.plan();
  }
  async reconcile(input: { taskId: string }) {
    this.assertAlive();
    let task = this.store.task(input.taskId);
    if (!task || !["uncertain", "submitting"].includes(task.status))
      throw new AppError(
        "TIEBA_RECONCILE_REQUIRED",
        "此任务无需补核，补核仅查询原签到结果。",
      );
    if (task.day !== tiebaDay(this.time()))
      throw new AppError(
        "TIEBA_RECONCILE_PAST_DAY",
        "官网当前状态无法证明历史业务日的签到结果，原未知记录已保留，不会重放。",
      );
    const target = this.store.target(task.targetId),
      account = this.account(task.accountId);
    if (!target || account.uid !== task.uid)
      throw new AppError(
        "TIEBA_IDENTITY_CHANGED",
        "原账号身份已变化，无法核对原任务。",
      );
    await this.queued(
      account.id,
      `核对贴吧签到 · ${task.forumName}`,
      async () => {
        this.assertAlive();
        const fresh = this.store.task(input.taskId);
        if (!fresh || !["uncertain", "submitting"].includes(fresh.status))
          return;
        task = fresh;
        if (task.day !== tiebaDay(this.time()))
          throw new AppError(
            "TIEBA_RECONCILE_PAST_DAY",
            "排队期间已跨业务日，保留历史未知结果，不使用今日签到状态证明昨日。",
          );
        const checked = await this.d.accounts.verify(account.id);
        this.assertAlive();
        if (checked.status !== "connected" || checked.uid !== task.uid)
          throw new AppError(
            "TIEBA_LOGIN_REQUIRED",
            "请在原账号完成登录后核对。",
          );
        if (task.day !== tiebaDay(this.time()))
          throw new AppError(
            "TIEBA_RECONCILE_PAST_DAY",
            "核验身份期间已跨业务日，原未知结果已保留。",
          );
        const result = await this.browser().readForum(
          this.account(account.id),
          task.uid,
          target,
        );
        this.assertAlive();
        this.updateReading(target, result);
        task.checkedAt = result.checkedAt;
        const verified =
          this.matchesTaskDay(task, result) && result.signed === true;
        this.finish(
          task,
          verified ? "verified" : "uncertain",
          verified
            ? "官网补核确认今日已签到，原记录保留。"
            : !this.matchesTaskDay(task, result)
              ? "读取期间已跨业务日，今日状态不能证明原签到，继续保留未知结果。"
              : "官网尚未确认签到成功，继续保留未知结果，不会自动重签。",
        );
      },
    );
    this.assertAlive();
    this.event("task.reconciled", task.message, task);
    this.d.changed();
    return this.snapshot();
  }
  scheduler(enabled: boolean) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (enabled && !this.disposed) {
      this.timer = setInterval(() => {
        void this.tick();
      }, 10000);
      this.timer.unref();
    }
  }
  dispose() {
    this.scheduler(false);
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
  }
}

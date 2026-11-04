import { id, now, type Database } from "../database";
import { AppError, safeMessage } from "../errors";
import { RuntimeLog } from "../runtime-log";
import type { ZhihuParticipation } from "../zhihu-participation/service";
import {
  enabledAutocareJob,
  hasAutocareResearch,
  readNextAutocareContext,
  prepareAutocareAnswer,
  type AutocareParticipationHost,
} from "./participation";
import type { ZhihuOperations } from "../zhihu/service";
import type { PipixRequestBudget } from "../pipix/request-budget";
import type { PipixSources } from "../pipix/service";
import type { AiService } from "../ai";
import type { IntelligentOperations } from "../intelligent-operations/service";
import type { ZhihuContent } from "../../shared/zhihu";
import type { ContentSourceExport } from "../../shared/content-sources";
import type { PipixCandidate } from "../../shared/pipix";
import {
  autocareConfigSchema,
  autocareInteractionInput,
  autocareParticipationScope,
  autocareStateSchema,
  type AutocareState,
  type AutocareJob,
} from "../../shared/zhihu-autocare";
import {
  readAutocareState,
  autocareStateKey,
  fingerprint,
  contentFingerprint,
} from "./state";
import { nextAutocareCycle } from "./agenda";
import { autocareSlot } from "./scheduling";
import { generateAutocareArticle, checkAutocareArticle } from "./generation";
import { zhihuDay, zhihuCounts } from "../zhihu/policy";
import { readParticipationState } from "../zhihu-participation/state";
import { readSupplyDrafts } from "../content-supply/state";
function fail(message: string): never {
  throw new AppError("AUTOCARE_BLOCKED", message);
}
const normalize = (s: string) =>
  s.replace(/\s/g, "").replace(/参考来源：[\s\S]*$/, "");
export class ZhihuAutocare {
  readonly logs: RuntimeLog;
  private state: AutocareState;
  private working = false;
  private researchMessages = new Map<string, string>();
  private closed = false;
  private requestBudget?: PipixRequestBudget;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private d: {
      db: Database;
      dataPath: string;
      zhihu: ZhihuOperations;
      participation: ZhihuParticipation;
      pipix: PipixSources;
      ai: AiService;
      operations: IntelligentOperations;
      changed(): void;
    },
  ) {
    this.state = readAutocareState(d.db);
    this.logs = new RuntimeLog(d.db, d.dataPath, "zhihu-autocare");
    for (const j of this.state.jobs)
      if (["collecting", "generating"].includes(j.status)) {
        j.status = "attention";
        j.message = "上次准备过程已中断，保留来源和费用记录，不自动重新生成";
      }
    for (const r of this.state.research)
      if (r.status === "reading") {
        r.status = "failed";
        r.message = "读取因应用重启中断，不计为本人阅读回执";
      }
    this.replanMissed();
    if (this.state.enabled) this.planCycles(false);
    this.persist();
    d.zhihu.connectRuleAuthority({
      owns: (accountId) => this.owns(accountId),
      approved: (c, accountId) => this.approved(c, accountId),
      record: (taskId, event) => {
        const job = this.state.jobs.find((j) => j.taskId === taskId);
        if (job)
          this.event(event.event, event.message, job, "info", event.details);
      },
    });
    this.timer = setInterval(
      () =>
        void this.tick().catch((error) => {
          if (this.closed) return;
          this.state.enabled = false;
          this.cancelFuture();
          this.state.message = safeMessage(error);
          this.event("run.failed", this.state.message, undefined, "error");
          this.persist();
        }),
      10000,
    );
    this.timer.unref();
  }
  get isBusy() {
    return this.working;
  }
  owns(accountId: string) {
    return (
      !this.closed &&
      this.state.enabled &&
      this.state.config.accountIds.includes(accountId)
    );
  }
  private approved(c: ZhihuContent, accountId: string) {
    return (
      this.owns(accountId) &&
      c.accountId === accountId &&
      this.d.zhihu
        .snapshot()
        .accounts.some(
          (a) =>
            a.id === accountId && a.uid === this.state.identities[accountId],
        ) &&
      this.state.jobs.some(
        (j) =>
          enabledAutocareJob(this.state, j) &&
          j.accountId === accountId &&
          j.uid === this.state.identities[accountId] &&
          j.contentId === c.id &&
          ["ready", "queued"].includes(j.status) &&
          j.fingerprint === contentFingerprint(c) &&
          j.checks.length >= 4,
      )
    );
  }
  private persist() {
    if (!this.closed) {
      this.d.db.setSetting(
        autocareStateKey,
        autocareStateSchema.parse(this.state),
      );
      this.d.changed();
    }
  }
  private event(
    event: string,
    message: string,
    job?: AutocareJob,
    level: "info" | "warning" | "error" = "info",
    details: Record<string, unknown> = {},
  ) {
    if (this.closed) return;
    this.logs.record({
      event,
      message,
      level,
      accountId:
        job?.accountId ??
        (typeof details.accountId === "string" ? details.accountId : undefined),
      taskId: job?.id,
      details: {
        ...(job
          ? {
              sourceId: job.sourceId,
              contentId: job.contentId,
              scheduledAt: job.scheduledAt,
              taskId: job.taskId,
            }
          : {}),
        ...details,
      },
    });
  }
  snapshot() {
    const usage = this.d.pipix.requestPolicy();
    const accounts = this.d.zhihu.snapshot().accounts;
    const remaining = this.state.config.accountIds.filter((id) => {
      const progress = accounts.find((a) => a.id === id)?.plan.progress;
      return (
        !progress?.creator ||
        progress.level === null ||
        progress.level === undefined ||
        progress.level < this.state.config.targetLevel
      );
    });
    return {
      ...structuredClone(this.state),
      busy: this.working,
      accounts,
      participation: {
        candidates: this.d.participation
          .snapshot()
          .candidates.filter((c) =>
            this.state.config.accountIds.includes(c.accountId),
          ),
        activities: this.d.participation
          .snapshot()
          .activities.filter(
            (a) =>
              a.planId === autocareParticipationScope &&
              this.state.config.accountIds.includes(a.accountId),
          ),
      },
      modelName: this.d.ai.modelFor("copy"),
      generationCount: this.generationCount(),
      requestsRemaining: usage.remainingToday,
      requestsLimit: usage.policy.dailyRequests,
      listPagesPerRun: usage.policy.listPagesPerRun,
      needsAttention:
        this.state.enabled &&
        remaining.length > 0 &&
        remaining.every((id) => this.state.blockedAccountIds.includes(id)),
      globalAiBudgetMicros: this.d.db.setting<number | null>(
        "dailyAiBudgetMicros",
        null,
      ),
    };
  }
  private generationCount() {
    return this.state.jobs.filter(
      (j) => j.generatedAt && zhihuDay(j.generatedAt) === zhihuDay(Date.now()),
    ).length;
  }
  private guard(revision: number) {
    if (this.closed || !this.state.enabled || revision !== this.state.revision)
      fail("自动养号已关闭或设置变化，停止后续操作");
    if (
      (this.state.config.publish || this.state.config.answerRecommended) &&
      this.state.model !== this.d.ai.modelFor("copy")
    )
      fail("内容模型已变化，停止新的生成请求，请重新开启");
    if (
      (this.state.config.publish || this.state.config.answerRecommended) &&
      this.unknownCosts()
    )
      fail("存在生成费用待核实记录，未继续调用模型");
  }
  private message(accountId: string, message: string, blocked = false) {
    const changed =
      this.state.blockedAccountIds.includes(accountId) !== blocked;
    this.state.blockedAccountIds = this.state.blockedAccountIds.filter(
      (id) => id !== accountId,
    );
    if (blocked) this.state.blockedAccountIds.push(accountId);
    if (changed || this.state.accountMessages[accountId] !== message) {
      this.state.accountMessages[accountId] = message;
      this.event(
        "account.status",
        message,
        undefined,
        blocked ? "warning" : "info",
        { accountId },
      );
      this.persist();
    }
  }
  private competing() {
    const ids = this.state.config.accountIds;
    return this.d.operations
      .snapshot()
      .plans.filter(
        (p) =>
          p.active &&
          p.accounts.some((a) => ids.includes(a.accountId) && !a.paused),
      );
  }
  async toggle(enabled: boolean, revision: number) {
    if (revision !== this.state.revision) fail("设置已更新，请刷新后操作");
    if (enabled === this.state.enabled) return this.snapshot();
    if (!enabled) {
      this.state.enabled = false;
      this.requestBudget?.stop();
      this.state.revision++;
      this.state.message = this.working
        ? "正在收尾，停止新的采集、生成和提交"
        : "已关闭";
      this.cancelFuture();
      this.state.cycles = {};
      this.event("run.stopped", this.state.message);
      this.persist();
      return this.snapshot();
    }
    if (this.working) fail("正在收尾，请稍后开启");
    const cfg = this.state.config;
    if (
      !cfg.accountIds.length ||
      !(cfg.publish || cfg.answerRecommended || hasAutocareResearch(this.state))
    )
      fail("请选择账号和至少一项操作");
    if (cfg.publish || cfg.answerRecommended)
      this.d.ai.assertTextConfigured("copy");
    if ((cfg.publish || cfg.answerRecommended) && this.unknownCosts())
      fail("存在生成费用待核实记录，请先核对后开启");
    const snapshot = this.d.zhihu.snapshot();
    if (snapshot.busy || this.d.operations.isBusy)
      fail("原运营任务仍在执行，请完成后切换");
    const conflicts = this.competing();
    if (
      conflicts.some((p) =>
        p.accounts.some(
          (a) => !a.paused && !cfg.accountIds.includes(a.accountId),
        ),
      )
    )
      fail(
        "已有运营计划还包含未选择的账号，请先在原计划暂停对应账号，避免影响其他业务",
      );
    if (
      snapshot.running &&
      snapshot.accounts.some(
        (a) => a.plan.active && !cfg.accountIds.includes(a.id),
      )
    )
      fail("原调度还管理其他账号，请先停止旧调度后切换");
    for (const accountId of cfg.accountIds) {
      const a = snapshot.accounts.find((a) => a.id === accountId);
      if (!a || !a.uid || a.status !== "connected" || a.engine !== "bitbrowser")
        fail("所选账号需先登录并绑定比特窗口");
    }
    for (const p of conflicts) this.d.operations.activate(p.id, false);
    if (snapshot.running) this.d.zhihu.scheduler(false);
    for (const accountId of cfg.accountIds) {
      const p = this.d.zhihu.plan(accountId);
      if (p.active) this.d.zhihu.activate(accountId, false);
      this.d.zhihu.configure({
        accountId,
        targetLevel: cfg.targetLevel,
        dailyLimit: Math.min(cfg.dailyLimit, p.dailyLimit),
        weeklyLimit: Math.min(cfg.weeklyLimit, p.weeklyLimit),
        gapMinutes: Math.max(cfg.gapMinutes, p.gapMinutes),
      });
    }
    this.state.identities = Object.fromEntries(
      cfg.accountIds.map((accountId) => [
        accountId,
        snapshot.accounts.find((a) => a.id === accountId)!.uid!,
      ]),
    );
    for (const job of this.state.jobs) {
      if (
        cfg.accountIds.includes(job.accountId) &&
        job.uid !== this.state.identities[job.accountId] &&
        job.status === "ready"
      ) {
        job.status = "cancelled";
        job.message = "账号身份已变化，原稿保留给原身份，不自动改派";
        this.event("content.identity_changed", job.message, job, "warning");
      }
    }
    this.state.model = this.d.ai.modelFor("copy");
    this.state.enabled = true;
    for (const id of cfg.accountIds) delete this.state.researchStops[id];
    this.state.blockedAccountIds = [];
    this.state.accountMessages = {};
    this.state.revision++;
    this.state.message = "计划已保存，等待随机任务时间（无头运行）";
    this.planCycles(true);
    this.event(
      "run.started",
      "自动养号已开启：固定规则、AI生成、随机排期；未启用AI自主运营",
      undefined,
      "info",
      { config: cfg, model: this.state.model },
    );
    this.persist();
    return this.snapshot();
  }
  save(raw: unknown, revision: number) {
    if (revision !== this.state.revision) fail("设置已变化，请刷新后保存");
    if (this.working) fail("当前操作进行中，完成后再保存设置");
    const cfg = autocareConfigSchema.parse(raw);
    if (
      this.state.enabled &&
      JSON.stringify(cfg.accountIds) !==
        JSON.stringify(this.state.config.accountIds)
    )
      fail("更换账号前请先关闭总开关");
    this.cancelFuture();
    this.state.config = cfg;
    this.state.revision++;
    this.state.accountMessages = {};
    this.state.blockedAccountIds = [];
    this.state.nextCheckAt = null;
    if (this.state.enabled) {
      if (!(
        cfg.publish ||
        cfg.answerRecommended ||
        hasAutocareResearch(this.state)
      )) {
        this.state.enabled = false;
        this.state.message = "未选择操作，养号已关闭";
      } else
        for (const a of cfg.accountIds) {
          const p = this.d.zhihu.plan(a);
          this.d.zhihu.configure({
            accountId: a,
            targetLevel: cfg.targetLevel,
            dailyLimit: Math.min(cfg.dailyLimit, p.dailyLimit),
            weeklyLimit: Math.min(cfg.weeklyLimit, p.weeklyLimit),
            gapMinutes: Math.max(cfg.gapMinutes, p.gapMinutes),
          });
        }
    }
    if (this.state.enabled) this.planCycles(true);
    this.event("config.saved", "设置已保存，未提交任务按新设置重新安排");
    this.persist();
    return this.snapshot();
  }
  private replanMissed() {
    const tasks = this.d.zhihu.snapshot().tasks;
    for (const job of this.state.jobs) {
      if (job.status !== "queued" || !job.taskId) continue;
      const task = tasks.find((t) => t.id === job.taskId);
      if (
        !task ||
        task.status !== "queued" ||
        task.attemptedAt ||
        task.submittedAt ||
        Date.parse(task.scheduledAt) >= Date.now()
      )
        continue;
      this.d.zhihu.cancel(task.id);
      job.status = "ready";
      job.taskId = undefined;
      job.scheduledAt = undefined;
      job.message = "停机期间错过排期，原稿保留并重新分散到未来时段";
      job.updatedAt = now();
      this.event("publish.replanned", job.message, job, "info", {
        previousTaskId: task.id,
      });
    }
  }
  private cancelFuture(accountId?: string) {
    for (const j of this.state.jobs) {
      if (accountId && j.accountId !== accountId) continue;
      if (j.status === "queued" && j.taskId) {
        const t = this.d.zhihu.snapshot().tasks.find((t) => t.id === j.taskId);
        if (t?.status === "queued" && !t.attemptedAt) {
          this.d.zhihu.cancel(t.id);
          j.taskId = undefined;
          j.scheduledAt = undefined;
          j.status = "ready";
          j.message = "设置或开关变化，原稿保留等待重新安排";
        }
      }
    }
  }
  private sync() {
    const tasks = this.d.zhihu.snapshot().tasks;
    let changed = false;
    for (const j of this.state.jobs) {
      if (!j.taskId) {
        if (j.status === "ready" && j.contentId) {
          const content = this.d.zhihu
            .snapshot()
            .contents.find((c) => c.id === j.contentId);
          if (!content || contentFingerprint(content) !== j.fingerprint) {
            changed = true;
            j.status = "cancelled";
            j.message = "稿件已修改或移除，停止本模式自动发布，保留手动处理";
            this.event("content.changed", j.message, j, "warning");
          }
        }
        if (j.status === "attention" && !this.unknownCosts()) {
          changed = true;
          j.status = "skipped";
          j.message =
            "中断任务的费用记录已明确，此来源保留历史并跳过，未重新生成";
          this.event("source.interrupted", j.message, j, "warning");
        }
        continue;
      }
      const t = tasks.find((t) => t.id === j.taskId);
      if (!t) continue;
      if (t.status === "published" && j.status !== "published") {
        changed = true;
        j.status = "published";
        j.url = t.url;
        j.message = "官方已确认发布";
        j.updatedAt = now();
        this.event("publish.verified", j.message, j, "info", { url: t.url });
      } else if (t.status === "attention" && j.status !== "attention") {
        changed = true;
        j.status = "attention";
        j.message = t.message;
        this.event("publish.attention", t.message, j, "warning");
      } else if (
        t.status === "cancelled" &&
        ["queued", "attention"].includes(j.status)
      ) {
        changed = true;
        j.status =
          t.message === "自动养号已关闭，尚未提交，原稿保留" && !t.submittedAt
            ? "ready"
            : "cancelled";
        j.message = t.message;
        if (j.status === "ready") {
          j.taskId = undefined;
          j.scheduledAt = undefined;
        }
        j.updatedAt = now();
        this.event("publish.cancelled", t.message, j);
      } else if (
        t.status === "queued" &&
        (j.scheduledAt !== t.scheduledAt || j.status === "attention")
      ) {
        changed = true;
        j.status = "queued";
        j.scheduledAt = t.scheduledAt;
        this.event("publish.deferred", t.message, j);
      }
    }
    return changed;
  }
  private unknownCosts() {
    return !!this.d.db.get(
      "SELECT id FROM api_calls WHERE endpoint='openrouter' AND phase LIKE 'zhihu_autocare:%' AND status IN ('reserved','uncertain') LIMIT 1",
    );
  }
  private planCycle(
    accountId: string,
    snapshot = this.d.zhihu.snapshot(),
    after = Date.now(),
  ) {
    const at = nextAutocareCycle(this.state, snapshot, accountId, after);
    if (!at) {
      delete this.state.cycles[accountId];
      return;
    }
    const cycle = {
      id: id("carecycle"),
      at,
      uid: this.state.identities[accountId],
      revision: this.state.revision,
      targets:
        this.state.config.publish || this.state.config.answerRecommended
          ? ["创作活跃度", "内容优质分"]
          : ["内容选题准备"],
      kind:
        this.state.config.publish || this.state.config.answerRecommended
          ? ("prepare" as const)
          : ("research" as const),
    };
    this.state.cycles[accountId] = cycle;
    this.event(
      "cycle.planned",
      "已安排账号任务，到时才启用无头环境",
      undefined,
      "info",
      { accountId, ...cycle },
    );
  }
  private planCycles(reset: boolean) {
    if (reset) this.state.cycles = {};
    const snapshot = this.d.zhihu.snapshot();
    for (const accountId of this.state.config.accountIds) {
      const cycle = this.state.cycles[accountId];
      if (
        !cycle ||
        cycle.revision !== this.state.revision ||
        cycle.uid !== this.state.identities[accountId] ||
        Date.parse(cycle.at) < Date.now()
      )
        this.planCycle(accountId, snapshot);
    }
    this.state.nextCheckAt = null;
  }
  async tick() {
    if (this.closed || this.working) return;
    const synced = this.sync();
    if (!this.state.enabled) {
      if (synced) this.persist();
      return;
    }
    if (
      this.state.nextCheckAt &&
      Date.parse(this.state.nextCheckAt) > Date.now()
    )
      return;
    if (
      this.state.lastHeartbeatAt &&
      Date.now() - Date.parse(this.state.lastHeartbeatAt) > 5 * 60000
    ) {
      this.replanMissed();
      this.planCycles(false);
    }
    const day = zhihuDay(Date.now());
    if (
      Date.now() <
        Date.parse(`${day}T${this.state.config.windowStart}:00+08:00`) ||
      Date.now() >= Date.parse(`${day}T${this.state.config.windowEnd}:00+08:00`)
    ) {
      this.replanMissed();
      this.planCycles(false);
    }
    const local = this.d.zhihu.snapshot();
    for (const accountId of this.state.config.accountIds)
      if (!this.state.cycles[accountId]) this.planCycle(accountId, local);
    const due = this.state.config.accountIds
      .flatMap((accountId) => {
        const cycle = this.state.cycles[accountId];
        const publish = this.state.jobs
          .filter(
            (j) =>
              j.accountId === accountId &&
              j.status === "queued" &&
              enabledAutocareJob(this.state, j),
          )
          .map((j) => local.tasks.find((t) => t.id === j.taskId))
          .filter((t) => t?.status === "queued")
          .sort((a, b) => a!.scheduledAt.localeCompare(b!.scheduledAt))[0];
        const at = [cycle?.at, publish?.scheduledAt]
          .filter((v): v is string => !!v)
          .sort()[0];
        return at
          ? [{ accountId, at, cycle, publish: publish?.scheduledAt === at }]
          : [];
      })
      .sort((a, b) => a.at.localeCompare(b.at))[0];
    if (!due || Date.parse(due.at) > Date.now()) {
      this.state.lastHeartbeatAt = now();
      this.state.nextCheckAt = new Date(
        Math.min(Date.now() + 60000, due ? Date.parse(due.at) : Infinity),
      ).toISOString();
      this.state.message = this.state.config.accountIds.every((id) =>
        this.state.blockedAccountIds.includes(id),
      )
        ? "账号需要处理，已保留后续排期"
        : "计划已保存，等待随机任务时间（无头运行）";
      this.persist();
      return;
    }
    // Consume the planned slot before remote work. An interrupted cycle is not replayed.
    if (due.cycle && Date.parse(due.cycle.at) <= Date.now())
      this.planCycle(
        due.accountId,
        local,
        Date.now() + Math.max(60, this.state.config.gapMinutes) * 60000,
      );
    this.event(
      "cycle.started",
      due.publish ? "已到发布排期，准备无头执行" : "已到任务排期，准备无头执行",
      undefined,
      "info",
      {
        accountId: due.accountId,
        plannedAt: due.at,
        cycleId: due.cycle?.id,
        browserMode: "headless",
        targets: due.cycle?.targets,
      },
    );
    this.working = true;
    const revision = this.state.revision;
    this.state.lastHeartbeatAt = now();
    this.state.nextCheckAt = new Date(Date.now() + 60000).toISOString();
    try {
      if (this.competing().length || this.d.zhihu.running)
        fail("其他运营模式已占用账号，请关闭冲突模式后继续");
      if (
        (this.state.config.publish || this.state.config.answerRecommended) &&
        this.state.model !== this.d.ai.modelFor("copy")
      )
        fail("内容生成模型已改变，请关闭后重新开启以应用新模型");
      if (
        (this.state.config.publish || this.state.config.answerRecommended) &&
        this.unknownCosts()
      )
        fail("存在生成费用待核实记录，未继续调用模型");
      const cfg = this.state.config,
        s = this.d.zhihu.snapshot();
      let reached = 0;
      for (const accountId of [due.accountId]) {
        this.guard(revision);
        const account = s.accounts.find((a) => a.id === accountId);
        if (
          !account ||
          account.uid !== this.state.identities[accountId] ||
          account.status !== "connected"
        ) {
          this.message(
            accountId,
            "账号身份变化或未登录，请处理后重新开启",
            true,
          );
          continue;
        }
        try {
          if (this.state.researchStops[accountId]) {
            this.message(
              accountId,
              `内容读取已暂停：${this.state.researchStops[accountId]}。处理后关闭并重新开启`,
              true,
            );
            continue;
          }
          const own = this.state.jobs.filter((j) => j.accountId === accountId);
          if (!cfg.publish && !cfg.answerRecommended) {
            if (
              await readNextAutocareContext(
                this.researchHost(revision),
                accountId,
              )
            )
              return;
            this.message(
              accountId,
              "内容研究按时段与读取上限执行；点赞关注待本人确认",
            );
            continue;
          }
          if (
            own.some((j) => j.status === "attention") ||
            s.tasks.some(
              (t) => t.accountId === accountId && t.status === "attention",
            )
          ) {
            this.message(
              accountId,
              "存在待核对结果，请先打开任务详情处理",
              true,
            );
            continue;
          }
          const progress = account.plan.progress;
          if (
            !progress ||
            progress.source !== "official" ||
            Date.now() - Date.parse(progress.checkedAt) > 6 * 3600000
          ) {
            await this.d.zhihu.checkProgress(accountId, () =>
              this.guard(revision),
            );
            this.guard(revision);
          }
          const current = this.d.zhihu.plan(accountId).progress;
          if (!current?.creator || current.level === null) {
            this.message(accountId, "请先完成创作者入驻并核实等级", true);
            continue;
          }
          if (current.level >= cfg.targetLevel) {
            this.cancelFuture(accountId);
            reached++;
            this.message(accountId, "目标等级已达到，自动发文和回答停止");
            if (
              await readNextAutocareContext(
                this.researchHost(revision),
                accountId,
              )
            )
              return;
            continue;
          }
          const waiting = own.find(
            (j) => j.status === "queued" && enabledAutocareJob(this.state, j),
          );
          if (waiting) {
            const t = this.d.zhihu
              .snapshot()
              .tasks.find((t) => t.id === waiting.taskId);
            if (!t) fail("原发布任务不存在，未创建替代任务");
            if (
              waiting.kind === "answer" &&
              !t.attemptedAt &&
              s.tasks.filter(
                (other) =>
                  other.accountId === accountId &&
                  other.kind === "answer" &&
                  other.attemptedAt &&
                  zhihuDay(other.attemptedAt) === zhihuDay(Date.now()),
              ).length >= cfg.answersPerDay
            ) {
              this.d.zhihu.cancel(t.id);
              waiting.taskId = undefined;
              waiting.scheduledAt = undefined;
              waiting.status = "ready";
              this.message(accountId, "已到今日回答上限，原稿保留到下一运营日");
              this.persist();
              continue;
            }
            const day = zhihuDay(Date.now()),
              start = Date.parse(`${day}T${cfg.windowStart}:00+08:00`),
              end = Date.parse(`${day}T${cfg.windowEnd}:00+08:00`);
            if (Date.now() >= end || Date.now() < start) {
              this.message(accountId, "等待运营时段，错过的任务将重新分散安排");
              if (!t.attemptedAt) {
                this.d.zhihu.cancel(t.id);
                waiting.taskId = undefined;
                waiting.status = "ready";
                waiting.scheduledAt = undefined;
              }
              continue;
            }
            if (Date.parse(t.scheduledAt) > Date.now()) {
              if (
                await readNextAutocareContext(
                  this.researchHost(revision),
                  accountId,
                )
              )
                return;
              this.message(
                accountId,
                `等待随机排期：${new Date(t.scheduledAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
              );
              continue;
            }
            this.guard(revision);
            this.state.message = "正在执行发布任务";
            this.message(accountId, "正在核验身份并填写官方编辑器");
            await this.d.zhihu.executeRuleTask(
              t.id,
              () =>
                !this.closed &&
                this.state.enabled &&
                this.state.revision === revision,
            );
            this.sync();
            this.state.message = this.state.enabled
              ? "按规则运行，等待下一项任务"
              : this.state.message;
            this.message(
              accountId,
              waiting.status === "published"
                ? "本次文章已确认发布"
                : waiting.message,
              waiting.status === "attention",
            );
            this.persist();
            if (waiting.status === "published" && this.state.enabled) {
              try {
                await this.d.zhihu.checkProgress(accountId, () =>
                  this.guard(revision),
                );
                this.event(
                  "creator.updated",
                  "官方等级、创作分和升级进度已刷新",
                  waiting,
                );
              } catch (error) {
                this.event(
                  "creator.refresh_failed",
                  `文章已发布，创作者数据刷新未完成：${safeMessage(error)}`,
                  waiting,
                  "warning",
                );
              }
            }
            return;
          }
          const answerAttempts = s.tasks.filter(
            (t) =>
              t.accountId === accountId &&
              t.kind === "answer" &&
              t.attemptedAt &&
              zhihuDay(t.attemptedAt) === zhihuDay(Date.now()),
          ).length;
          let job: AutocareJob | null | undefined = own.find(
            (j) =>
              j.status === "ready" &&
              enabledAutocareJob(this.state, j) &&
              (j.kind !== "answer" || answerAttempts < cfg.answersPerDay),
          );
          if (!job) {
            const counts = zhihuCounts(s.tasks, accountId, Date.now());
            if (
              counts.today >=
                Math.min(cfg.dailyLimit, account.plan.dailyLimit) ||
              counts.week >= Math.min(cfg.weeklyLimit, account.plan.weeklyLimit)
            ) {
              if (
                await readNextAutocareContext(
                  this.researchHost(revision),
                  accountId,
                )
              )
                return;
              this.message(accountId, "已到日/周发布额度，等待下一可用日期");
              continue;
            }
            if (this.generationCount() >= cfg.generationsPerDay) {
              if (
                await readNextAutocareContext(
                  this.researchHost(revision),
                  accountId,
                )
              )
                return;
              this.message(accountId, "已到今日AI生成次数上限，现成稿仍可执行");
              continue;
            }
            const slot = autocareSlot(
              this.state,
              s,
              accountId,
              Date.now(),
              this.interactions(),
            );
            if (!slot) {
              this.message(accountId, "未来7天暂无合法时段");
              continue;
            }
            if (cfg.answerRecommended && answerAttempts < cfg.answersPerDay)
              job = await prepareAutocareAnswer(
                this.researchHost(revision),
                accountId,
              );
            this.guard(revision);
            if (
              !job &&
              cfg.publish &&
              this.generationCount() < cfg.generationsPerDay
            )
              job = await this.prepare(accountId, revision);
            this.guard(revision);
            if (!job) {
              if (
                await readNextAutocareContext(
                  this.researchHost(revision),
                  accountId,
                )
              )
                return;
              this.message(
                accountId,
                "暂无可准备的回答或已到今日回答上限，等待下一次检查",
              );
              continue;
            }
          }
          if (
            job.kind === "answer" &&
            s.tasks.filter(
              (t) =>
                t.accountId === accountId &&
                t.kind === "answer" &&
                t.attemptedAt &&
                zhihuDay(t.attemptedAt) === zhihuDay(Date.now()),
            ).length >= cfg.answersPerDay
          ) {
            this.message(accountId, "已到今日回答上限，原稿保留等待明日");
            continue;
          }
          const slot = autocareSlot(
            this.state,
            this.d.zhihu.snapshot(),
            accountId,
            Date.now(),
            this.interactions(),
          );
          if (!slot) {
            this.message(accountId, "没有合法时段，已生成稿保留");
            continue;
          }
          this.guard(revision);
          const currentJob = job;
          this.d.db.transaction(() => {
            const task = this.d.zhihu.enqueue(
              accountId,
              currentJob.contentId!,
              slot,
            );
            currentJob.scheduledAt = slot;
            currentJob.taskId = task.id;
            currentJob.status = "queued";
            currentJob.message = "规则检查通过，等待随机发布";
            currentJob.updatedAt = now();
            this.persist();
          });
          this.state.message = "等待随机发布";
          this.message(
            accountId,
            `已安排随机发布时间：${new Date(slot).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
          );
          this.event("publish.scheduled", job.message, job);
          this.persist();
          return;
        } catch (error) {
          this.message(accountId, safeMessage(error), true);
        }
      }
      if (
        this.d.zhihu
          .snapshot()
          .accounts.filter((a) => cfg.accountIds.includes(a.id)).length ===
          cfg.accountIds.length &&
        this.d.zhihu
          .snapshot()
          .accounts.filter((a) => cfg.accountIds.includes(a.id))
          .every(
            (a) =>
              a.plan.progress?.creator &&
              a.plan.progress.level !== null &&
              a.plan.progress.level >= cfg.targetLevel,
          ) &&
        !hasAutocareResearch(this.state)
      ) {
        this.state.enabled = false;
        this.state.message = "所选账号均已达到目标等级";
        this.event("run.target_reached", this.state.message);
      } else
        this.state.message =
          this.state.blockedAccountIds.filter((id) =>
            cfg.accountIds.includes(id),
          ).length +
            reached ===
          cfg.accountIds.length
            ? "剩余账号需处理，查看下方具体原因"
            : "按规则运行，等待下一项任务";
    } catch (error) {
      this.state.message = safeMessage(error);
      this.state.enabled = false;
      if (!this.closed) this.cancelFuture();
      this.event("run.attention", this.state.message, undefined, "warning");
    } finally {
      this.event(
        "cycle.finished",
        this.state.accountMessages[due.accountId] || this.state.message,
        undefined,
        "info",
        { accountId: due.accountId, plannedAt: due.at, cycleId: due.cycle?.id },
      );
      this.working = false;
      this.requestBudget = undefined;
      if (!this.state.enabled && this.state.message.startsWith("正在收尾"))
        this.state.message = "已关闭";
      this.persist();
    }
  }
  private researchHost(revision: number): AutocareParticipationHost {
    return {
      db: this.d.db,
      state: this.state,
      participation: this.d.participation,
      zhihu: this.d.zhihu,
      ai: this.d.ai,
      guard: () => this.guard(revision),
      closed: () => this.closed,
      persist: () => this.persist(),
      log: (event, message, accountId, level = "info", job) => {
        const key = `${accountId}:${event}`;
        if (!job && this.researchMessages.get(key) === message) return;
        this.researchMessages.set(key, message);
        this.event(event, message, job, level, { accountId });
      },
    };
  }
  async interact(raw: unknown) {
    const input = autocareInteractionInput.parse(raw);
    this.guard(input.revision);
    if (
      this.working ||
      this.d.participation.isBusy ||
      this.d.zhihu.isBusy ||
      this.d.operations.isBusy
    )
      fail("已有任务执行中，请完成后再确认互动");
    const activity = this.d.participation
      .snapshot()
      .activities.find((a) => a.id === input.id);
    if (
      !activity ||
      activity.planId !== autocareParticipationScope ||
      activity.version !== input.version ||
      !this.owns(activity.accountId)
    )
      fail("互动待办归属或版本已变化");
    const allowed =
      activity.kind === "like"
        ? this.state.config.likeCandidates
        : activity.kind === "follow" && this.state.config.followCandidates;
    if (!allowed) fail("此类操作未开启或不属于点赞关注待办");
    const revision = this.state.revision,
      accountId = activity.accountId;
    const check = () => {
      this.guard(revision);
      if (this.state.researchStops[accountId])
        fail(`此账号内容读取已暂停：${this.state.researchStops[accountId]}`);
      if (
        this.d.zhihu
          .snapshot()
          .tasks.some(
            (t) => t.accountId === accountId && t.status === "attention",
          )
      )
        fail("此账号有待核对发布结果，请先处理原任务");
      if (
        this.d.zhihu.snapshot().accounts.find((a) => a.id === accountId)
          ?.uid !== this.state.identities[accountId]
      )
        fail("账号身份已变化，未执行互动");
      const day = zhihuDay(Date.now()),
        cfg = this.state.config;
      if (
        Date.now() < Date.parse(`${day}T${cfg.windowStart}:00+08:00`) ||
        Date.now() >= Date.parse(`${day}T${cfg.windowEnd}:00+08:00`)
      )
        fail("当前不在运营时段，未执行互动");
    };
    check();
    this.working = true;
    this.event(
      "interaction.confirmed",
      `本人确认对准确目标执行${activity.kind === "like" ? "点赞" : "关注"}`,
      undefined,
      "info",
      { accountId, activityId: activity.id },
    );
    this.persist();
    try {
      const result = await this.d.participation.executeInteraction(
        {
          id: input.id,
          version: input.version,
          decision: {
            source: "human",
            relevance: null,
            basis: input.basis,
            quote: input.quote,
          },
        },
        {
          planId: autocareParticipationScope,
          planRevision: revision,
          humanConfirmed: true,
          dailyLimit: this.state.config.interactionDailyLimit,
          gapMinutes: Math.max(60, this.state.config.gapMinutes),
          excludedUids: [],
          guard: check,
        },
      );
      const attempt = result.attempts?.at(-1);
      this.event(
        "interaction.result",
        attempt?.receipt?.summary || attempt?.error || "互动未取得成功回执",
        undefined,
        result.status === "succeeded" ? "info" : "warning",
        {
          accountId,
          activityId: activity.id,
          submittedAt: attempt?.submittedAt,
          receipt: attempt?.receipt,
        },
      );
      return this.snapshot();
    } catch (error) {
      this.event(
        "interaction.blocked",
        safeMessage(error),
        undefined,
        "warning",
        { accountId, activityId: activity.id },
      );
      throw error;
    } finally {
      this.working = false;
      this.persist();
    }
  }
  async refreshInteraction(input: { id: string; version: number }) {
    if (this.working || this.d.participation.isBusy || this.d.zhihu.isBusy)
      fail("已有任务执行中，稍后更新上下文");
    const snapshot = this.d.participation.snapshot();
    const activity = snapshot.activities.find(
      (a) =>
        a.id === input.id &&
        a.planId === autocareParticipationScope &&
        this.state.config.accountIds.includes(a.accountId),
    );
    if (
      !activity ||
      activity.version !== input.version ||
      activity.attempts?.length ||
      activity.resolution ||
      !["like", "follow"].includes(activity.kind)
    )
      fail("仅可更新尚未执行且未处理的原互动待办");
    const candidate = snapshot.candidates.find(
      (c) =>
        c.id === activity.candidateId && c.accountId === activity.accountId,
    );
    if (!candidate) fail("原目标不存在，未寻找替代目标");
    const revision = this.state.revision;
    const uid = this.d.zhihu
      .snapshot()
      .accounts.find((a) => a.id === activity.accountId)?.uid;
    const guard = () => {
      if (this.closed || this.state.revision !== revision)
        fail("设置已变化，未继续更新目标");
      if (
        !uid ||
        this.d.zhihu
          .snapshot()
          .accounts.find((a) => a.id === activity.accountId)?.uid !== uid
      )
        fail("账号身份已变化，未更新原待办");
    };
    guard();
    this.working = true;
    try {
      const read = await this.d.participation.inspect(
        {
          accountId: activity.accountId,
          candidateId: candidate.id,
          version: candidate.version,
        },
        guard,
      );
      guard();
      this.d.participation.plan(
        {
          accountId: activity.accountId,
          candidateId: read.id,
          version: read.version,
          kind: activity.kind,
          planId: autocareParticipationScope,
          reason: "本人更新准确目标的上下文，待重新查看后单项确认",
        },
        guard,
      );
      delete this.state.researchStops[activity.accountId];
      this.event(
        "interaction.context_updated",
        "原互动待办的上下文已更新，未点赞或关注",
        undefined,
        "info",
        { accountId: activity.accountId, activityId: activity.id },
      );
      return this.snapshot();
    } finally {
      this.working = false;
      this.persist();
    }
  }
  async reconcileInteraction(input: { id: string; version: number }) {
    if (this.working) fail("已有任务执行中，稍后读取原结果");
    const activity = this.d.participation
      .snapshot()
      .activities.find(
        (a) => a.id === input.id && a.planId === autocareParticipationScope,
      );
    if (!activity) fail("此记录不属于普通运营的互动待办");
    this.working = true;
    try {
      const result = await this.d.participation.reconcileInteraction(input);
      this.event(
        "interaction.reconciled",
        result.attempts?.at(-1)?.receipt?.summary ||
          "原提交结果仍待核对，未重新执行",
        undefined,
        result.status === "succeeded" ? "info" : "warning",
        { accountId: activity.accountId, activityId: activity.id },
      );
      return this.snapshot();
    } finally {
      this.working = false;
      this.persist();
    }
  }
  private interactions() {
    return readParticipationState(this.d.db).activities.flatMap((a) =>
      (a.attempts ?? []).map((t) => ({
        at: t.startedAt,
        accountId: a.accountId,
        networkKey: t.networkKey || "unknown",
      })),
    );
  }
  private async prepare(
    accountId: string,
    revision: number,
  ): Promise<AutocareJob | null> {
    const excluded = new Set([
      ...this.state.jobs.map((j) => j.sourceId),
      ...this.d.zhihu
        .snapshot()
        .contents.flatMap((c) =>
          c.source?.provider === "pipix" ? [c.source.itemId] : [],
        ),
      ...this.d.db
        .all<{ source_id: string }>(
          "SELECT source_id FROM content_source_exports WHERE provider='pipix' AND channel='zhihu'",
        )
        .map((r) => r.source_id),
      ...readSupplyDrafts(this.d.db)
        .filter((d) => d.stage === "held")
        .map((d) => d.sourceId),
    ]);
    const choose = () => {
      // Exhaust local candidates in bounded batches before spending on a new list.
      for (let offset = 0; ; offset += 500) {
        const rows = this.d.db.all<{ data: string }>(
          "SELECT data FROM content_knowledge_items WHERE provider='pipix' AND kind IN ('images','text') AND length(trim(text))>=40 ORDER BY last_seen DESC,source_id DESC LIMIT 500 OFFSET ?",
          offset,
        );
        const candidate = rows
          .map((r) => JSON.parse(r.data) as PipixCandidate)
          .find(
            (c) =>
              !excluded.has(c.id) &&
              c.text.trim().length >= 40 &&
              !/https?:\/\/|提取码|购买|私信|加群|扫码|返利/.test(c.text),
          );
        if (candidate) return candidate;
        if (rows.length < 500) return undefined;
      }
    };
    const requestBudget = this.d.pipix.requestBudget();
    this.requestBudget = requestBudget;
    let candidate = choose();
    if (!candidate) {
      const local = this.d.pipix.knowledge({ mode: "home" });
      if (local.next?.retry) fail("上次皮皮虾推荐请求待核对，不自动重发");
      if (local.unparsed)
        fail("本地采集响应尚未完成索引，请在公共素材中重建索引，未重复请求");
      if (
        local.hasQuery &&
        !local.next &&
        local.latestAt &&
        zhihuDay(local.latestAt) === zhihuDay(Date.now())
      ) {
        this.message(accountId, "今日推荐列表已用尽，等待明日补料");
        return null;
      }
      const p = this.d.pipix.requestPolicy();
      if (!p.policy.listPagesPerRun || !p.remainingToday)
        fail("无可用库存，采集预算或列表页上限为0；请在内容数据源设置调整");
      this.guard(revision);
      const page = await this.d.pipix.discover(
        {
          mode: "home",
          cursor: local.next?.cursor ?? "0",
          page: local.next?.page ?? 0,
          force: local.hasQuery && !local.next,
        },
        requestBudget,
      );
      const usage = this.d.pipix.requestPolicy();
      this.event(
        "source.list",
        `推荐列表已入库${page.cached ? "，复用缓存" : ""}；今日采集剩余${usage.remainingToday}/${usage.policy.dailyRequests}次`,
      );
      this.guard(revision);
      candidate = choose();
      if (!candidate) {
        this.message(accountId, "当前推荐页暂无可用图文，等待后续补料");
        return null;
      }
    }
    if (this.state.jobs.length >= 5000)
      fail("运行历史已到5000项，请整理后继续");
    const job: AutocareJob = {
      id: id("autocare"),
      accountId,
      uid: this.state.identities[accountId],
      kind: "article",
      sourceId: candidate.id,
      model: this.state.model,
      templateVersion: 1,
      sourceHash: "",
      status: "collecting",
      message: "复用公共采集器，读取来源与配图",
      createdAt: now(),
      updatedAt: now(),
      checks: [],
    };
    this.state.jobs.push(job);
    this.event("source.selected", job.message, job);
    this.persist();
    try {
      const { source, reused } = await this.d.pipix.ensureCollected(
        candidate.id,
      );
      this.guard(revision);
      job.sourceHash = fingerprint({
        text: source.text,
        images: source.images.map((i) => i.asset?.sha256),
      });
      if (
        this.state.jobs.some(
          (j) => j.id !== job.id && j.sourceHash === job.sourceHash,
        )
      )
        fail("原始图文指纹与其他任务相同");
      let comments = this.state.config.includeComments
        ? this.d.pipix.comments.usable(source.id).slice(0, 3)
        : [];
      if (
        this.state.config.includeComments &&
        !this.d.pipix.comments.hasIndexed(source.id) &&
        this.d.pipix.requestPolicy().policy.commentPagesPerItem > 0 &&
        requestBudget.used < requestBudget.limit
      ) {
        this.guard(revision);
        await this.d.pipix.fetchComments(
          {
            sourceId: source.id,
            confirmed: true,
          },
          requestBudget,
        );
        this.guard(revision);
        comments = this.d.pipix.comments.usable(source.id).slice(0, 3);
      }
      this.event(
        "source.collected",
        `来源已就绪${reused ? "，复用本地缓存" : ""}；${source.images.length}张原图、${comments.length}条参考评论`,
        job,
      );
      this.d.ai.assertTextConfigured("copy");
      this.guard(revision);
      job.status = "generating";
      this.state.message = "正在准备文章";
      job.generatedAt = now();
      job.message = "AI正在整理成稿";
      this.persist();
      this.event("generation.started", job.message, job);
      const result = await generateAutocareArticle(
        this.d.ai,
        job.id,
        source,
        comments,
        () => this.guard(revision),
      );
      // Always keep a received paid result, even if the switch was turned off in flight.
      if (this.closed) return null;
      const checks = checkAutocareArticle(result, source, comments);
      if (
        this.d.zhihu
          .snapshot()
          .contents.some((c) => normalize(c.body) === normalize(result.body))
      )
        fail("生成正文与现有稿件重复");
      const approved = readSupplyDrafts(this.d.db).find(
        (d) =>
          d.sourceId === source.id &&
          ["own", "authorized", "license", "public-domain"].includes(
            d.editorial.imageBasis,
          ) &&
          !!d.editorial.imageEvidence,
      );
      const images = source.images
        .filter(
          (i) =>
            i.asset &&
            approved?.source?.images.some(
              (old) => old.asset?.sha256 === i.asset?.sha256,
            ),
        )
        .slice(0, 9)
        .map((i) => i.asset!);
      this.d.db.transaction(() => {
        // Content, public delivery and rule approval are persisted together.
        const content = this.d.zhihu.saveSource({
          title: result.title,
          body: `${result.body}\n\n参考来源：${source.author}，皮皮虾帖子 ${source.id}`,
          images,
          source: {
            provider: "pipix",
            itemId: source.id,
            url: source.url,
            author: source.author,
            collectedAt: source.collectedAt,
            comments: comments.map((c) => ({ id: c.id, author: c.author })),
            editorial: {
              id: job.id,
              version: 1,
              direction: "不限领域",
              accountId,
              contribution: result.evidence.join("\n"),
              aiAssisted: true,
              purpose: "warming",
              rights: [
                {
                  asset: "text",
                  basis: "reference",
                  evidence: "以原帖作为参考，保留出处，生成独立解释",
                },
                ...(images.length && approved
                  ? [
                      {
                        asset: "images",
                        basis: approved.editorial.imageBasis,
                        evidence: approved.editorial.imageEvidence,
                      },
                    ]
                  : []),
              ],
            },
          },
        });
        job.contentId = content.id;
        const owned = this.d.zhihu.saveContent({ ...content, accountId });
        job.fingerprint = contentFingerprint(owned);
        job.checks = checks;
        job.status = "ready";
        job.message = images.length
          ? "规则检查通过，待安排发布"
          : "规则检查通过；原图使用依据未齐，采用文字稿";
        job.updatedAt = now();
        const delivery: ContentSourceExport = {
          id: id("sourceexport"),
          provider: "pipix",
          sourceId: source.id,
          channel: "zhihu",
          accountId,
          targetId: owned.id,
          title: owned.title,
          createdAt: now(),
        };
        if (
          this.d.db.get(
            "SELECT id FROM content_source_exports WHERE provider='pipix' AND source_id=? AND channel='zhihu' LIMIT 1",
            source.id,
          )
        )
          fail("此来源已由其他流程生成知乎稿，未重复交付");
        this.d.db.run(
          "INSERT INTO content_source_exports(id,provider,source_id,channel,account_id,data) VALUES(?,?,?,?,?,?)",
          delivery.id,
          delivery.provider,
          delivery.sourceId,
          delivery.channel,
          delivery.accountId,
          JSON.stringify(delivery),
        );
        this.persist();
      });
      this.event("generation.ready", job.message, job);
      return job;
    } catch (error) {
      if (this.closed) return null;
      job.status =
        job.generatedAt && this.unknownCosts() ? "attention" : "skipped";
      job.message = safeMessage(error);
      job.updatedAt = now();
      this.event("source.skipped", job.message, job, "warning");
      this.message(
        accountId,
        `素材已跳过：${job.message}`,
        job.status === "attention",
      );
      this.persist();
      if (!this.state.enabled || revision !== this.state.revision) throw error;
      return null;
    }
  }
  close() {
    this.closed = true;
    this.requestBudget?.stop();
    clearInterval(this.timer);
  }
}

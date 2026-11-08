import { createHash } from "node:crypto";
import type { z } from "zod";
import type { Database } from "../database";
import type { AppPorts } from "../ports";
import type { WebsiteAccounts } from "../website-accounts";
import type { BrowserEnvironments } from "../browser-environments";
import type { BrowserEnvironmentQueue } from "../browser-environment-queue";
import type { TiebaAutomation } from "../tieba-automation/service";
import { TiebaAutocareStore } from "../tieba-autocare/store";
import {
  tiebaForumReadingFields,
  verifiedTiebaFollowState,
} from "../tieba-autocare/follow-state";
import { RuntimeLog } from "../runtime-log";
import { AppError, safeMessage } from "../errors";
import {
  type TiebaInsightsSnapshot,
  type TiebaMetricPoint,
  type TiebaPublicationRef,
  type TiebaPublicationView,
  type TiebaVisibilityReading,
  tiebaInsightsRefreshSchema,
  tiebaInsightsSaveSchema,
  tiebaInsightsPresetSchema,
} from "../../shared/tieba-insights";

const stateKey = "tiebaInsights:v1";
const ref = (id: string) => ({ kind: "website" as const, id });
const minute = 60_000;
const delay = 10 * minute;
const windowLength = 120 * minute;
interface ReviewRecord extends Omit<TiebaVisibilityReading, "checkedAt"> {
  checkedAt: string | null;
  sourceHash: string;
  attempts: number;
  nextCheckAt: string | null;
}
type Dependencies = {
  db: Database;
  accounts: WebsiteAccounts;
  environments: BrowserEnvironments;
  queue: BrowserEnvironmentQueue;
  ports: AppPorts;
  automation: Pick<TiebaAutomation, "snapshot" | "save">;
  publications(): TiebaPublicationRef[];
  dataPath: string;
  changed(): void;
  clock?(): number;
};
const digest = (value: TiebaPublicationRef) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        value.id,
        value.accountId,
        value.uid,
        value.threadId,
        value.postId,
        value.body,
        value.submittedAt,
      ]),
    )
    .digest("hex");

export class TiebaInsights {
  readonly logs: RuntimeLog;
  private targets: TiebaAutocareStore;
  private working = false;
  private closed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private controllers = new Set<AbortController>();
  private nextTick = 0;
  private suspended = false;
  constructor(private d: Dependencies) {
    this.logs = new RuntimeLog(d.db, d.dataPath, "tieba-insights");
    this.targets = new TiebaAutocareStore(d.db);
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
      throw new AppError(
        "TIEBA_INSIGHTS_CLOSED",
        "运营复盘已停止，原记录保留。",
      );
  }
  private settings() {
    return this.d.db.setting(stateKey, { revision: 1, autoReview: false });
  }
  private reading(id: string, source: TiebaPublicationRef) {
    const row = this.d.db.get<{ data: string }>(
      "SELECT data FROM tieba_visibility_checks WHERE publication_id=?",
      id,
    );
    const value = row ? (JSON.parse(row.data) as ReviewRecord) : null;
    return value?.sourceHash === digest(source) ? value : null;
  }
  private saveReading(id: string, value: ReviewRecord) {
    this.d.db.run(
      "INSERT INTO tieba_visibility_checks(publication_id,data) VALUES(?,?) ON CONFLICT(publication_id) DO UPDATE SET data=excluded.data",
      id,
      JSON.stringify(value),
    );
  }
  private finishReviewAttempt(
    source: TiebaPublicationRef,
    previous: ReviewRecord | null,
    message: string,
  ) {
    const attempts = Math.min(2, (previous?.attempts ?? 0) + 1);
    const next = Date.parse(source.submittedAt) + 24 * 60 * minute;
    this.saveReading(source.id, {
      visibility: previous?.visibility ?? "unknown",
      checkedAt: previous?.checkedAt ?? null,
      message,
      sourceHash: digest(source),
      attempts,
      nextCheckAt:
        attempts < 2 && this.time() < next + windowLength
          ? new Date(next).toISOString()
          : null,
    });
  }
  private sources() {
    const seen = new Set<string>();
    return this.d
      .publications()
      .filter((entry) => {
        if (
          seen.has(entry.id) ||
          (entry.threadId !== null &&
            !/^[1-9]\d{0,19}$/.test(entry.threadId)) ||
          !entry.uid ||
          !Number.isFinite(Date.parse(entry.submittedAt))
        )
          return false;
        seen.add(entry.id);
        return true;
      })
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  }
  private publication(source: TiebaPublicationRef): TiebaPublicationView {
    const checked = this.reading(source.id, source),
      settings = this.settings();
    const {
      uid: _uid,
      body: _body,
      forumId: _forum,
      postId: _post,
      ...base
    } = source;
    return {
      ...base,
      visibility: checked?.visibility ?? "unknown",
      checkedAt: checked?.checkedAt ?? null,
      nextCheckAt:
        settings.autoReview && source.threadId
          ? checked
            ? checked.nextCheckAt
            : new Date(Date.parse(source.submittedAt) + delay).toISOString()
          : null,
      message:
        checked?.message ??
        (source.threadId
          ? "尚未复查官网可见性；提交状态保持原记录。"
          : "尚未取得准确主题ID，请在原主题草稿只读核对；不会重新发布。"),
    };
  }
  snapshot(): TiebaInsightsSnapshot {
    this.alive();
    const targets = this.targets.targets().map((target) => {
      const history = this.d.db
        .all<{ data: string }>(
          "SELECT data FROM tieba_forum_metrics WHERE uid=? AND forum_id=? ORDER BY checked_at DESC LIMIT 30",
          target.uid,
          target.forumId,
        )
        .map((row) => JSON.parse(row.data) as TiebaMetricPoint);
      const latest = history[0] ?? target;
      const level = history.filter((point) => point.level !== null),
        experience = history.filter((point) => point.experience !== null);
      return {
        targetId: target.id,
        accountId: target.accountId,
        name: target.name,
        level: latest.level,
        experience: latest.experience,
        checkedAt: latest.checkedAt,
        history,
        deltaLevel:
          latest.level !== null && level.length > 1
            ? latest.level - level[1].level!
            : null,
        deltaExperience:
          latest.experience !== null && experience.length > 1
            ? latest.experience - experience[1].experience!
            : null,
      };
    });
    const all = this.sources().map((source) => this.publication(source));
    const unresolved = all.filter(
      (item) =>
        item.submissionStatus !== "verified" ||
        ["unknown", "pending_review"].includes(item.visibility),
    );
    const unresolvedIds = new Set(unresolved.map((item) => item.id));
    const publications = [
      ...unresolved,
      ...all.filter((item) => !unresolvedIds.has(item.id)).slice(0, 300),
    ];
    const recommendations: TiebaInsightsSnapshot["recommendations"] = [];
    if (all.some((item) => item.submissionStatus === "uncertain"))
      recommendations.push({
        id: "verify-first",
        title: "先核实原提交",
        reason:
          "存在提交结果未知的记录。请在原回复或主题草稿核对，未找到不能推断为删除，也不能重发。",
        preset: null,
      });
    if (
      targets.some(
        (target) => target.level === null || target.experience === null,
      )
    )
      recommendations.push({
        id: "read-metrics",
        title: "补充官方读数",
        reason:
          "部分目标没有可确认的等级或经验。选择目标刷新，保留未知，不据缺失读数调整发言次数。",
        preset: null,
      });
    recommendations.push({
      id: "prepare-first",
      title: "低频准备草稿",
      reason:
        "每日自动准备1条回复草稿，保留人工审阅；应用不会开启批次或增加发布授权。",
      preset: "conservative",
    });
    recommendations.push({
      id: "standard-drafts",
      title: "标准草稿预设",
      reason:
        "每日最多准备2条草稿，仍使用全局AI预算与完整上下文检查；适合已有稳定阅读目标的场景。",
      preset: "standard",
    });
    return {
      busy: this.working,
      settings: this.settings(),
      targets,
      publications,
      recommendations,
      logs: this.logs.read({}),
      message: this.working
        ? "正在只读核对官网运营数据"
        : "等级、提交与可见性分别记录；建议不会自动扩大执行范围。",
    };
  }
  save(input: z.infer<typeof tiebaInsightsSaveSchema>) {
    this.alive();
    const settings = this.settings();
    if (input.revision !== settings.revision)
      throw new AppError(
        "TIEBA_INSIGHTS_CHANGED",
        "复查设置已在其他窗口变化，请刷新后再保存。",
      );
    this.d.db.setSetting(stateKey, {
      revision: settings.revision + 1,
      autoReview: input.autoReview,
    });
    this.d.changed();
    return this.snapshot();
  }
  applyPreset(input: z.infer<typeof tiebaInsightsPresetSchema>) {
    this.alive();
    const current = this.d.automation.snapshot();
    this.d.automation.save({
      revision: input.automationRevision,
      config: {
        ...current.config,
        mode: "draft",
        dailyLimit: input.preset === "conservative" ? 1 : 2,
      },
    });
    this.logs.record({
      event: "strategy.applied",
      level: "info",
      message: `已应用${input.preset === "conservative" ? "低频" : "标准"}草稿预设；自动意图关闭，目标范围保持原选择。`,
    });
    this.d.changed();
    return this.snapshot();
  }
  private async operation(action: () => Promise<void>) {
    this.alive();
    if (this.working)
      throw new AppError(
        "TIEBA_INSIGHTS_BUSY",
        "已有复查正在进行，请等待完成。",
      );
    this.working = true;
    this.d.changed();
    try {
      await action();
      this.alive();
      return this.snapshot();
    } finally {
      this.working = false;
      if (!this.closed) this.d.changed();
    }
  }
  private async queued<T>(
    accountId: string,
    label: string,
    action: () => Promise<T>,
  ) {
    this.alive();
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      return await this.d.queue.schedule(
        [ref(accountId)],
        label,
        async () => {
          this.alive();
          return action();
        },
        controller.signal,
      );
    } finally {
      this.controllers.delete(controller);
    }
  }
  private account(accountId: string, uid: string) {
    const account = this.d.accounts.get(accountId);
    if (
      account.provider !== "tieba" ||
      account.uid !== uid ||
      account.status !== "connected"
    )
      throw new AppError(
        "TIEBA_INSIGHTS_IDENTITY",
        "请先核实原贴吧账号身份，未读取其他账号的运营数据。",
      );
    return account;
  }
  private async metric(targetId: string) {
    const target = this.targets.target(targetId);
    if (!target)
      throw new AppError("TIEBA_INSIGHTS_TARGET", "目标贴吧已不存在。");
    await this.queued(
      target.accountId,
      `读取等级与经验 · ${target.name}`,
      async () => {
        const account = this.account(target.accountId, target.uid),
          stamp = this.d.environments.stamp(ref(account.id));
        this.d.environments.assertStamp(ref(account.id), target.stamp);
        await this.d.accounts.verify(account.id);
        this.alive();
        this.account(account.id, target.uid);
        if (!this.d.ports.tieba)
          throw new AppError(
            "TIEBA_BROWSER_UNAVAILABLE",
            "当前后台未接入贴吧读取。",
          );
        const reading = await this.d.ports.tieba.readForum(
          account,
          target.uid,
          target,
        );
        this.alive();
        this.account(account.id, target.uid);
        this.d.environments.assertStamp(ref(account.id), stamp);
        if (
          reading.forumId !== target.forumId ||
          reading.name !== target.name ||
          !Number.isFinite(Date.parse(reading.checkedAt)) ||
          Date.parse(reading.checkedAt) > this.time() + 5000 ||
          Date.parse(reading.checkedAt) < this.time() - delay
        )
          throw new AppError(
            "TIEBA_INSIGHTS_READING",
            "官网返回的贴吧或读取时间不匹配，原历史保留。",
          );
        const current = this.targets.target(target.id);
        if (!current || current.uid !== target.uid)
          throw new AppError(
            "TIEBA_INSIGHTS_TARGET",
            "读取期间目标身份已变化。",
          );
        this.targets.saveTarget({
          ...current,
          ...tiebaForumReadingFields(reading),
          ...verifiedTiebaFollowState(
            current,
            reading,
            { uid: target.uid, stamp },
            this.time(),
          ),
        });
      },
    );
  }
  private async visibility(
    source: TiebaPublicationRef,
    guard?: () => void,
    automatic = false,
  ) {
    if (!source.threadId)
      throw new AppError(
        "TIEBA_INSIGHTS_THREAD_UNKNOWN",
        "原提交尚未取得准确主题ID，请在原主题草稿只读核对，不重新发布。",
      );
    await this.queued(
      source.accountId,
      `复查官网可见性 · ${source.title}`,
      async () => {
        guard?.();
        const account = this.account(source.accountId, source.uid),
          stamp = this.d.environments.stamp(ref(account.id));
        await this.d.accounts.verify(account.id);
        this.alive();
        guard?.();
        this.account(account.id, source.uid);
        if (!this.d.ports.tiebaInsights)
          throw new AppError(
            "TIEBA_INSIGHTS_BROWSER",
            "当前后台未接入可见性读取，请应用更新后重试。",
          );
        const result = await this.d.ports.tiebaInsights.readVisibility(
          account,
          source.uid,
          source,
        );
        this.alive();
        guard?.();
        this.account(account.id, source.uid);
        this.d.environments.assertStamp(ref(account.id), stamp);
        const latest = this.sources().find((item) => item.id === source.id);
        if (!latest || digest(latest) !== digest(source))
          throw new AppError(
            "TIEBA_INSIGHTS_SOURCE_CHANGED",
            "原提交记录已变化，未覆盖本次可见性。",
          );
        if (
          !Number.isFinite(Date.parse(result.checkedAt)) ||
          Date.parse(result.checkedAt) > this.time() + 5000 ||
          Date.parse(result.checkedAt) < this.time() - delay ||
          !["visible", "pending_review", "unavailable", "unknown"].includes(
            result.visibility,
          )
        )
          throw new AppError(
            "TIEBA_INSIGHTS_READING",
            "官网复查结果或时间无效，原记录保留。",
          );
        const previous = this.reading(source.id, source),
          base = Date.parse(source.submittedAt);
        const attempts = automatic
          ? Math.min(2, (previous?.attempts ?? 0) + 1)
          : Math.max(
              previous?.attempts ?? 0,
              this.time() >= base + 24 * 60 * minute
                ? 2
                : this.time() >= base + delay
                  ? 1
                  : 0,
            );
        this.saveReading(source.id, {
          ...result,
          sourceHash: digest(source),
          attempts,
          nextCheckAt:
            attempts < 2
              ? new Date(
                  base + (attempts === 0 ? delay : 24 * 60 * minute),
                ).toISOString()
              : null,
        });
      },
    );
  }
  async refresh(raw: z.infer<typeof tiebaInsightsRefreshSchema>) {
    const input = tiebaInsightsRefreshSchema.parse(raw);
    const refreshResult: NonNullable<TiebaInsightsSnapshot["refreshResult"]> = {
      succeeded: [],
      failed: [],
    };
    const result = await this.operation(async () => {
      const defaultScope =
        input.targetIds === undefined && input.publicationIds === undefined;
      const targetIds = [
        ...new Set(
          input.targetIds ??
            (defaultScope
              ? this.targets
                  .targets()
                  .slice(0, 5)
                  .map((item) => item.id)
              : []),
        ),
      ];
      const sources = this.sources(),
        ids = [
          ...new Set(
            input.publicationIds ??
              (defaultScope ? sources.slice(0, 5).map((item) => item.id) : []),
          ),
        ];
      for (const id of targetIds) {
        try {
          await this.metric(id);
          this.alive();
          refreshResult.succeeded.push(id);
          this.logs.record({
            event: "metric.read",
            level: "info",
            message: "已保存一项官方等级与经验读数。",
          });
        } catch (error) {
          if (this.closed) throw error;
          refreshResult.failed.push({ id, message: safeMessage(error) });
          this.logs.record({
            event: "metric.failed",
            level: "warning",
            message: `等级读取未完成：${safeMessage(error)}`,
          });
        }
      }
      for (const id of ids) {
        const source = sources.find((item) => item.id === id);
        try {
          if (!source)
            throw new AppError("TIEBA_INSIGHTS_SOURCE", "原提交记录已不存在。");
          await this.visibility(source);
          this.alive();
          refreshResult.succeeded.push(id);
        } catch (error) {
          if (this.closed) throw error;
          refreshResult.failed.push({ id, message: safeMessage(error) });
          this.logs.record({
            event: "visibility.failed",
            level: "warning",
            message: `可见性复查未完成：${safeMessage(error)}；不据此判定删除或限制。`,
          });
        }
      }
    });
    return { ...result, busy: false, refreshResult };
  }
  start(enabled = true) {
    this.suspended = !enabled;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (enabled && !this.closed)
      this.timer = setInterval(() => {
        void this.tick().catch((error) => {
          if (!this.closed)
            this.logs.record({
              event: "review.failed",
              level: "warning",
              message: safeMessage(error),
            });
        });
      }, minute);
    this.timer?.unref?.();
  }
  async tick() {
    if (
      this.closed ||
      this.working ||
      this.suspended ||
      !this.settings().autoReview ||
      this.time() < this.nextTick
    )
      return;
    const expectedRevision = this.settings().revision;
    const source = this.sources().find((item) => {
      if (!item.threadId) return false;
      const r = this.reading(item.id, item);
      const next = r
        ? r.nextCheckAt
        : new Date(Date.parse(item.submittedAt) + delay).toISOString();
      return next && Date.parse(next) <= this.time();
    });
    if (!source) return;
    this.nextTick = this.time() + minute;
    const old = this.reading(source.id, source),
      at =
        old?.nextCheckAt ??
        new Date(Date.parse(source.submittedAt) + delay).toISOString();
    const deadline = Date.parse(at) + windowLength;
    const guard = () => {
      this.alive();
      const current = this.settings();
      if (
        this.suspended ||
        !current.autoReview ||
        current.revision !== expectedRevision
      )
        throw new AppError(
          "TIEBA_INSIGHTS_REVOKED",
          "自动复查授权已变化，旧排队读取已停止。",
        );
      if (this.time() >= deadline)
        throw new AppError(
          "TIEBA_INSIGHTS_EXPIRED",
          "本次延后复查窗口已结束，未追赶读取。",
        );
    };
    if (this.time() >= deadline) {
      this.finishReviewAttempt(
        source,
        old,
        "本次延后复查窗口已过，未集中追赶读取；后续独立时段或手动复查仍可使用。",
      );
      this.d.changed();
      return;
    }
    await this.operation(async () => {
      try {
        guard();
        await this.visibility(source, guard, true);
      } catch (error) {
        if (this.closed) throw error;
        if (
          error instanceof AppError &&
          error.code === "TIEBA_INSIGHTS_REVOKED"
        )
          return;
        this.finishReviewAttempt(
          source,
          old,
          `本次自动复查未完成：${safeMessage(error)}；保留上次官网证据及原提交状态。`,
        );
      }
    });
  }
  dispose() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}

export function stopTiebaInsightsForBackup(db: Database) {
  const current = db.setting(stateKey, { revision: 1, autoReview: false });
  db.setSetting(stateKey, {
    revision: current.revision + 1,
    autoReview: false,
  });
}

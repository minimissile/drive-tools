import {
  setImmediate as yieldLoop,
  setTimeout as wait,
} from "node:timers/promises";
import type { z } from "zod";
import {
  distributionPlatform,
  type DistributionPlatformId,
  type DistributionTask,
  type DistributionReadiness,
  type distributionListInput,
  type distributionResolveInput,
} from "../shared/distribution";
import { Database, now } from "./database";
import { AppError, safeMessage } from "./errors";
import { parseShare } from "./links";
import type { AppPorts } from "./ports";
import { DistributionStore } from "./distribution/store";
import {
  libraryShareCounts,
  shareSource,
  shareSourcePage,
  type ShareSource,
} from "./distribution/sources";

/** Platform-local durable queues. Only explicit Prepare/Start may access remote websites. */
export class Distribution {
  private store: DistributionStore;
  private jobs = new Map<DistributionPlatformId, AbortController>();
  private closed = false;
  constructor(
    private db: Database,
    private ports: AppPorts,
    private link: (source: ShareSource) => Promise<string>,
    private changed: () => void,
  ) {
    this.store = new DistributionStore(db);
    this.store.recover();
  }
  get isBusy() {
    return this.jobs.size > 0;
  }
  overview() {
    return {
      library: libraryShareCounts(this.db),
      platforms: this.store.summary(),
    };
  }
  list(input: z.output<typeof distributionListInput>) {
    return { ...this.store.list(input), platformId: input.platformId };
  }
  history(taskId: string, page: number) {
    return this.store.history(taskId, page);
  }
  batches(platformId: DistributionPlatformId, page: number) {
    return this.store.batches(platformId, page);
  }
  prepare(platformId: DistributionPlatformId) {
    return this.launch(platformId, async (signal) => {
      await this.scan(platformId, signal);
      signal.throwIfAborted();
      const readiness = await this.inspect(platformId);
      if (this.closed) return;
      signal.throwIfAborted();
      const unresolved = this.db.get<{ n: number }>(
        "SELECT COUNT(*) n FROM distribution_tasks WHERE platform_id=? AND status='uncertain'",
        platformId,
      )!.n;
      this.store.state(
        platformId,
        readiness.status === "ready" && !unresolved ? "ready" : "blocked",
        unresolved
          ? `有 ${unresolved} 条提交结果待核对，核对前不会继续自动分发。`
          : readiness.message,
        readiness,
      );
    });
  }
  start(platformId: DistributionPlatformId) {
    const run = this.store.run(platformId);
    const readiness = run.readiness
      ? (JSON.parse(run.readiness) as DistributionReadiness)
      : null;
    if (run.scan_kind !== "done" || readiness?.status !== "ready")
      throw new AppError(
        "DISTRIBUTION_NOT_READY",
        "请先准备全库链接，并完成当前平台登录与规则检查。",
      );
    if (
      this.db.get(
        "SELECT id FROM distribution_tasks WHERE platform_id=? AND status='uncertain' LIMIT 1",
        platformId,
      )
    )
      throw new AppError(
        "DISTRIBUTION_UNCERTAIN",
        "请先核对未知结果，避免重复提交。",
      );
    return this.launch(platformId, (signal) => this.work(platformId, signal));
  }
  pause(platformId: DistributionPlatformId) {
    const controller = this.jobs.get(platformId);
    if (controller) {
      this.store.state(
        platformId,
        "pausing",
        "正在暂停；已经发出的请求会等候回执，不会重复发送。",
      );
      controller.abort();
      this.changed();
    }
    return true;
  }
  retry(platformId: DistributionPlatformId) {
    this.assertIdle(platformId);
    let updated = 0;
    this.db.transaction(() => {
      const at = now(),
        note = "用户要求重试明确失败项，尚未重新投稿。";
      this.db.run(
        "INSERT INTO distribution_events(task_id,status,note,at) SELECT id,'ready',?,? FROM distribution_tasks WHERE platform_id=? AND status IN ('failed','rejected')",
        note,
        at,
        platformId,
      );
      updated = Number(
        this.db.run(
          "UPDATE distribution_tasks SET status='ready',message=?,updated_at=? WHERE platform_id=? AND status IN ('failed','rejected')",
          note,
          at,
          platformId,
        ).changes,
      );
    });
    this.store.state(
      platformId,
      "paused",
      "明确失败项已重新入队，点击自动分发继续。未知结果不会重试。",
    );
    this.changed();
    return { updated };
  }
  resolve(input: z.output<typeof distributionResolveInput>) {
    const task = this.store.get(input.taskId);
    this.assertIdle(task.platformId);
    if (task.status === "published" && input.status !== "published")
      throw new AppError(
        "DISTRIBUTION_FINISHED",
        "已收录记录不能改回待分发或失败。",
      );
    if (["ready", "blocked", "verifying", "submitting"].includes(task.status))
      throw new AppError(
        "DISTRIBUTION_NOT_SENT",
        "这条记录尚未完成自动提交，请先启动分发；未发出的任务不能回填成功。",
      );
    if (input.url) {
      let url: URL;
      try {
        url = new URL(input.url);
      } catch {
        throw new AppError("INVALID_LINK", "请填写当前平台的 HTTPS 结果链接。");
      }
      const host = distributionPlatform(task.platformId).host.replace(
        /^www\./,
        "",
      );
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        ![host, `www.${host}`].includes(url.hostname)
      )
        throw new AppError("INVALID_LINK", "结果链接必须属于当前平台。");
    }
    this.db.transaction(() => {
      this.store.event(
        task.id,
        input.status,
        input.note,
        input.receipt,
        input.url,
      );
      this.store.reconcileBatch(task.batchId);
    });
    this.changed();
    return true;
  }
  close() {
    this.closed = true;
    for (const controller of this.jobs.values()) controller.abort();
  }
  private assertIdle(platformId: DistributionPlatformId) {
    if (this.closed) throw new AppError("CLOSED", "工作空间正在关闭。");
    if (this.jobs.has(platformId))
      throw new AppError(
        "DISTRIBUTION_BUSY",
        "该平台仍有任务，请先暂停并等待当前批次回执。",
      );
  }
  private launch(
    platformId: DistributionPlatformId,
    action: (signal: AbortSignal) => Promise<void>,
  ) {
    this.assertIdle(platformId);
    const controller = new AbortController();
    this.jobs.set(platformId, controller);
    void action(controller.signal)
      .catch((error) => {
        if (!this.closed)
          this.store.state(
            platformId,
            controller.signal.aborted ? "paused" : "blocked",
            controller.signal.aborted
              ? "已暂停，断点已保存在本地。已提交记录不会重复分发。"
              : safeMessage(error),
          );
      })
      .finally(() => {
        this.jobs.delete(platformId);
        if (!this.closed) this.changed();
      });
    this.changed();
    return true;
  }
  private async scan(platformId: DistributionPlatformId, signal: AbortSignal) {
    const previous = this.store.run(platformId);
    if (previous.scan_kind === "done" || previous.scanned === 0)
      this.db.run(
        `UPDATE distribution_runs SET state='scanning',scan_kind='copy',scan_cursor=0,scanned=0,copy_ceiling=(SELECT COALESCE(MAX(rowid),0) FROM copies),split_ceiling=(SELECT COALESCE(MAX(rowid),0) FROM split_items),readiness=NULL,updated_at=? WHERE platform_id=?`,
        now(),
        platformId,
      );
    else
      this.store.state(
        platformId,
        "scanning",
        "正在从上次扫描断点继续准备全库链接…",
        null,
      );
    while (!this.closed) {
      signal.throwIfAborted();
      const run = this.store.run(platformId);
      if (run.scan_kind === "done") return;
      const rows = shareSourcePage(
        this.db,
        run.scan_kind,
        run.scan_cursor,
        run.scan_kind === "copy" ? run.copy_ceiling : run.split_ceiling,
      );
      this.db.transaction(() => {
        this.store.beginChunk();
        for (const source of rows) this.store.sync(source, platformId);
        this.db.run(
          "UPDATE distribution_runs SET state='scanning',scan_cursor=?,scanned=scanned+?,scan_kind=?,message=?,updated_at=? WHERE platform_id=?",
          rows.length < 250 ? 0 : rows.at(-1)!.sourceRow,
          rows.length,
          rows.length < 250
            ? run.scan_kind === "copy"
              ? "split"
              : "done"
            : run.scan_kind,
          `已扫描 ${run.scanned + rows.length} 条分享记录，按分享 ID 去重入队。`,
          now(),
          platformId,
        );
      });
      this.changed();
      await yieldLoop();
    }
  }
  private async inspect(
    platformId: DistributionPlatformId,
  ): Promise<DistributionReadiness> {
    if (distributionPlatform(platformId).format === "unverified")
      return {
        status: "rules_required",
        message:
          "盘库吧登录后的投稿规则尚未核实，自动分发暂不可用；可以先完成全库入队。",
        checkedAt: now(),
      };
    if (!this.ports.distributionSessions)
      return {
        status: "unavailable",
        message: "当前运行环境不支持平台自动分发。",
        checkedAt: now(),
      };
    return this.ports.distributionSessions.inspect(platformId);
  }
  private current(task: DistributionTask) {
    const usable = (recordId: string) => {
      const source = shareSource(this.db, recordId);
      if (!source?.eligible || !source.shareUrl) return undefined;
      try {
        return parseShare(source.shareUrl).url === task.shareUrl &&
          (recordId !== task.shareRecordId ||
            source.shareVersion === task.shareVersion)
          ? source
          : undefined;
      } catch {
        return undefined;
      }
    };
    const primary = usable(task.shareRecordId);
    if (primary) return primary;
    let cursor = "";
    while (true) {
      const aliases = this.db.all<{ share_record_id: string }>(
        "SELECT share_record_id FROM distribution_task_sources WHERE task_id=? AND active=1 AND share_record_id>? ORDER BY share_record_id LIMIT 100",
        task.id,
        cursor,
      );
      for (const alias of aliases) {
        const source = usable(alias.share_record_id);
        if (source) return source;
      }
      if (aliases.length < 100) break;
      cursor = aliases.at(-1)!.share_record_id;
    }
    throw new AppError(
      "DISTRIBUTION_SHARE_CHANGED",
      "本人分享已变化或未就绪。请修复资源库后重新准备全库链接。",
    );
  }
  private async work(platformId: DistributionPlatformId, signal: AbortSignal) {
    this.store.state(platformId, "running", "正在检查平台登录与提交表单…");
    const readiness = await this.inspect(platformId);
    if (this.closed) return;
    signal.throwIfAborted();
    if (readiness.status !== "ready") {
      this.store.state(platformId, "blocked", readiness.message, readiness);
      return;
    }
    const platform = distributionPlatform(platformId);
    this.db.run(
      "UPDATE distribution_runs SET state='running',started_at=?,readiness=?,updated_at=? WHERE platform_id=?",
      now(),
      JSON.stringify(readiness),
      now(),
      platformId,
    );
    while (!this.closed) {
      signal.throwIfAborted();
      const summary = this.store
        .summary()
        .find((item) => item.platform.id === platformId)!;
      const remaining = platform.dailyLimit
        ? Math.max(0, platform.dailyLimit - summary.submittedToday)
        : 100;
      if (!remaining) {
        this.store.state(
          platformId,
          "paused",
          "本地近 24 小时提交次数已达平台限额，保留断点，稍后继续。",
        );
        return;
      }
      const tasks = this.store.next(
        platformId,
        Math.min(100, platform.batchLimit ?? 1, remaining),
      );
      if (!tasks.length) {
        this.store.state(
          platformId,
          "completed",
          `本轮待分发队列已处理完：${summary.failed} 条失败、${summary.blocked} 条分享未就绪、${summary.skipped} 条规则跳过或历史旧链接。已提交仍需平台处理或审核。`,
        );
        return;
      }
      const batchId = this.store.createBatch(platformId, tasks),
        ready: DistributionTask[] = [],
        lines: string[] = [];
      let sent = false;
      try {
        for (const task of tasks) {
          signal.throwIfAborted();
          try {
            if (platformId === "repanso") {
              if (
                this.store.resourceConflict(
                  task.id,
                  ready.map((item) => item.id),
                )
              ) {
                this.store.event(
                  task.id,
                  "skipped",
                  "热盘搜禁止同一资源生成多个链接重复提交；已跳过此链接变体，保留资源与分享 ID 记录。",
                );
                continue;
              }
            }
            const source = this.current(task),
              raw = await this.link(source);
            if (this.closed) return;
            signal.throwIfAborted();
            this.current(task);
            const share = parseShare(raw),
              url = new URL(share.url);
            if (share.url !== task.shareUrl)
              throw new AppError(
                "DISTRIBUTION_SHARE_CHANGED",
                "核验返回了不同分享，已停止该条分发。",
              );
            if (share.code)
              url.searchParams.set(
                share.provider === "guangya" ? "code" : "pwd",
                share.code,
              );
            if (
              lines.join("\n").length + url.href.length + 1 >
              (platform.characterLimit ?? 50000)
            ) {
              this.store.event(
                task.id,
                "ready",
                "本批已达字符限制，留待下一批。",
              );
              continue;
            }
            ready.push(task);
            lines.push(url.href);
            this.store.state(
              platformId,
              "running",
              `正在核验本批本人分享 ${ready.length}/${tasks.length}，已提交 ${summary.submitted + summary.processing + summary.reviewing + summary.published} 条。`,
            );
            this.changed();
          } catch (error) {
            if (this.closed) return;
            signal.throwIfAborted();
            this.store.event(task.id, "blocked", safeMessage(error));
          }
        }
        signal.throwIfAborted();
        if (!ready.length) {
          this.store.finishBatch(
            batchId,
            [],
            "skipped",
            "本批没有通过核验的分享，未向平台提交。",
          );
          continue;
        }
        const response = await this.ports.distributionSessions!.submit(
          platformId,
          lines.join("\n"),
          async () => {
            if (this.closed) throw new AppError("CLOSED", "工作空间已关闭。");
            signal.throwIfAborted();
            for (const task of ready) this.current(task);
            const used = this.store
              .summary()
              .find((item) => item.platform.id === platformId)!.submittedToday;
            if (
              platform.dailyLimit &&
              used + ready.length > platform.dailyLimit
            )
              throw new AppError(
                "DISTRIBUTION_LIMIT",
                "本批将超过平台每日限额，已停止发送。",
              );
            this.store.sent(batchId, ready);
            sent = true;
            this.changed();
          },
          signal,
        );
        if (this.closed) return;
        if (response.status === "accepted" && !sent)
          throw new AppError(
            "DISTRIBUTION_CHECKPOINT",
            "平台未经过提交检查点，无法确认结果。",
          );
        const status =
          response.status === "accepted"
            ? "submitted"
            : response.status === "uncertain"
              ? sent
                ? "uncertain"
                : "ready"
              : sent
                ? "failed"
                : "ready";
        this.store.finishBatch(
          batchId,
          ready,
          status,
          response.message,
          response.receipt,
        );
        this.changed();
        if (response.status !== "accepted") {
          this.store.state(
            platformId,
            "blocked",
            response.message,
            response.status === "login_required"
              ? {
                  status: "login_required",
                  message: response.message,
                  checkedAt: now(),
                }
              : response.status === "verification_required"
                ? {
                    status: "verification_required",
                    message: response.message,
                    checkedAt: now(),
                  }
                : undefined,
          );
          return;
        }
      } catch (error) {
        if (this.closed) return;
        const message = sent
          ? "提交请求结果未知，请先在官网核对本批记录，禁止自动重投。"
          : signal.aborted
            ? "已暂停，尚未发送的记录保留待分发。"
            : safeMessage(error);
        const outstanding = tasks.filter((task) =>
          ["verifying", "submitting"].includes(this.store.get(task.id).status),
        );
        this.store.finishBatch(
          batchId,
          outstanding,
          sent ? "uncertain" : "ready",
          message,
        );
        throw new AppError(
          sent ? "DISTRIBUTION_UNCERTAIN" : "DISTRIBUTION_STOPPED",
          message,
        );
      }
      signal.throwIfAborted();
      await wait(5000, undefined, { signal });
    }
  }
}

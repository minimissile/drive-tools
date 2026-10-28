import type {
  DistributionPlatformId,
  DistributionPlatformSummary,
  DistributionTask,
  DistributionStatus,
  DistributionReadiness,
  DistributionRunState,
  DistributionBatch,
  DistributionEvent,
  DistributionPage,
} from "../../shared/distribution";
import { distributionPlatforms } from "../../shared/distribution";
import { Database, id, now } from "../database";
import { AppError } from "../errors";
import { parseShare } from "../links";
import { shareSource, type ShareSource } from "./sources";

export interface RunRow {
  platform_id: DistributionPlatformId;
  state: DistributionRunState;
  scan_kind: "copy" | "split" | "done";
  scan_cursor: number;
  copy_ceiling: number;
  split_ceiling: number;
  scanned: number;
  readiness: string | null;
  message: string;
  started_at: string | null;
  updated_at: string;
}
const taskColumns = `id,platform_id platformId,share_record_id shareRecordId,resource_id resourceId,
  copy_id copyId,split_item_id splitItemId,title,provider,share_url shareUrl,share_version shareVersion,
  status,message,batch_id batchId,submitted_at submittedAt,created_at createdAt,updated_at updatedAt`;
const pending = new Set<DistributionStatus>([
  "ready",
  "blocked",
  "waiting_login",
  "waiting_rules",
]);

export class DistributionStore {
  private availability = new Map<string, boolean>();
  constructor(readonly db: Database) {}
  beginChunk() {
    this.availability.clear();
  }
  private usableAlias(task: DistributionTask) {
    const cached = this.availability.get(task.id);
    if (cached !== undefined) return cached;
    let cursor = "";
    while (true) {
      const rows = this.db.all<{ share_record_id: string }>(
        "SELECT share_record_id FROM distribution_task_sources WHERE task_id=? AND active=1 AND share_record_id>? ORDER BY share_record_id LIMIT 100",
        task.id,
        cursor,
      );
      for (const row of rows) {
        const source = shareSource(this.db, row.share_record_id);
        if (!source?.eligible || !source.shareUrl) continue;
        try {
          if (parseShare(source.shareUrl).url === task.shareUrl) {
            this.availability.set(task.id, true);
            return true;
          }
        } catch {}
      }
      if (rows.length < 100) break;
      cursor = rows.at(-1)!.share_record_id;
    }
    this.availability.set(task.id, false);
    return false;
  }
  recover() {
    this.db.transaction(() => {
      const at = now();
      for (const platform of distributionPlatforms)
        this.db.run(
          "INSERT OR IGNORE INTO distribution_runs(platform_id,updated_at) VALUES(?,?)",
          platform.id,
          at,
        );
      this.db.run(
        "UPDATE distribution_tasks SET status='uncertain',message=?,updated_at=? WHERE status='submitting'",
        "程序中断时提交结果未知，请先核对官网回执，禁止自动重投。",
        at,
      );
      this.db.run(
        "UPDATE distribution_tasks SET status='ready',batch_id=NULL,updated_at=? WHERE status='verifying'",
        at,
      );
      this.db.run(
        "UPDATE distribution_batches SET status='uncertain',message=?,completed_at=? WHERE status='submitting'",
        "程序中断，结果待核对。",
        at,
      );
      this.db.run(
        "UPDATE distribution_batches SET status='paused',completed_at=? WHERE status='preparing'",
        at,
      );
      this.db.run(
        "UPDATE distribution_runs SET state='paused',readiness=NULL,message=?,updated_at=? WHERE state IN ('running','scanning','pausing','ready')",
        "程序已重启。请准备全库链接并检查登录后继续；不会自动开始远端投稿。",
        at,
      );
    });
  }
  run(platformId: DistributionPlatformId): RunRow {
    return this.db.get<RunRow>(
      "SELECT * FROM distribution_runs WHERE platform_id=?",
      platformId,
    )!;
  }
  state(
    platformId: DistributionPlatformId,
    state: DistributionRunState,
    message: string,
    readiness?: DistributionReadiness | null,
  ) {
    this.run(platformId);
    if (readiness === undefined)
      this.db.run(
        "UPDATE distribution_runs SET state=?,message=?,updated_at=? WHERE platform_id=?",
        state,
        message,
        now(),
        platformId,
      );
    else
      this.db.run(
        "UPDATE distribution_runs SET state=?,message=?,readiness=?,updated_at=? WHERE platform_id=?",
        state,
        message,
        readiness ? JSON.stringify(readiness) : null,
        now(),
        platformId,
      );
  }
  summary(): DistributionPlatformSummary[] {
    const since = new Date(Date.now() - 86400000).toISOString();
    return distributionPlatforms.map((platform) => {
      const run = this.run(platform.id);
      const counts: Record<string, number> = Object.fromEntries(
        this.db
          .all<{ status: string; n: number }>(
            "SELECT status,COUNT(*) n FROM distribution_tasks WHERE platform_id=? GROUP BY status",
            platform.id,
          )
          .map((row) => [row.status, row.n]),
      );
      const settings = this.db.setting(`distribution:${platform.id}`, {
        alias: "",
        note: "",
      });
      return {
        platform,
        ...settings,
        historyTotal: Object.values(counts).reduce((a, b) => a + b, 0),
        total: this.db.get<{ n: number }>(
          "SELECT COUNT(*) n FROM distribution_tasks WHERE platform_id=? AND (status NOT IN ('skipped','superseded') OR accepted_at IS NOT NULL)",
          platform.id,
        )!.n,
        delivered: this.db.get<{ n: number }>(
          "SELECT COUNT(*) n FROM distribution_tasks WHERE platform_id=? AND accepted_at IS NOT NULL",
          platform.id,
        )!.n,
        pending: counts.ready ?? 0,
        published: counts.published ?? 0,
        submitted: counts.submitted ?? 0,
        processing: counts.processing ?? 0,
        reviewing: counts.reviewing ?? 0,
        failed: (counts.failed ?? 0) + (counts.rejected ?? 0),
        uncertain: counts.uncertain ?? 0,
        blocked:
          (counts.blocked ?? 0) +
          (counts.waiting_login ?? 0) +
          (counts.waiting_rules ?? 0),
        skipped: (counts.skipped ?? 0) + (counts.superseded ?? 0),
        active: (counts.verifying ?? 0) + (counts.submitting ?? 0),
        resourceCount: this.db.get<{ n: number }>(
          "SELECT COUNT(DISTINCT resource_id) n FROM distribution_task_sources WHERE platform_id=?",
          platform.id,
        )!.n,
        submittedToday: this.db.get<{ n: number }>(
          "SELECT COUNT(*) n FROM distribution_attempts WHERE platform_id=? AND sent_at>=?",
          platform.id,
          since,
        )!.n,
        readiness: run.readiness
          ? (JSON.parse(run.readiness) as DistributionReadiness)
          : null,
        run: {
          state: run.state,
          scanned: run.scanned,
          message: run.message,
          updatedAt: run.updated_at,
          startedAt: run.started_at,
        },
      };
    });
  }
  get(taskId: string) {
    const task = this.db.get<DistributionTask>(
      `SELECT ${taskColumns} FROM distribution_tasks WHERE id=?`,
      taskId,
    );
    if (!task) throw new AppError("NOT_FOUND", "分发记录不存在，请刷新列表。");
    return task;
  }
  event(
    taskId: string,
    status: DistributionStatus,
    note: string,
    receipt = "",
    url = "",
  ) {
    if (["submitted", "processing", "reviewing", "published"].includes(status))
      this.db.run(
        "UPDATE distribution_tasks SET accepted_at=COALESCE(accepted_at,?),submitted_at=COALESCE(submitted_at,?) WHERE id=?",
        now(),
        now(),
        taskId,
      );
    this.db.run(
      "UPDATE distribution_tasks SET status=?,message=?,updated_at=? WHERE id=?",
      status,
      note.slice(0, 2000),
      now(),
      taskId,
    );
    this.db.run(
      "INSERT INTO distribution_events(task_id,status,note,receipt,url,at) VALUES(?,?,?,?,?,?)",
      taskId,
      status,
      note.slice(0, 2000),
      receipt.slice(0, 500),
      url.slice(0, 2000),
      now(),
    );
  }
  sync(source: ShareSource, platformId: DistributionPlatformId) {
    const binding = this.db.get<{ task_id: string }>(
      "SELECT task_id FROM distribution_task_sources WHERE platform_id=? AND share_record_id=? AND active=1",
      platformId,
      source.shareRecordId,
    );
    if (!source.eligible || !source.shareUrl) {
      if (binding) {
        const task = this.get(binding.task_id);
        if (
          pending.has(task.status) &&
          task.status !== "blocked" &&
          !this.usableAlias(task)
        )
          this.event(
            task.id,
            "blocked",
            "该本人分享当前未就绪，未向平台提交。修复后重新准备全库链接。",
          );
      }
      return;
    }
    let share;
    try {
      share = parseShare(source.shareUrl);
    } catch {
      if (
        binding &&
        this.get(binding.task_id).status !== "blocked" &&
        pending.has(this.get(binding.task_id).status) &&
        !this.usableAlias(this.get(binding.task_id))
      )
        this.event(
          binding.task_id,
          "blocked",
          "本人分享地址无法识别，请先在资源库修复。",
        );
      return;
    }
    const shareKey = `${share.provider}:${share.shareKey}`;
    if (binding) {
      const task = this.get(binding.task_id);
      if (task.shareUrl !== share.url) {
        if (["uncertain", "submitting", "verifying"].includes(task.status))
          return;
        // Preserve the historical association while moving the current source to its new URL.
        this.db.run(
          "UPDATE distribution_task_sources SET active=0 WHERE platform_id=? AND share_record_id=? AND active=1",
          platformId,
          source.shareRecordId,
        );
        if (
          !task.submittedAt &&
          !this.db.get(
            "SELECT 1 FROM distribution_task_sources WHERE task_id=? AND active=1 LIMIT 1",
            task.id,
          )
        )
          this.event(
            task.id,
            "superseded",
            "尚未投稿的旧链接已被资源库中的新分享替换。",
          );
      } else {
        if (
          pending.has(task.status) ||
          ["failed", "rejected"].includes(task.status)
        ) {
          if (source.shareRecordId === task.shareRecordId)
            this.db.run(
              "UPDATE distribution_tasks SET share_version=?,updated_at=? WHERE id=?",
              source.shareVersion,
              now(),
              task.id,
            );
          if (task.status === "blocked")
            this.event(task.id, "ready", "本人分享已恢复，等待自动分发。");
        }
        return;
      }
    }
    let task = this.db.get<{ id: string }>(
      "SELECT id FROM distribution_tasks WHERE platform_id=? AND share_key=?",
      platformId,
      shareKey,
    );
    if (!task) {
      const taskId = id("distribution"),
        at = now();
      this.db.run(
        `INSERT INTO distribution_tasks(id,platform_id,share_record_id,resource_id,copy_id,split_item_id,title,provider,share_key,share_url,share_version,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'ready',?,?)`,
        taskId,
        platformId,
        source.shareRecordId,
        source.resourceId,
        source.copyId,
        source.splitItemId,
        source.title,
        source.provider,
        shareKey,
        share.url,
        source.shareVersion,
        at,
        at,
      );
      task = { id: taskId };
      this.event(taskId, "ready", "已从资源库全量扫描入队，尚未投稿。");
    }
    this.db.run(
      "INSERT INTO distribution_task_sources VALUES(?,?,?,?,?,?,1) ON CONFLICT(task_id,share_record_id) DO UPDATE SET active=1",
      platformId,
      source.shareRecordId,
      task.id,
      source.resourceId,
      source.copyId,
      source.splitItemId,
    );
    this.availability.set(task.id, true);
    const rebound = this.get(task.id);
    if (rebound.status === "superseded" && !rebound.submittedAt) {
      this.db.run(
        "UPDATE distribution_tasks SET share_version=? WHERE id=?",
        source.shareVersion,
        task.id,
      );
      this.event(task.id, "ready", "此前未提交的分享重新出现，已恢复待分发。");
    }
  }
  list(input: {
    platformId: DistributionPlatformId;
    status: string;
    query: string;
    page: number;
  }): DistributionPage<DistributionTask> {
    const clauses = ["platform_id=?"],
      values: (string | number)[] = [input.platformId];
    if (input.status !== "all") {
      clauses.push("status=?");
      values.push(input.status);
    }
    if (input.query.trim()) {
      clauses.push(
        "(title LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM distribution_task_sources s WHERE s.task_id=distribution_tasks.id AND (s.resource_id=? OR s.share_record_id=?)))",
      );
      values.push(
        `%${input.query.trim().replace(/[\\%_]/g, "\\$&")}%`,
        input.query.trim(),
        input.query.trim(),
      );
    }
    const where = clauses.join(" AND "),
      total = this.db.get<{ n: number }>(
        `SELECT COUNT(*) n FROM distribution_tasks WHERE ${where}`,
        ...values,
      )!.n;
    const pageSize = 20,
      page = Math.min(input.page, Math.max(1, Math.ceil(total / pageSize)));
    return {
      total,
      page,
      pageSize,
      items: this.db.all<DistributionTask>(
        `SELECT ${taskColumns} FROM distribution_tasks WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
        ...values,
        pageSize,
        (page - 1) * pageSize,
      ),
    };
  }
  history(taskId: string, page: number): DistributionPage<DistributionEvent> {
    this.get(taskId);
    const total = this.db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM distribution_events WHERE task_id=?",
      taskId,
    )!.n;
    const pageSize = 20,
      actual = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
    return {
      total,
      page: actual,
      pageSize,
      items: this.db.all<DistributionEvent>(
        "SELECT id,at,status,note,receipt,url FROM distribution_events WHERE task_id=? ORDER BY id DESC LIMIT ? OFFSET ?",
        taskId,
        pageSize,
        (actual - 1) * pageSize,
      ),
    };
  }
  batches(
    platformId: DistributionPlatformId,
    page: number,
  ): DistributionPage<DistributionBatch> {
    const total = this.db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM distribution_batches WHERE platform_id=?",
      platformId,
    )!.n;
    const pageSize = 20,
      actual = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
    return {
      total,
      page: actual,
      pageSize,
      items: this.db.all<DistributionBatch>(
        "SELECT id,status,item_count count,message,receipt,created_at createdAt,submitted_at submittedAt,completed_at completedAt FROM distribution_batches WHERE platform_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
        platformId,
        pageSize,
        (actual - 1) * pageSize,
      ),
    };
  }
  reconcileBatch(batchId: string | null) {
    if (!batchId) return;
    const unresolved = this.db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM distribution_batch_items i JOIN distribution_tasks t ON t.id=i.task_id WHERE i.batch_id=? AND t.status IN ('uncertain','submitting')",
      batchId,
    )!.n;
    if (!unresolved)
      this.db.run(
        "UPDATE distribution_batches SET status='checked',message=?,completed_at=? WHERE id=? AND status='uncertain'",
        "本批未知结果已逐条核对，实际结果见逐条分发记录。",
        now(),
        batchId,
      );
  }
  next(platformId: DistributionPlatformId, limit: number) {
    return this.db.all<DistributionTask>(
      `SELECT ${taskColumns} FROM distribution_tasks WHERE platform_id=? AND status='ready' ORDER BY created_at,id LIMIT ?`,
      platformId,
      limit,
    );
  }
  resourceConflict(taskId: string, readyIds: string[]) {
    const current = readyIds.length
      ? ` OR prior.id IN (${readyIds.map(() => "?").join(",")})`
      : "";
    return !!this.db.get(
      `SELECT 1 FROM distribution_task_sources incoming
      JOIN distribution_task_sources existing ON existing.platform_id=incoming.platform_id AND existing.resource_id=incoming.resource_id AND existing.split_item_id IS NULL
      JOIN distribution_tasks prior ON prior.id=existing.task_id
      WHERE incoming.task_id=? AND incoming.split_item_id IS NULL AND existing.task_id!=incoming.task_id
      AND (prior.accepted_at IS NOT NULL${current}) LIMIT 1`,
      taskId,
      ...readyIds,
    );
  }
  createBatch(platformId: DistributionPlatformId, tasks: DistributionTask[]) {
    const batchId = id("distribution_batch");
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO distribution_batches(id,platform_id,status,item_count,created_at) VALUES(?,?,'preparing',?,?)",
        batchId,
        platformId,
        tasks.length,
        now(),
      );
      for (const task of tasks) {
        this.db.run(
          "INSERT INTO distribution_batch_items VALUES(?,?)",
          batchId,
          task.id,
        );
        this.db.run(
          "UPDATE distribution_tasks SET batch_id=? WHERE id=?",
          batchId,
          task.id,
        );
        this.event(task.id, "verifying", "正在核验本人分享，尚未向平台提交。");
      }
    });
    return batchId;
  }
  sent(batchId: string, tasks: DistributionTask[]) {
    const at = now();
    this.db.transaction(() => {
      this.retainMembers(batchId, tasks);
      this.db.run(
        "UPDATE distribution_batches SET status='submitting',submitted_at=?,item_count=? WHERE id=?",
        at,
        tasks.length,
        batchId,
      );
      for (const task of tasks) {
        this.event(task.id, "submitting", "提交请求即将发出，等待平台回执。");
        this.db.run(
          "INSERT INTO distribution_attempts VALUES(?,?,?,?,?)",
          `${batchId}:${task.id}`,
          task.platformId,
          task.id,
          batchId,
          at,
        );
      }
    });
  }
  finishBatch(
    batchId: string,
    tasks: DistributionTask[],
    status: DistributionStatus,
    message: string,
    receipt = "",
  ) {
    const at = now();
    this.db.transaction(() => {
      this.retainMembers(batchId, tasks);
      this.db.run(
        "UPDATE distribution_batches SET status=?,message=?,receipt=?,completed_at=?,item_count=? WHERE id=?",
        status,
        message.slice(0, 2000),
        receipt.slice(0, 500),
        at,
        tasks.length,
        batchId,
      );
      for (const task of tasks) {
        this.event(task.id, status, message, receipt);
        if (
          [
            "submitted",
            "processing",
            "reviewing",
            "published",
            "uncertain",
          ].includes(status)
        )
          this.db.run(
            "UPDATE distribution_tasks SET submitted_at=COALESCE(submitted_at,?) WHERE id=?",
            at,
            task.id,
          );
      }
    });
  }
  private retainMembers(batchId: string, tasks: DistributionTask[]) {
    const selected = tasks.map((task) => task.id);
    const condition = selected.length
      ? ` AND id NOT IN (${selected.map(() => "?").join(",")})`
      : "";
    this.db.run(
      `UPDATE distribution_tasks SET batch_id=NULL WHERE batch_id=?${condition}`,
      batchId,
      ...selected,
    );
    const memberCondition = selected.length
      ? ` AND task_id NOT IN (${selected.map(() => "?").join(",")})`
      : "";
    this.db.run(
      `DELETE FROM distribution_batch_items WHERE batch_id=?${memberCondition}`,
      batchId,
      ...selected,
    );
  }
}

import { Database, id, now } from "./database";
import { AppError, safeMessage } from "./errors";
import type { BrowserEnvironments } from "./browser-environments";
import type {
  EnvironmentAccountRef,
  EnvironmentJob,
} from "../shared/browser-environments";

type Pending = {
  job: EnvironmentJob;
  action: () => Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  abort?: () => void;
};
/** Queue only explicit commands. Restart recovery records attention and never resumes a publish. */
export class BrowserEnvironmentQueue {
  private pending: Pending[] = [];
  private running = 0;
  private closed = false;
  private unsubscribe: () => void;
  constructor(
    private db: Database,
    private environments: BrowserEnvironments,
    private changed: () => void,
    private concurrency = 2,
  ) {
    for (const row of db.all<{ data: string }>(
      "SELECT data FROM browser_environment_jobs WHERE status IN ('queued','running')",
    )) {
      const job: EnvironmentJob = JSON.parse(row.data);
      this.save({
        ...job,
        status: "attention",
        message: "上次调度已中断，请在对应业务核对并手动继续；不会自动重发。",
      });
    }
    environments.setQueuedBusy((environmentId) =>
      this.pending.some((p) => p.job.environmentIds.includes(environmentId)),
    );
    this.unsubscribe = environments.onRelease(() => this.drain());
  }
  get isBusy() {
    return this.running > 0 || this.pending.length > 0;
  }
  list(): EnvironmentJob[] {
    return this.db
      .all<{ data: string }>(
        "SELECT data FROM browser_environment_jobs ORDER BY rowid DESC LIMIT 50",
      )
      .map((row) => JSON.parse(row.data));
  }
  private save(job: EnvironmentJob) {
    if (this.closed) return;
    job.updatedAt = now();
    this.db.run(
      "INSERT INTO browser_environment_jobs(id,status,data,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,updated_at=excluded.updated_at",
      job.id,
      job.status,
      JSON.stringify(job),
      job.createdAt,
      job.updatedAt,
    );
    this.changed();
  }
  schedule<T>(
    accounts: EnvironmentAccountRef[],
    label: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(
        new AppError("ENVIRONMENT_QUEUE_CLOSED", "环境调度已停止。"),
      );
    if (this.pending.length >= 100)
      return Promise.reject(
        new AppError(
          "ENVIRONMENT_QUEUE_FULL",
          "已有100项环境操作排队，请完成后再提交。",
        ),
      );
    signal?.throwIfAborted();
    const time = now(),
      job: EnvironmentJob = {
        id: id("envjob"),
        label,
        environmentIds: [
          ...new Set(
            accounts.map((ref) => this.environments.forAccount(ref).id),
          ),
        ],
        accounts,
        status: "queued",
        message: "等待关联环境空闲",
        createdAt: time,
        updatedAt: time,
      };
    this.save(job);
    const result = new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        job,
        action,
        resolve: (value) => resolve(value as T),
        reject,
        signal,
      };
      pending.abort = () => {
        if (this.pending.includes(pending)) this.cancel(job.id);
      };
      signal?.addEventListener("abort", pending.abort, { once: true });
      this.pending.push(pending);
    });
    this.drain();
    return result;
  }
  cancel(jobId: string) {
    const index = this.pending.findIndex((p) => p.job.id === jobId);
    if (index < 0)
      throw new AppError(
        "ENVIRONMENT_JOB_NOT_QUEUED",
        "此操作已开始或已结束；执行中的操作请在对应业务停止并核对结果。",
      );
    const [pending] = this.pending.splice(index, 1);
    if (pending.abort)
      pending.signal?.removeEventListener("abort", pending.abort);
    this.save({
      ...pending.job,
      status: "cancelled",
      message: "已取消排队，尚未执行平台操作。",
    });
    pending.reject(
      new AppError(
        "ENVIRONMENT_JOB_CANCELLED",
        "已取消排队，尚未执行平台操作。",
      ),
    );
    this.drain();
    return true;
  }
  private drain() {
    if (this.closed) return;
    while (this.running < this.concurrency) {
      const index = this.pending.findIndex((pending) =>
        this.environments.available(pending.job.environmentIds),
      );
      if (index < 0) break;
      const [pending] = this.pending.splice(index, 1);
      if (pending.abort)
        pending.signal?.removeEventListener("abort", pending.abort);
      this.running++;
      this.save({
        ...pending.job,
        status: "running",
        message: "正在关联环境中执行",
      });
      void this.environments
        .runMany(pending.job.accounts, pending.action)
        .then(
          (value) => {
            this.save({
              ...pending.job,
              status: "completed",
              message: "本次操作已结束，业务结果与提交回执请在对应功能查看。",
            });
            pending.resolve(value);
          },
          (error) => {
            this.save({
              ...pending.job,
              status: "failed",
              message: safeMessage(error),
            });
            pending.reject(error);
          },
        )
        .finally(() => {
          this.running--;
          this.drain();
        });
    }
  }
  close() {
    this.closed = true;
    this.unsubscribe();
    for (const pending of this.pending.splice(0)) {
      if (pending.abort)
        pending.signal?.removeEventListener("abort", pending.abort);
      pending.reject(
        new AppError(
          "ENVIRONMENT_QUEUE_CLOSED",
          "调度已停止，请核对后手动继续。",
        ),
      );
    }
  }
}

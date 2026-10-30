import type { DriveProvider } from "./providers/provider";
import { assertManifest } from "./providers/provider";
import type { Job, Provider, RemoteFile, ShareInput } from "../shared/types";
import { Repository } from "./repository";
import { now } from "./database";
import { AppError, safeMessage } from "./errors";
import { SecretStore } from "./secrets";
import { NoteExporter } from "./notes";
import { parseShare } from "./links";

export class AccountMutex {
  private locks = new Map<string, Promise<void>>();
  async run<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.locks.set(accountId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(accountId) === tail) this.locks.delete(accountId);
    }
  }
}
export class TransferQueue {
  onAccountBlocked?: (
    accountId: string,
    stage: "waiting_login" | "needs_review",
    message: string,
  ) => void;
  workers: Partial<Record<Job["kind"], (jobId: string) => Promise<void>>> = {};
  private running = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  get isBusy() {
    return this.running.size > 0;
  }
  constructor(
    private repo: Repository,
    private providers: Record<Provider, DriveProvider>,
    private secrets: SecretStore,
    private notes: NoteExporter,
    readonly mutex: AccountMutex,
    private changed: () => void,
    private onShareSaved?: (copyId: string) => Promise<void>,
  ) {}
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.pump();
    }, 3000);
    this.timer.unref();
    void this.pump();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
  }
  async pump() {
    if (this.stopped) return;
    const active = [
      "queued",
      "preflight",
      "transferring",
      "verifying",
      "sharing",
      "archiving",
    ];
    for (const job of this.repo
      .jobs(true)
      .filter((j) => active.includes(j.stage))
      .reverse()) {
      if (this.running.has(job.accountId) || this.running.size >= 2) continue;
      this.running.add(job.accountId);
      void this.mutex
        .run(job.accountId, () => this.execute(job.id))
        .catch((error) => {
          console.error("任务执行失败:", safeMessage(error));
        })
        .finally(() => {
          this.running.delete(job.accountId);
          this.changed();
        });
    }
    await this.notes.flush();
  }
  private stage(jobId: string, stage: string, checkpoint?: string) {
    if (this.repo.getJob(jobId).stage === "cancelled")
      throw new AppError("CANCELLED", "本地任务已停止，远端操作可能仍在完成。");
    this.repo.db.run(
      "UPDATE jobs SET stage=?,checkpoint=COALESCE(?,checkpoint),error=NULL,updated_at=? WHERE id=?",
      stage,
      checkpoint ?? null,
      now(),
      jobId,
    );
    this.repo.db.run(
      "UPDATE copies SET status=?,error=NULL,updated_at=? WHERE id=?",
      stage,
      now(),
      this.repo.getJob(jobId).copyId,
    );
    this.changed();
  }
  async execute(jobId: string) {
    const operation = this.repo.getJob(jobId);
    if (operation.kind !== "transfer") {
      const worker = this.workers[operation.kind];
      if (!worker)
        throw new AppError("WORKER_MISSING", "该任务需要更新版本处理。");
      await worker(jobId);
      return;
    }
    const job = this.repo.getJob(jobId),
      copy = this.repo.getCopy(job.copyId),
      account = this.repo.getAccount(copy.accountId),
      resource = this.repo.getResource(copy.resourceId),
      provider = this.providers[account.provider];
    try {
      if (!account.enabled || !account.uid)
        throw new AppError("AUTH_EXPIRED", "请登录任务创建时选定的本人账号。");
      const assertIdentity = async () => {
        const identity = await provider.identity(account);
        if (identity.uid !== account.uid)
          throw new AppError(
            "ACCOUNT_UID_MISMATCH",
            "当前会话UID与任务绑定账号不同。请登录原账号，禁止切换身份继续。",
          );
      };
      await assertIdentity();
      const source: ShareInput = parseShare(
        resource.sourceUrl,
        (await this.secrets.get(`source:${resource.id}`)) ?? "",
      );
      let checkpoint = this.repo.getJob(jobId).checkpoint;
      let selected = this.repo.selectedFiles(copy.id);
      let folder = copy.folderId;
      if (checkpoint === "new") {
        this.stage(jobId, "preflight");
        if (!selected.length)
          throw new AppError(
            "SELECTION_REQUIRED",
            "请先读取分享并选择需要转存的文件。",
          );
        const live: RemoteFile[] = [];
        for (const parentId of [...new Set(selected.map((f) => f.parentId))]) {
          let cursor: string | undefined;
          for (let page = 1; page <= 100; page++) {
            const inspection = await provider.inspect(
              account,
              source,
              parentId,
              page,
              cursor,
            );
            live.push(...inspection.files);
            if (!inspection.hasMore) break;
            cursor = inspection.nextCursor;
          }
        }
        const refreshed = selected.map((f) =>
          live.find((current) => current.id === f.id),
        );
        if (refreshed.some((f) => !f))
          throw new AppError(
            "SOURCE_CHANGED",
            "已选文件发生变化，请重新读取分享。",
          );
        selected = refreshed as RemoteFile[];
        folder = await provider.ensureFolder(account, copy.directory);
        const existing = await provider.list(account, folder);
        if (existing.length)
          throw new AppError(
            "TARGET_NOT_EMPTY",
            "新任务的专用目标目录非空，请人工核对，未重复转存。",
          );
        this.repo.db.run(
          "UPDATE copies SET folder_id=?,selected_files=? WHERE id=?",
          folder,
          JSON.stringify(selected),
          copy.id,
        );
        this.repo.db.run(
          "UPDATE jobs SET checkpoint=? WHERE id=?",
          "folder_ready",
          jobId,
        );
        checkpoint = "folder_ready";
        this.repo.log(jobId, "分享与UID已核验，目标专用目录为空；准备转存。");
      }
      if (!folder)
        throw new AppError(
          "INVALID_CHECKPOINT",
          "任务缺少目标目录检查点，请人工核对。",
        );
      if (checkpoint === "transfer_requested") {
        this.stage(jobId, "verifying");
        const actual = await provider.list(account, folder);
        if (!actual.length)
          throw new AppError(
            "UNCERTAIN_REMOTE_RESULT",
            "上次转存请求结果未知，当前目录为空；不自动重复提交，请稍后再次核对或在网盘内处理。",
            true,
          );
        assertManifest(selected, actual);
        this.repo.db.run(
          "UPDATE copies SET files=? WHERE id=?",
          JSON.stringify(actual),
          copy.id,
        );
        checkpoint = "transferred";
        this.repo.log(
          jobId,
          "已核对先前为空的目标目录，当前文件与清单的名称、类型、数量和大小一致；未获取内容哈希。",
        );
      }
      if (checkpoint === "folder_ready") {
        await assertIdentity();
        this.stage(jobId, "transferring", "transfer_requested");
        const transfer = await provider.transfer(
          account,
          source,
          selected,
          folder,
          copy.directory,
        );
        this.repo.db.run(
          "UPDATE jobs SET metadata=?,checkpoint=?,updated_at=? WHERE id=?",
          JSON.stringify({ taskId: transfer.taskId }),
          transfer.taskId ? "remote_task" : "transferred",
          now(),
          jobId,
        );
        checkpoint = transfer.taskId ? "remote_task" : "transferred";
        this.repo.log(
          jobId,
          transfer.taskId
            ? "远端任务ID已保存，正在等待服务端处理。"
            : "服务端已响应，开始核验目标文件。",
        );
      }
      if (checkpoint === "remote_task") {
        this.stage(jobId, "transferring");
        const remoteId = String(this.repo.jobMetadata(jobId).taskId ?? "");
        if (!remoteId)
          throw new AppError(
            "INVALID_CHECKPOINT",
            "远端任务ID缺失，不能安全重试。",
          );
        let done = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          if (this.repo.getJob(jobId).stage === "cancelled")
            throw new AppError("CANCELLED", "已停止本地等待，未撤销远端任务。");
          if (await provider.poll(account, remoteId)) {
            done = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        if (!done)
          throw new AppError(
            "REMOTE_STILL_RUNNING",
            "远端任务仍在处理。可稍后恢复查询，不会重复转存。",
            true,
          );
        checkpoint = "transferred";
      }
      if (checkpoint === "transferred") {
        this.stage(jobId, "verifying");
        await assertIdentity();
        const actual = await provider.list(account, folder);
        assertManifest(selected, actual);
        this.repo.db.run(
          "UPDATE copies SET files=?,owner_uid=?,verified_at=? WHERE id=?",
          JSON.stringify(actual),
          account.uid,
          now(),
          copy.id,
        );
        this.repo.db.run(
          "UPDATE jobs SET checkpoint=? WHERE id=?",
          "verified",
          jobId,
        );
        checkpoint = "verified";
        this.repo.log(
          jobId,
          "目标文件在绑定账号下已核验：数量、类型、名称与大小一致；目录内容由网盘转存，未声明内容哈希核验。",
        );
      }
      if (checkpoint === "share_requested") {
        this.stage(jobId, "sharing");
        const files = this.repo.getCopy(copy.id).files;
        const existing = await provider.findOwnShare(account, files);
        if (!existing)
          throw new AppError(
            "UNCERTAIN_SHARE_RESULT",
            "上次建分享结果未知，未找到可核验的本人分享。请在网盘内核对后再处理。",
            true,
          );
        await this.storeShare(copy.id, account.uid, existing);
        checkpoint = "shared";
      }
      if (checkpoint === "verified") {
        await assertIdentity();
        this.stage(jobId, "sharing", "share_requested");
        try {
          await this.storeShare(
            copy.id,
            account.uid,
            await provider.createShare(
              account,
              this.repo.getCopy(copy.id).files,
              resource.title,
            ),
          );
        } catch (error) {
          if (
            error instanceof AppError &&
            !error.uncertain &&
            ["AUTH_EXPIRED", "USER_ACTION_REQUIRED", "QUOTA_EXCEEDED"].includes(
              error.code,
            )
          ) {
            this.repo.db.run(
              "UPDATE jobs SET checkpoint='verified' WHERE id=?",
              jobId,
            );
            throw error;
          }
          throw new AppError(
            error instanceof AppError ? error.code : "UNCERTAIN_SHARE_RESULT",
            safeMessage(error),
            true,
          );
        }
        checkpoint = "shared";
        this.repo.log(jobId, "本人分享归属已核验，来源链接不会进入分发内容。");
      }
      if (checkpoint === "shared") {
        this.stage(jobId, "archiving", "shared");
        this.repo.db.transaction(() => {
          this.repo.db.run(
            "UPDATE copies SET status=?,updated_at=? WHERE id=?",
            "ready",
            now(),
            copy.id,
          );
          this.notes.enqueue(copy.id);
          this.repo.db.run(
            "UPDATE jobs SET stage=?,checkpoint=?,error=NULL,updated_at=? WHERE id=?",
            "completed",
            "complete",
            now(),
            jobId,
          );
        });
        await this.onShareSaved?.(copy.id);
        await this.notes.flush();
        this.repo.log(jobId, "资源已归档；Obsidian导出状态独立记录。");
      }
    } catch (error) {
      const current = this.repo.getJob(jobId);
      if (current.stage === "cancelled") return;
      const appError =
        error instanceof AppError
          ? error
          : new AppError(
              "UNEXPECTED_ERROR",
              safeMessage(error),
              ["transfer_requested", "share_requested"].includes(
                current.checkpoint,
              ),
            );
      const stage =
        appError.code === "AUTH_EXPIRED"
          ? "waiting_login"
          : appError.uncertain ||
              [
                "ACCOUNT_UID_MISMATCH",
                "PARTIAL_SUCCESS",
                "TARGET_NOT_EMPTY",
                "USER_ACTION_REQUIRED",
                "QUOTA_EXCEEDED",
              ].includes(appError.code)
            ? "needs_review"
            : "failed";
      this.repo.db.run(
        "UPDATE jobs SET stage=?,error=?,updated_at=? WHERE id=?",
        stage,
        appError.message,
        now(),
        jobId,
      );
      if (
        current.checkpoint === "transfer_requested" &&
        !appError.uncertain &&
        ["AUTH_EXPIRED", "USER_ACTION_REQUIRED", "QUOTA_EXCEEDED"].includes(
          appError.code,
        )
      )
        this.repo.db.run(
          "UPDATE jobs SET checkpoint='folder_ready' WHERE id=?",
          jobId,
        );
      this.repo.db.run(
        "UPDATE copies SET status=?,error=? WHERE id=?",
        stage,
        appError.message,
        copy.id,
      );
      if (stage === "waiting_login")
        this.repo.db.run(
          "UPDATE accounts SET status=?,error=? WHERE id=?",
          "expired",
          appError.message,
          account.id,
        );
      this.repo.log(jobId, appError.message);
      if (
        [
          "AUTH_EXPIRED",
          "USER_ACTION_REQUIRED",
          "ACCOUNT_UID_MISMATCH",
          "QUOTA_EXCEEDED",
        ].includes(appError.code)
      )
        this.onAccountBlocked?.(
          account.id,
          appError.code === "AUTH_EXPIRED" ? "waiting_login" : "needs_review",
          appError.message,
        );
    } finally {
      this.changed();
    }
  }
  private async storeShare(
    copyId: string,
    uid: string,
    share: { id: string; url: string; code: string; ownerUid: string },
  ) {
    if (share.ownerUid !== uid)
      throw new AppError(
        "OWNERSHIP_UNVERIFIED",
        "本人分享UID与目标账号不一致，禁止分发。",
      );
    const copy = this.repo.getCopy(copyId);
    if (copy.ownerUid !== uid || !copy.verifiedAt)
      throw new AppError(
        "OWNERSHIP_UNVERIFIED",
        "目标文件尚未通过账号归属核验。",
      );
    const parsed = parseShare(share.url);
    const resource = this.repo.getResource(copy.resourceId);
    if (
      parsed.provider !== resource.provider ||
      parsed.url === resource.sourceUrl
    )
      throw new AppError(
        "FOREIGN_SHARE_BLOCKED",
        "建分享结果与来源相同或网盘类型错误，未保存为本人分享。",
      );
    await this.secrets.set(`share:${copyId}`, share.code);
    this.repo.db.run(
      "UPDATE copies SET share_id=?,share_url=?,share_owner_uid=?,share_version=share_version+1,share_verified_at=?,error=NULL WHERE id=?",
      share.id,
      parsed.url,
      uid,
      now(),
      copyId,
    );
    this.repo.db.run(
      "UPDATE jobs SET checkpoint=? WHERE copy_id=? AND kind='transfer' AND stage NOT IN (?,?)",
      "shared",
      copyId,
      "completed",
      "cancelled",
    );
  }
}

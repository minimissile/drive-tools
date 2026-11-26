import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Account, RemoteFile } from "../shared/types";
import type {
  DriveIndexEntry,
  DriveIndexPage,
  DriveIndexQuery,
  DriveRegistration,
  DriveSyncAutoRegister,
  DriveSyncLog,
  DriveSyncRun,
  DriveSyncStatus,
} from "../shared/drive-sync";
import { driveSyncActive } from "../shared/drive-sync";
import { Database, id, now, parseJson } from "./database";
import { AppError, safeMessage } from "./errors";
import type { DriveProvider } from "./providers/provider";
import {
  driveSyncAutoRegisterKey,
  registeredDriveResource,
  registerScannedDriveFiles,
  writeIndexedDriveResource,
} from "./drive-sync-resource";
import { writeRuntimeLog } from "./runtime-log";

interface Dependencies {
  db: Database;
  account(id: string): Account;
  supported(account: Account): boolean;
  environment(accountId: string): string;
  withAccount<T>(
    accountId: string,
    action: (account: Account, provider: DriveProvider) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  changed(): void;
  intervalMs?: number;
}
type RunRow = {
  id: string;
  account_id: string;
  owner_uid: string;
  environment: string;
  status: DriveSyncStatus;
  message: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};
type Folder = {
  file_id: string;
  request_id: string;
  path: string;
  cursor: string;
  cursors: string;
};
type Entry = {
  file_id: string;
  parent_id: string;
  name: string;
  path: string;
  is_directory: number;
  size: number | null;
  observed_at: string;
  missing: number;
  state: DriveIndexEntry["state"];
};
const root = "@root";
const logDomain = "drive-sync";
const logLimit = 100;
const progressIntervalMs = 15_000;
type LogEvent = Pick<DriveSyncLog, "level" | "message"> & { event: string };
type LogScope = Pick<DriveSyncRun, "id" | "accountId">;
type AutoRegisterSetting = Omit<DriveSyncAutoRegister, "requiresRescan"> & {
  runId: string;
  includesFolders?: true;
};
const identityCodes = new Set([
  "AUTH_EXPIRED",
  "ACCOUNT_UID_MISMATCH",
  "DUPLICATE_ACCOUNT",
  "ENVIRONMENT_CHANGED",
  "ACCOUNT_DISABLED",
  "USER_ACTION_REQUIRED",
]);
const failureMessages = new Map([
  ["AUTH_EXPIRED", "登录已失效，请在原账号环境重新登录。"],
  ["ACCOUNT_DISABLED", "账号已停用，请启用后继续。"],
  ["ACCOUNT_UID_MISMATCH", "网盘账号身份已变化，请核对原账号。"],
  ["DUPLICATE_ACCOUNT", "此网盘账号已关联其他记录，请核对账号。"],
  ["ENVIRONMENT_CHANGED", "账号身份或环境已变化，请核对原账号环境。"],
  ["USER_ACTION_REQUIRED", "请在原账号环境完成网盘验证后继续。"],
  ["REMOTE_SCHEMA_CHANGED", "网盘返回的目录数据异常。"],
  ["INCOMPLETE_LIST", "网盘未完整返回目录数据。"],
]);

function logFailure(error: unknown, fallback: string) {
  return error instanceof AppError
    ? (failureMessages.get(error.code) ?? fallback)
    : fallback;
}

function progress(run: DriveSyncRun) {
  const found = `已发现 ${run.files} 个文件、${run.folders} 个目录`;
  const failed = run.failed ? `，${run.failed} 个未完成` : "";
  return `${found}，${run.pending} 个待处理${failed}。${autoRegisterSummary(run.autoRegister)}`;
}

function autoRegisterSummary(autoRegister?: DriveSyncAutoRegister) {
  return autoRegister
    ? `自动录入新增 ${autoRegister.added} 项，跳过 ${autoRegister.skipped} 项。`
    : "";
}

/** Read-only, durable metadata scans. Registering a resource never creates a share. */
export class DriveSync {
  private reading = 0;
  private active = new Map<
    string,
    { controller: AbortController; task: Promise<void> }
  >();
  private closed = false;
  constructor(private d: Dependencies) {
    d.db.transaction(() => {
      const message = "上次同步已中断，请手动继续。";
      const interrupted = d.db.all<LogScope>(
        "UPDATE drive_sync_runs SET status='interrupted',message=?,updated_at=? WHERE status IN ('running','pausing') RETURNING id,account_id AS accountId",
        message,
        now(),
      );
      for (const run of interrupted)
        this.record(run, {
          event: "sync.interrupted",
          level: "warning",
          message: message + autoRegisterSummary(this.autoRegister(run)),
        });
    });
  }
  get isBusy() {
    return this.active.size > 0;
  }
  private async withAccount<T>(
    accountId: string,
    action: (account: Account, provider: DriveProvider) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    while (this.reading >= 3) {
      if (this.closed) throw new AppError("SYNC_CLOSED", "同步服务已停止。");
      await delay(80, undefined, { signal });
    }
    if (this.closed) throw new AppError("SYNC_CLOSED", "同步服务已停止。");
    signal?.throwIfAborted();
    this.reading++;
    try {
      return await this.d.withAccount(
        accountId,
        (account, provider) => {
          signal?.throwIfAborted();
          return action(account, provider);
        },
        signal,
      );
    } finally {
      this.reading--;
    }
  }
  private row(accountId: string) {
    return this.d.db.get<RunRow>(
      "SELECT * FROM drive_sync_runs WHERE account_id=? ORDER BY rowid DESC LIMIT 1",
      accountId,
    );
  }
  private autoRegister(
    run: LogScope,
    status?: DriveSyncStatus,
  ): DriveSyncAutoRegister | undefined {
    const setting = this.d.db.setting<AutoRegisterSetting | null>(
      driveSyncAutoRegisterKey(run.accountId),
      null,
    );
    if (setting?.runId !== run.id) return undefined;
    return {
      enabled: setting.enabled,
      added: setting.added,
      skipped: setting.skipped,
      // Older auto runs may have completed directories without enrolling them or their children.
      ...(setting.enabled &&
      setting.includesFolders !== true &&
      status !== "completed"
        ? { requiresRescan: true as const }
        : {}),
    };
  }
  private setAutoRegister(
    run: LogScope,
    { enabled, added, skipped }: DriveSyncAutoRegister,
  ) {
    this.d.db.setSetting(driveSyncAutoRegisterKey(run.accountId), {
      enabled,
      added,
      skipped,
      runId: run.id,
      includesFolders: true,
    } satisfies AutoRegisterSetting);
  }
  current(accountId: string): DriveSyncRun | null {
    const row = this.row(accountId);
    if (!row) return null;
    const counts = this.d.db.get<{
      folders: number;
      pending: number;
      failed: number;
    }>(
      "SELECT count(*) AS folders,sum(status='pending') AS pending,sum(status='failed') AS failed FROM drive_sync_folders WHERE run_id=?",
      row.id,
    )!;
    const files = this.d.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM drive_index_entries WHERE account_id=? AND owner_uid=? AND last_seen=? AND is_directory=0",
      accountId,
      row.owner_uid,
      row.id,
    )!.n;
    return {
      id: row.id,
      accountId,
      ownerUid: row.owner_uid,
      environment: row.environment,
      status: row.status,
      files,
      folders: counts.folders,
      pending: counts.pending || 0,
      failed: counts.failed || 0,
      message: row.message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      autoRegister: this.autoRegister({ id: row.id, accountId }, row.status),
    };
  }
  logs(accountId: string): DriveSyncLog[] {
    const account = this.d.account(accountId);
    return this.d.db.all<DriveSyncLog>(
      `SELECT l.id,l.created_at AS at,l.level,l.message
       FROM runtime_logs l JOIN drive_sync_runs r ON r.id=l.task_id
       WHERE l.domain=? AND l.account_id=? AND r.account_id=l.account_id AND r.owner_uid=?
       ORDER BY l.id DESC LIMIT ?`,
      logDomain,
      accountId,
      account.uid,
      logLimit,
    );
  }
  private record(run: LogScope, entry: LogEvent) {
    writeRuntimeLog(this.d.db, logDomain, {
      ...entry,
      accountId: run.accountId,
      taskId: run.id,
    });
    this.d.db.run(
      `DELETE FROM runtime_logs WHERE domain=? AND account_id=? AND id<(
         SELECT id FROM runtime_logs WHERE domain=? AND account_id=?
         ORDER BY id DESC LIMIT 1 OFFSET ?
       )`,
      logDomain,
      run.accountId,
      logDomain,
      run.accountId,
      logLimit - 1,
    );
  }
  private update(
    run: LogScope,
    status: DriveSyncStatus,
    message = "",
    log?: LogEvent,
  ) {
    if (this.closed) return;
    this.d.db.transaction(() => this.setStatus(run, status, message, log));
    this.d.changed();
  }
  private setStatus(
    run: LogScope,
    status: DriveSyncStatus,
    message: string,
    log?: LogEvent,
  ) {
    this.d.db.run(
      "UPDATE drive_sync_runs SET status=?,message=?,updated_at=? WHERE id=?",
      status,
      message,
      now(),
      run.id,
    );
    if (log) this.record(run, log);
  }
  start(accountId: string, restart = false, autoRegister = false) {
    const account = this.d.account(accountId);
    if (this.closed) throw new AppError("SYNC_CLOSED", "同步服务已停止。");
    if (!account.enabled)
      throw new AppError("ACCOUNT_DISABLED", "请先启用此账号。");
    if (!account.uid)
      throw new AppError("AUTH_EXPIRED", "请先在此账号原环境完成登录核验。");
    if (!this.d.supported(account))
      throw new AppError("SYNC_UNSUPPORTED", "当前网盘尚不支持整盘同步。");
    if (this.active.has(accountId))
      throw new AppError("SYNC_BUSY", "此账号正在同步，请查看进度。");
    const prior = this.current(accountId);
    if (prior && prior.status !== "completed" && !restart)
      throw new AppError(
        "SYNC_UNFINISHED",
        "此账号有未完成的同步，请继续原任务。",
      );
    const runId = id("drive_sync"),
      time = now();
    this.d.db.transaction(() => {
      this.d.db.run(
        "INSERT INTO drive_sync_runs(id,account_id,owner_uid,environment,status,created_at,updated_at) VALUES(?,?,?,?,'running',?,?)",
        runId,
        accountId,
        account.uid,
        this.d.environment(accountId),
        time,
        time,
      );
      this.d.db.run(
        "INSERT INTO drive_sync_folders(run_id,file_id,request_id,path) VALUES(?,?,?,'/')",
        runId,
        root,
        account.provider === "baidu" ? "/" : "0",
      );
      const scope = { id: runId, accountId };
      if (autoRegister)
        this.setAutoRegister(scope, { enabled: true, added: 0, skipped: 0 });
      else if (prior?.autoRegister)
        this.d.db.run(
          "DELETE FROM settings WHERE key=?",
          driveSyncAutoRegisterKey(accountId),
        );
      this.record(scope, {
        event: "sync.started",
        level: "info",
        message:
          (prior ? "开始更新本地目录。" : "开始同步整个网盘。") +
          (autoRegister ? "已开启自动录入资源库。" : ""),
      });
    });
    this.launch(accountId);
    return this.current(accountId)!;
  }
  pause(accountId: string) {
    const run = this.current(accountId);
    if (!run) throw new AppError("SYNC_NOT_FOUND", "尚未启动整盘同步。");
    if (driveSyncActive(run)) {
      this.update(
        run,
        "pausing",
        "正在结束当前目录请求，随后暂停。",
        run.status === "running"
          ? {
              event: "sync.pause_requested",
              level: "info",
              message: "正在暂停，等待当前目录请求结束。",
            }
          : undefined,
      );
      this.active.get(accountId)?.controller.abort();
    }
    return this.current(accountId)!;
  }
  resume(accountId: string, autoRegister?: boolean) {
    const run = this.current(accountId);
    if (!run) return this.start(accountId, false, autoRegister);
    if (this.active.has(accountId) || driveSyncActive(run))
      throw new AppError("SYNC_BUSY", "请等待当前请求结束。");
    if (run.status === "completed")
      return this.start(accountId, false, autoRegister);
    if (
      (autoRegister !== false && run.autoRegister?.requiresRescan) ||
      (autoRegister && !run.autoRegister?.enabled)
    )
      throw new AppError(
        "AUTO_REGISTER_RESTART_REQUIRED",
        "请从头同步，才能将文件和文件夹自动录入资源库。",
      );
    this.assertIdentity(run);
    const disable = autoRegister === false && run.autoRegister?.enabled;
    this.d.db.transaction(() => {
      // Page numbers/cursors can be stale after a pause: restart unfinished directories.
      this.d.db.run(
        "UPDATE drive_sync_folders SET status='pending',cursor='',cursors='[]',error=NULL WHERE run_id=? AND status!='completed'",
        run.id,
      );
      if (disable && run.autoRegister)
        this.setAutoRegister(run, { ...run.autoRegister, enabled: false });
      this.setStatus(run, "running", "", {
        event: "sync.resumed",
        level: "info",
        message:
          (run.status === "partial"
            ? `重试 ${run.failed} 个未完成目录。`
            : "继续同步未完成的目录。") + (disable ? "已关闭自动录入。" : ""),
      });
    });
    this.launch(accountId);
    return this.current(accountId)!;
  }
  private assertIdentity(run: DriveSyncRun) {
    const account = this.d.account(run.accountId);
    if (!account.enabled)
      throw new AppError("ACCOUNT_DISABLED", "账号已停用，请启用后继续。");
    if (
      account.uid !== run.ownerUid ||
      this.d.environment(run.accountId) !== run.environment
    )
      throw new AppError(
        "ENVIRONMENT_CHANGED",
        "账号身份或环境已变化，未继续写入原索引。请核对原账号环境。",
      );
  }
  private launch(accountId: string) {
    const controller = new AbortController();
    // Defer execution until the active guard is installed.
    const task = Promise.resolve()
      .then(() => this.execute(accountId, controller.signal))
      .catch((error) => {
        if (this.closed) return;
        const run = this.current(accountId);
        if (!run) return;
        if (controller.signal.aborted) {
          this.pauseRun(run, safeMessage(error));
          return;
        }
        this.update(run, "blocked", safeMessage(error), {
          event: "sync.blocked",
          level: "error",
          message:
            logFailure(error, "同步遇到异常，已停止。") +
            autoRegisterSummary(run.autoRegister),
        });
      })
      .finally(() => {
        this.active.delete(accountId);
        if (!this.closed) this.d.changed();
      });
    this.active.set(accountId, { controller, task });
    this.d.changed();
  }
  private pauseRun(
    run: DriveSyncRun,
    message = "已暂停，已读取目录保留。点击继续可恢复未完成目录。",
  ) {
    this.update(run, "paused", message, {
      event: "sync.paused",
      level: "info",
      message: `已暂停。${progress(run)}`,
    });
  }
  private async execute(accountId: string, signal: AbortSignal) {
    const run = this.current(accountId)!;
    let lastProgressAt = Date.now();
    let loggedFailures = 0;
    while (!this.closed && !signal.aborted) {
      this.assertIdentity(run);
      const folder = this.d.db.get<Folder>(
        "SELECT * FROM drive_sync_folders WHERE run_id=? AND status='pending' ORDER BY rowid LIMIT 1",
        run.id,
      );
      if (!folder) break;
      try {
        await this.withAccount(
          accountId,
          async (account, provider) => {
            this.assertIdentity(run);
            if (account.uid !== run.ownerUid)
              throw new AppError("ACCOUNT_UID_MISMATCH", "账号身份发生变化。");
            let result;
            for (let attempt = 0; ; attempt++) {
              try {
                result = await provider.listPage!(
                  account,
                  folder.request_id,
                  folder.cursor,
                );
                break;
              } catch (error) {
                const code = error instanceof AppError ? error.code : "";
                if (
                  identityCodes.has(code) ||
                  /SCHEMA|INCOMPLETE|CURSOR|LIMIT/.test(code) ||
                  attempt >= 2 ||
                  signal.aborted
                )
                  throw error;
                await delay(400 * 2 ** attempt);
              }
            }
            if (this.closed) return;
            this.assertIdentity(run);
            const history = parseJson<string[]>(folder.cursors, []);
            const fingerprint = result.files.length
              ? "files:" +
                createHash("sha256")
                  .update(JSON.stringify(result.files.map((f) => f.id)))
                  .digest("hex")
              : "";
            if (
              (result.next &&
                (result.next === folder.cursor ||
                  history.includes("cursor:" + result.next) ||
                  result.files.length === 0)) ||
              (fingerprint && history.includes(fingerprint)) ||
              history.length > 200000
            )
              throw new AppError(
                "INCOMPLETE_LIST",
                "目录分页重复或未完整返回，请重试此目录。",
              );
            if (fingerprint) history.push(fingerprint);
            if (result.next) history.push("cursor:" + result.next);
            const time = now();
            const loggedAutoRegister = this.d.db.transaction(() => {
              const autoRegister = run.autoRegister?.enabled
                ? this.autoRegister(run)
                : undefined;
              const previouslySeen = autoRegister?.enabled
                ? this.d.db.db.prepare(
                    "SELECT 1 FROM drive_index_entries WHERE account_id=? AND owner_uid=? AND file_id=? AND last_seen=?",
                  )
                : undefined;
              const candidates: (RemoteFile & { path: string })[] = [];
              const put = this.d.db.db
                .prepare(`INSERT INTO drive_index_entries(account_id,owner_uid,file_id,parent_id,name,path,is_directory,size,last_seen,observed_at,missing)
              VALUES(?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(account_id,owner_uid,file_id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,path=excluded.path,is_directory=excluded.is_directory,size=excluded.size,last_seen=excluded.last_seen,observed_at=excluded.observed_at,missing=0`);
              for (const file of result.files) {
                if (
                  !file.id ||
                  !file.name ||
                  file.id === root ||
                  file.id === folder.file_id ||
                  /[\/\u0000]/.test(file.name)
                )
                  throw new AppError(
                    "REMOTE_SCHEMA_CHANGED",
                    "网盘返回了无效文件身份或名称。",
                  );
                const path = folder.path.replace(/\/$/, "") + "/" + file.name;
                const size =
                  file.size != null &&
                  Number.isFinite(file.size) &&
                  file.size >= 0
                    ? file.size
                    : null;
                if (
                  previouslySeen &&
                  !previouslySeen.get(accountId, run.ownerUid, file.id, run.id)
                )
                  candidates.push({ ...file, path, size });
                const knownDirectory = file.isDirectory
                  ? this.d.db.get<{ path: string }>(
                      "SELECT path FROM drive_sync_folders WHERE run_id=? AND file_id=?",
                      run.id,
                      file.id,
                    )
                  : null;
                if (
                  knownDirectory &&
                  (folder.path === knownDirectory.path ||
                    folder.path.startsWith(knownDirectory.path + "/"))
                )
                  throw new AppError(
                    "REMOTE_SCHEMA_CHANGED",
                    "目录层级出现循环，未继续此目录。",
                  );
                const previous = file.isDirectory
                  ? this.d.db.get<{ path: string }>(
                      "SELECT path FROM drive_index_entries WHERE account_id=? AND owner_uid=? AND file_id=?",
                      accountId,
                      run.ownerUid,
                      file.id,
                    )
                  : null;
                if (previous && previous.path !== path) {
                  // Child paths are derived from the same directory identity, not matched by names.
                  this.d.db.run(
                    "UPDATE drive_index_entries SET path=?||substr(path,?) WHERE account_id=? AND owner_uid=? AND substr(path,1,?)=?",
                    path,
                    Array.from(previous.path).length + 1,
                    accountId,
                    run.ownerUid,
                    Array.from(previous.path).length + 1,
                    previous.path + "/",
                  );
                  this.d.db.run(
                    "UPDATE drive_sync_folders SET path=?||substr(path,?),request_id=CASE WHEN ? THEN ?||substr(request_id,?) ELSE request_id END WHERE run_id=? AND substr(path,1,?)=?",
                    path,
                    Array.from(previous.path).length + 1,
                    Number(account.provider === "baidu"),
                    path,
                    Array.from(previous.path).length + 1,
                    run.id,
                    Array.from(previous.path).length + 1,
                    previous.path + "/",
                  );
                }
                put.run(
                  accountId,
                  run.ownerUid,
                  file.id,
                  folder.file_id,
                  file.name,
                  path,
                  Number(file.isDirectory),
                  size,
                  run.id,
                  time,
                );
                if (file.isDirectory)
                  this.d.db.run(
                    "INSERT INTO drive_sync_folders(run_id,file_id,request_id,path) VALUES(?,?,?,?) ON CONFLICT(run_id,file_id) DO UPDATE SET request_id=excluded.request_id,path=excluded.path",
                    run.id,
                    file.id,
                    account.provider === "baidu" ? path : file.id,
                    path,
                  );
              }
              this.d.db.run(
                "UPDATE drive_sync_folders SET cursor=?,cursors=?,status=?,error=NULL WHERE run_id=? AND file_id=?",
                result.next || "",
                JSON.stringify(history),
                result.next ? "pending" : "completed",
                run.id,
                folder.file_id,
              );
              this.d.db.run(
                "UPDATE drive_sync_runs SET updated_at=? WHERE id=?",
                time,
                run.id,
              );
              if (!autoRegister || !candidates.length) return false;
              const registration = registerScannedDriveFiles(
                this.d.db,
                {
                  id: accountId,
                  uid: run.ownerUid,
                  provider: account.provider,
                },
                folder.path,
                candidates,
                time,
              );
              const totals = {
                enabled: true,
                added: autoRegister.added + registration.added,
                skipped: autoRegister.skipped + registration.skipped,
              };
              this.setAutoRegister(run, totals);
              const firstBatch = !autoRegister.added && !autoRegister.skipped;
              if (firstBatch)
                this.record(run, {
                  event: "sync.auto_registered",
                  level: "info",
                  message: autoRegisterSummary(totals),
                });
              return firstBatch;
            });
            if (loggedAutoRegister) lastProgressAt = Date.now();
          },
          signal,
        );
      } catch (error) {
        if (this.closed) return;
        if (signal.aborted) break;
        const code = error instanceof AppError ? error.code : "";
        if (identityCodes.has(code)) throw error;
        this.d.db.run(
          "UPDATE drive_sync_folders SET status='failed',error=? WHERE run_id=? AND file_id=?",
          safeMessage(error),
          run.id,
          folder.file_id,
        );
        const log =
          loggedFailures < 3
            ? {
                event: "sync.folder_failed",
                level: "warning" as const,
                message: `目录「${safeMessage(new Error(folder.path)).replace(/\s+/g, " ").slice(0, 180)}」读取失败。${logFailure(error, "")}`,
              }
            : undefined;
        this.update(
          run,
          "running",
          `${folder.path}：${safeMessage(error)}`,
          log,
        );
        if (log) loggedFailures++;
      }
      if (this.closed) return;
      if (
        !signal.aborted &&
        Date.now() - lastProgressAt >= progressIntervalMs
      ) {
        const latest = this.current(accountId)!;
        if (latest.pending)
          this.record(latest, {
            event: "sync.progress",
            level: "info",
            message: `正在同步。${progress(latest)}`,
          });
        lastProgressAt = Date.now();
      }
      this.d.changed();
      await delay(this.d.intervalMs ?? 400 + Math.floor(Math.random() * 601));
    }
    if (this.closed) return;
    const latest = this.current(accountId)!;
    if (signal.aborted) {
      this.pauseRun(latest);
      return;
    }
    if (latest.failed) {
      this.update(
        run,
        "partial",
        `${latest.failed} 个目录未完成。${latest.message} 可重试未完成目录。`,
        {
          event: "sync.partial",
          level: "warning",
          message:
            `同步部分完成，${latest.failed} 个目录未完成，可重试。` +
            autoRegisterSummary(latest.autoRegister),
        },
      );
      return;
    }
    this.d.db.transaction(() => {
      this.d.db.run(
        "UPDATE drive_index_entries SET missing=1 WHERE account_id=? AND owner_uid=? AND last_seen!=?",
        accountId,
        run.ownerUid,
        run.id,
      );
      this.record(run, {
        event: "sync.completed",
        level: "info",
        message:
          `同步完成，共发现 ${latest.files} 个文件、${latest.folders} 个目录。` +
          autoRegisterSummary(latest.autoRegister),
      });
      this.d.db.run(
        "UPDATE drive_sync_runs SET status='completed',completed_at=?,updated_at=?,message='' WHERE id=?",
        now(),
        now(),
        run.id,
      );
    });
    this.d.changed();
  }
  index(input: DriveIndexQuery): DriveIndexPage {
    const account = this.d.account(input.accountId),
      owner = account.uid;
    const run = this.current(account.id),
      page = Math.max(1, input.page ?? 1),
      pageSize = 50;
    const lastCompleteAt =
      this.d.db.get<{ completed_at: string }>(
        "SELECT completed_at FROM drive_sync_runs WHERE account_id=? AND owner_uid=? AND status='completed' ORDER BY rowid DESC LIMIT 1",
        account.id,
        owner,
      )?.completed_at ?? null;
    const breadcrumbs: { id: string; name: string }[] = [];
    let parent = input.parentId || root;
    const seen = new Set<string>();
    while (parent !== root && !seen.has(parent) && breadcrumbs.length < 256) {
      seen.add(parent);
      const row = this.d.db.get<{ name: string; parent_id: string }>(
        "SELECT name,parent_id FROM drive_index_entries WHERE account_id=? AND owner_uid=? AND file_id=?",
        account.id,
        owner,
        parent,
      );
      if (!row) break;
      breadcrumbs.unshift({ id: parent, name: row.name });
      parent = row.parent_id;
    }
    const match =
      "EXISTS(SELECT 1 FROM drive_resource_entries l WHERE l.account_id=e.account_id AND l.owner_uid=e.owner_uid AND l.file_id=e.file_id)";
    // Compute linked folders once per query. File-level registrations can
    // leave thousands of links that are irrelevant to ancestor coverage.
    const linkedFolders = `WITH linked_folders AS MATERIALIZED (
      SELECT DISTINCT r.path FROM drive_resource_entries l
      JOIN drive_index_entries r ON r.account_id=l.account_id AND r.owner_uid=l.owner_uid AND r.file_id=l.file_id
      WHERE l.account_id=? AND l.owner_uid=? AND r.is_directory=1
    )`;
    // Only prefixes ending at a path separator can match an ancestor folder.
    const under = `EXISTS(
      WITH RECURSIVE separators(position) AS (
        SELECT instr(e.path,'/')
        UNION ALL
        SELECT position+instr(substr(e.path,position+1),'/') FROM separators
        WHERE position>0 AND instr(substr(e.path,position+1),'/')>0
      )
      SELECT 1 FROM separators
      WHERE position>0 AND substr(e.path,1,position-1) IN (SELECT path FROM linked_folders)
    )`;
    const state = `CASE WHEN e.missing=1 THEN 'review' WHEN ${match} THEN 'recorded' WHEN ${under} THEN 'review' ELSE 'unrecorded' END`;
    const values: (string | number | null)[] = [account.id, owner];
    let where = "e.account_id=? AND e.owner_uid=?";
    if (input.search?.trim()) {
      where += " AND instr(lower(e.name||' '||e.path),lower(?))>0";
      values.push(input.search.trim());
    } else {
      where += " AND e.parent_id=?";
      values.push(input.parentId || root);
    }
    if (input.foldersOnly) where += " AND e.is_directory=1";
    if (input.state && input.state !== "all") {
      where += ` AND (${state})=?`;
      values.push(input.state);
    }
    const total = this.d.db.get<{ n: number }>(
      `${linkedFolders} SELECT count(*) AS n FROM drive_index_entries e WHERE ${where}`,
      account.id,
      owner,
      ...values,
    )!.n;
    const rows = this.d.db.all<Entry>(
      `${linkedFolders} SELECT e.*,(${state}) AS state FROM drive_index_entries e WHERE ${where} ORDER BY e.is_directory DESC,e.name,e.file_id LIMIT ? OFFSET ?`,
      account.id,
      owner,
      ...values,
      pageSize,
      (page - 1) * pageSize,
    );
    const items = rows.map((e) => ({
      id: e.file_id,
      parentId: e.parent_id,
      name: e.name,
      path: e.path,
      isDirectory: !!e.is_directory,
      size: e.size,
      observedAt: e.observed_at,
      missing: !!e.missing,
      state: e.state,
      resources: this.d.db.all<{ id: string; title: string; copyId: string }>(
        "SELECT r.id,r.title,c.id AS copyId FROM drive_resource_entries l JOIN copies c ON c.id=l.copy_id JOIN resources r ON r.id=c.resource_id WHERE l.account_id=? AND l.owner_uid=? AND l.file_id=?",
        account.id,
        owner,
        e.file_id,
      ),
    }));
    return {
      items,
      total,
      page,
      pageSize,
      ownerUid: owner,
      run,
      lastCompleteAt,
      breadcrumbs,
      autoRegisterSupported: true,
      autoRegisterIncludesFolders: true,
    };
  }
  async register(input: DriveRegistration) {
    const run = this.current(input.accountId);
    if (driveSyncActive(run) || this.active.has(input.accountId))
      throw new AppError("SYNC_BUSY", "请先暂停同步，再登记资源。");
    const entries = [
      ...new Map(input.entries.map((e) => [e.fileId, e])).values(),
    ];
    return this.withAccount(input.accountId, async (account, provider) => {
      const owner = {
        id: account.id,
        uid: account.uid!,
        provider: account.provider,
      };
      const environment = this.d.environment(account.id);
      const selected = entries.map((inputEntry) => {
        const file = this.d.db.get<Entry>(
          "SELECT * FROM drive_index_entries WHERE account_id=? AND owner_uid=? AND file_id=?",
          account.id,
          account.uid,
          inputEntry.fileId,
        );
        return { ...inputEntry, file };
      });
      // A selected ancestor owns its descendants; never silently create both.
      for (const a of selected)
        for (const b of selected)
          if (
            a !== b &&
            a.file?.is_directory &&
            b.file?.path.startsWith(a.file.path + "/")
          )
            throw new AppError(
              "OVERLAPPING_SELECTION",
              "所选内容包含父目录和其子项，请保留其中一个层级。",
            );
      const results: { fileId: string; resourceId?: string; error?: string }[] =
        [];
      let halted = "";
      for (const item of selected) {
        if (halted) {
          results.push({ fileId: item.fileId, error: halted });
          continue;
        }
        try {
          if (!item.file || item.file.missing)
            throw new AppError(
              "INDEX_CHANGED",
              "此文件尚未发现或已失效，请先更新目录。",
            );
          const old = registeredDriveResource(this.d.db, owner, item.fileId);
          if (old) {
            results.push({ fileId: item.fileId, resourceId: old });
            continue;
          }
          const directory =
            item.file.path.slice(0, item.file.path.lastIndexOf("/")) || "/";
          const requestId =
            account.provider === "baidu"
              ? directory
              : item.file.parent_id === root
                ? "0"
                : item.file.parent_id;
          const files = await provider.list(account, requestId);
          if (
            this.d.environment(account.id) !== environment ||
            this.d.account(account.id).uid !== account.uid
          )
            throw new AppError(
              "ENVIRONMENT_CHANGED",
              "账号身份或环境已变化，已停止本批登记。",
            );
          const current = files.find(
            (f) =>
              f.id === item.fileId &&
              f.name === item.file!.name &&
              Number(f.isDirectory) === item.file!.is_directory,
          );
          if (!current)
            throw new AppError(
              "DIRECTORY_CHANGED",
              "网盘文件位置或名称已变化，请先更新本地目录。",
            );
          const path = item.file.path;
          const resourceId = this.d.db.transaction(() =>
            writeIndexedDriveResource(this.d.db, owner, {
              title: item.title,
              directory,
              file: { ...current, path },
              time: now(),
            }),
          );
          results.push({ fileId: item.fileId, resourceId });
        } catch (error) {
          if (error instanceof AppError && identityCodes.has(error.code))
            halted = safeMessage(error);
          results.push({ fileId: item.fileId, error: safeMessage(error) });
        }
      }
      this.d.changed();
      return results;
    });
  }
  async settled(accountId: string) {
    await this.active.get(accountId)?.task;
  }
  close() {
    for (const [accountId, active] of this.active) {
      const run = this.current(accountId);
      if (run) {
        const message = "同步已中断，请手动继续。";
        this.update(run, "interrupted", message, {
          event: "sync.interrupted",
          level: "warning",
          message: message + autoRegisterSummary(run.autoRegister),
        });
      }
      active.controller.abort();
    }
    this.closed = true;
  }
}

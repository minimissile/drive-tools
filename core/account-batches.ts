import { setTimeout as delay } from "node:timers/promises";
import {
  accountBatchActive,
  accountBatchInput,
  accountBatchPolicy,
  accountBatchSchema,
  type AccountBatch,
  type AccountBatchInput,
  type AccountBatchItem,
} from "../shared/account-batch";
import { Database, id, now } from "./database";
import { AppError, safeMessage } from "./errors";
export interface BatchAccount {
  id: string;
  alias: string;
  provider: string;
  providerName: string;
  enabled: boolean;
  environmentId: string | null;
  key: string;
}
interface Dependencies {
  db: Database;
  resolve(
    scope: AccountBatchInput["scope"],
    id: string,
    provider: string,
  ): BatchAccount;
  available(environmentId: string): boolean;
  perform(input: AccountBatchInput, accountId: string): Promise<string | null>;
  changed(): void;
  /** Deterministic, short intervals for isolated scheduler tests. */
  stagger?: () => number;
}
const storageKey = "account-batch:current";
/** Explicit read-only batches; independent accounts overlap, a shared environment never does. */
export class AccountBatches {
  private batch: AccountBatch | null;
  private closed = false;
  private completion: Promise<void> = Promise.resolve();
  constructor(private d: Dependencies) {
    const stored = accountBatchSchema.safeParse(d.db.setting(storageKey, null));
    this.batch = stored.success ? stored.data : null;
    if (accountBatchActive(this.batch)) {
      this.batch!.status = "interrupted";
      for (const item of this.batch!.items)
        if (item.status === "running" || item.status === "queued") {
          item.status = "cancelled";
          item.message = "上次运行已中断，请手动重试未完成项。";
          item.finishedAt = now();
        }
      this.save();
    }
  }
  get isBusy() {
    return accountBatchActive(this.batch);
  }
  current() {
    return this.batch ? structuredClone(this.batch) : null;
  }
  private save() {
    if (this.closed || !this.batch) return;
    this.batch.updatedAt = now();
    this.d.db.setSetting(storageKey, this.batch);
    this.d.changed();
  }
  start(raw: AccountBatchInput) {
    const input = accountBatchInput.parse(raw);
    if (this.closed)
      throw new AppError("ACCOUNT_BATCH_CLOSED", "批量调度已停止。");
    if (this.isBusy)
      throw new AppError(
        "ACCOUNT_BATCH_BUSY",
        "已有账号批量操作正在进行，请查看进度或停止排队。",
      );
    if (input.scope !== "drive" && input.action !== "verify")
      throw new AppError(
        "ACCOUNT_BATCH_ACTION",
        "此类账号目前支持批量核验登录。",
      );
    const ids = [...new Set(input.accountIds)];
    const accounts = ids.map((id) =>
      this.d.resolve(input.scope, id, input.provider),
    );
    if (accounts.some((a) => a.provider !== input.provider))
      throw new AppError("ACCOUNT_BATCH_PROVIDER", "请选择同一类型的账号。");
    if (accounts.some((a) => !a.enabled))
      throw new AppError(
        "ACCOUNT_DISABLED",
        "批量操作不包含已停用账号，请调整所选账号。",
      );
    const time = now();
    this.batch = {
      id: id("account_batch"),
      scope: input.scope,
      provider: input.provider,
      providerName: accounts[0].providerName,
      action: input.action,
      status: "running",
      createdAt: time,
      updatedAt: time,
      items: accounts.map((a) => ({
        id: a.id,
        alias: a.alias,
        status: "queued",
        message: "等待错峰启动",
        startedAt: null,
        finishedAt: null,
      })),
    };
    this.save();
    const view = this.current()!;
    this.completion = this.execute({ ...input, accountIds: ids }).catch(
      (error) => {
        if (this.closed || !this.batch) return;
        for (const item of this.batch.items)
          if (item.status === "queued" || item.status === "running") {
            item.status = "failed";
            item.message = safeMessage(error);
            item.finishedAt = now();
          }
        this.batch.status = "completed";
        this.save();
      },
    );
    return view;
  }
  stop(batchId: string) {
    if (!this.batch || this.batch.id !== batchId)
      throw new AppError(
        "ACCOUNT_BATCH_NOT_FOUND",
        "批量操作记录已变化，请刷新后重试。",
      );
    if (!this.isBusy) return this.current()!;
    this.batch.status = "stopping";
    for (const item of this.batch.items)
      if (item.status === "queued") {
        item.status = "cancelled";
        item.message = "已停止排队，未执行此账号。";
        item.finishedAt = now();
      }
    this.save();
    return this.current()!;
  }
  private async execute(input: AccountBatchInput) {
    const batch = this.batch!,
      activeKeys = new Set<string>(),
      running = new Set<Promise<void>>();
    let nextStart = 0;
    const launch = (item: AccountBatchItem, account: BatchAccount) => {
      item.status = "running";
      item.startedAt = now();
      item.message =
        input.action === "verify" ? "正在核验登录" : "正在刷新容量和会员信息";
      activeKeys.add(account.key);
      this.save();
      const task = Promise.resolve()
        .then(() => this.d.perform(input, item.id))
        .then(
          (warning) => {
            if (this.closed) return;
            item.status = warning ? "warning" : "success";
            item.message =
              warning ??
              (input.action === "verify"
                ? "登录核验通过"
                : "容量和会员信息已刷新");
          },
          (error) => {
            if (!this.closed) {
              item.status = "failed";
              item.message = safeMessage(error);
            }
          },
        )
        .finally(() => {
          activeKeys.delete(account.key);
          running.delete(task);
          if (!this.closed) {
            item.finishedAt = now();
            this.save();
          }
        });
      running.add(task);
    };
    while (!this.closed) {
      const queued = batch.items.filter((item) => item.status === "queued");
      if (!queued.length && !running.size) break;
      if (
        batch.status === "running" &&
        running.size < accountBatchPolicy.concurrency &&
        Date.now() >= nextStart
      ) {
        for (const item of queued) {
          let account: BatchAccount;
          try {
            account = this.d.resolve(input.scope, item.id, input.provider);
            if (account.provider !== input.provider || !account.enabled)
              throw new AppError(
                "ACCOUNT_BATCH_CHANGED",
                "账号类型或启用状态已变化，未执行此项。",
              );
          } catch (error) {
            item.status = "failed";
            item.message = safeMessage(error);
            item.finishedAt = now();
            this.save();
            continue;
          }
          if (
            activeKeys.has(account.key) ||
            (account.environmentId && !this.d.available(account.environmentId))
          ) {
            const message = activeKeys.has(account.key)
              ? "等待共用环境的账号完成"
              : "等待关联浏览器环境空闲";
            if (item.message !== message) {
              item.message = message;
              this.save();
            }
            continue;
          }
          launch(item, account);
          const jitter =
            this.d.stagger?.() ??
            accountBatchPolicy.minStaggerMs +
              Math.floor(
                Math.random() *
                  (accountBatchPolicy.maxStaggerMs -
                    accountBatchPolicy.minStaggerMs +
                    1),
              );
          nextStart = Date.now() + Math.max(0, jitter);
          break;
        }
      }
      if (batch.items.some((i) => i.status === "queued") || running.size)
        await Promise.race([
          delay(
            nextStart > Date.now()
              ? Math.min(200, Math.max(10, nextStart - Date.now()))
              : 200,
          ),
          ...running,
        ]);
    }
    if (!this.closed) {
      batch.status = batch.status === "stopping" ? "cancelled" : "completed";
      this.save();
    }
  }
  /** Tests can wait for a finite batch without polling or touching a real browser. */
  async settled() {
    await this.completion;
    return this.current();
  }
  close() {
    if (this.isBusy && this.batch) {
      this.batch.status = "interrupted";
      for (const item of this.batch.items)
        if (item.status === "queued" || item.status === "running") {
          item.status = "cancelled";
          item.message = "调度已中断，未自动重试。";
          item.finishedAt = now();
        }
      this.save();
    }
    this.closed = true;
  }
}

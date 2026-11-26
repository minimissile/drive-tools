import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ShareBackfillRun, ShareBackfillScope } from "../shared/share-backfill";
import type { RuntimeLogEntry } from "../shared/runtime-logs";
import type { Account, ResourceCopy, RemoteFile } from "../shared/types";
import { id, now, parseJson } from "./database";
import { locateResourceParent } from "./drive-resource-location";
import { AppError, ProviderHttpError, safeMessage } from "./errors";
import { parseShare } from "./links";
import type { DriveProvider, OwnShare } from "./providers/provider";
import type { Repository } from "./repository";
import { writeRuntimeLog } from "./runtime-log";
import type { SecretStore } from "./secrets";
import { saveReturnedSharePassphrase } from "./share-passphrases";

const kind = "share-backfill";
const cooldownKey = (accountId: string) => `${kind}:next:${accountId}`;
const codeKey = (itemId: string) => `${kind}:code:${itemId}`;
type Status = ShareBackfillRun["status"];
type ItemState = "pending" | "checking" | "sending" | "uncertain" | "reused" | "created" | "failed";
type Config = ShareBackfillScope & { ownerUid: string };
type Run = { id: string; status: Status; config: string; total: number; message: string };
type Item = { id: string; item_key: string; status: ItemState; data: string };
type ItemData = { copyId: string; title: string; manifest?: string; shareId?: string; checkedAbsent?: boolean };
type Lookup = NonNullable<DriveProvider["ownShareLookup"]> extends (...args: never[]) => Promise<infer T> ? T : never;

interface Dependencies {
  repo: Repository;
  secrets: SecretStore;
  authenticated<T>(id: string, action: (account: Account, provider: DriveProvider) => Promise<T>): Promise<T>;
  assertIdle(accountId: string): void;
  assertMutable(resourceId: string): void;
  afterSaved(copyId: string): Promise<void>;
  changed(): void;
  clock?: () => number;
  interval?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const manifest = (files: RemoteFile[]) => JSON.stringify(files.map((file) => [file.id, file.name, file.isDirectory, file.size]).sort());
const latestCheckInvalid = `EXISTS(SELECT 1 FROM share_checks s WHERE s.copy_id=c.id
  AND s.status='invalid' AND s.checked_at>=c.share_verified_at)`;
const verified = `c.status='ready' AND c.verified_at IS NOT NULL AND c.share_verified_at IS NOT NULL
  AND c.share_id IS NOT NULL AND c.share_url IS NOT NULL AND c.share_owner_uid=c.owner_uid
  AND c.owner_uid=a.uid AND a.enabled=1 AND NOT ${latestCheckInvalid}`;
const rateLimited = (error: unknown) =>
  (error instanceof ProviderHttpError && error.status === 429) ||
  (error instanceof AppError && error.code === "RATE_LIMITED") ||
  /HTTP 429|限流|频繁|分享.*上限|too many requests|rate limit/i.test(safeMessage(error));
const accountBlocked = (error: unknown) => error instanceof AppError &&
  ["AUTH_EXPIRED", "USER_ACTION_REQUIRED", "ACCOUNT_UID_MISMATCH", "QUOTA_EXCEEDED", "ACTIVE_JOBS", "INCOMPLETE_SHARE_HISTORY"].includes(error.code);

export class ShareBackfill {
  private active = new Map<string, AbortController>();
  private closed = false;
  constructor(private d: Dependencies) {
    this.db.transaction(() => {
      this.db.run("UPDATE operation_items SET status=CASE status WHEN 'sending' THEN 'uncertain' ELSE 'pending' END WHERE status IN ('checking','sending') AND run_id IN (SELECT id FROM operation_runs WHERE kind=?)", kind);
      this.db.run("UPDATE operation_runs SET status=CASE WHEN EXISTS(SELECT 1 FROM operation_items i WHERE i.run_id=operation_runs.id AND i.status='uncertain') THEN 'blocked' ELSE 'paused' END,message='上次任务中断，请核对进度后继续。' WHERE kind=? AND status IN ('running','pausing')", kind);
    });
  }
  private get db() { return this.d.repo.db; }
  get isBusy() { return this.active.size > 0; }
  busyAccount(accountId: string) { return this.active.has(accountId); }
  private time() { return this.d.clock?.() ?? Date.now(); }
  private config(run: Run) { return JSON.parse(run.config) as Config; }
  private itemData(item: Item) { return JSON.parse(item.data) as ItemData; }
  private account(accountId: string) {
    const account = this.d.repo.getAccount(accountId);
    if (account.provider !== "quark") throw new AppError("UNSUPPORTED", "批量补录当前支持夸克网盘。");
    if (!account.enabled || !account.uid) throw new AppError("AUTH_EXPIRED", "请先启用并核验该夸克账号。");
    return account;
  }
  private owner(run: Run) {
    const config = this.config(run);
    const account = this.account(config.accountId);
    if (account.uid !== config.ownerUid) throw new AppError("ACCOUNT_UID_MISMATCH", "请登录创建任务时的原夸克账号。");
    return account;
  }
  private latest(accountId: string) {
    return this.db.get<Run>("SELECT id,status,config,total,message FROM operation_runs WHERE kind=? AND json_extract(config,'$.accountId')=? ORDER BY rowid DESC LIMIT 1", kind, accountId);
  }
  private run(runId: string) {
    const run = this.db.get<Run>("SELECT id,status,config,total,message FROM operation_runs WHERE id=? AND kind=?", runId, kind);
    if (!run) throw new AppError("NOT_FOUND", "找不到此补录任务。");
    this.owner(run);
    return run;
  }
  private scan({ accountId, category }: ShareBackfillScope) {
    const account = this.account(accountId);
    const rows = this.db.all<{ resourceId: string; copyId: string | null; title: string; existing: number }>(
      `SELECT r.id AS resourceId, r.title,
        (SELECT c.id FROM copies c WHERE c.resource_id=r.id AND c.account_id=? AND c.owner_uid=?
          AND c.status IN ('recorded','ready') AND c.verified_at IS NOT NULL AND json_array_length(c.files)>0
          ORDER BY c.verified_at DESC,c.id LIMIT 1) AS copyId,
        EXISTS(SELECT 1 FROM copies c JOIN accounts a ON a.id=c.account_id WHERE c.resource_id=r.id AND ${verified}) AS existing
      FROM resources r WHERE EXISTS(SELECT 1 FROM copies c WHERE c.resource_id=r.id AND c.account_id=?)
        AND (? IS NULL OR r.category=?) ORDER BY r.created_at,r.id`,
      accountId, account.uid, accountId, category ?? null, category ?? null,
    );
    const pending = rows.filter((row) => !row.existing && row.copyId !== null);
    const existing = rows.filter((row) => row.existing).length;
    return { account, pending, counts: { existing, pending: pending.length, unavailable: rows.length - existing - pending.length } };
  }
  preview(scope: ShareBackfillScope) { return this.scan(scope).counts; }
  current(accountId: string) {
    this.account(accountId);
    const run = this.latest(accountId);
    return run && this.config(run).ownerUid === this.d.repo.getAccount(accountId).uid ? this.view(run) : null;
  }
  private item(run: Run, states: string) {
    return this.db.get<Item>(`SELECT id,item_key,status,data FROM operation_items WHERE run_id=? AND status IN (${states}) ORDER BY rowid LIMIT 1`, run.id);
  }
  private cooldown(accountId: string) { return this.db.setting(cooldownKey(accountId), 0); }
  private view(run: Run): ShareBackfillRun {
    const { accountId, category } = this.config(run);
    const counts = new Map(this.db.all<{ status: ItemState; n: number }>("SELECT status,count(*) n FROM operation_items WHERE run_id=? GROUP BY status", run.id).map((row) => [row.status, row.n]));
    const item = this.item(run, "'checking','sending','uncertain'");
    const data = item && this.itemData(item);
    const logs = this.db.all<Omit<RuntimeLogEntry, "details">>(
      "SELECT id,domain,level,event,message,account_id AS accountId,task_id AS taskId,created_at AS createdAt FROM runtime_logs WHERE domain=? AND account_id=? AND task_id=? ORDER BY id DESC LIMIT 100",
      kind, accountId, run.id,
    );
    const nextCreateAt = this.cooldown(accountId);
    return {
      id: run.id, status: run.status, category, total: run.total, message: run.message,
      pending: (counts.get("pending") ?? 0) + Number(!!item),
      reused: counts.get("reused") ?? 0, created: counts.get("created") ?? 0, failed: counts.get("failed") ?? 0,
      nextCreateAt: nextCreateAt > this.time() ? nextCreateAt : null,
      current: item && data ? { title: data.title, state: item.status as "checking" | "sending" | "uncertain", canConfirmAbsent: !!data.checkedAbsent && !data.shareId } : null,
      logs: logs.map((entry) => ({ ...entry, details: {} })),
    };
  }
  private status(run: Run, status: Status, message = "") {
    this.db.run("UPDATE operation_runs SET status=?,message=?,updated_at=? WHERE id=?", status, message, now(), run.id);
  }
  private saveItem(item: Item, status: ItemState, data: ItemData) {
    this.db.run("UPDATE operation_items SET status=?,data=? WHERE id=?", status, JSON.stringify(data), item.id);
    item.status = status;
    item.data = JSON.stringify(data);
  }
  private log(run: Run, message: string, level: RuntimeLogEntry["level"] = "info") {
    writeRuntimeLog(this.db, kind, { level, event: kind, message, accountId: this.config(run).accountId, taskId: run.id });
  }
  start(scope: ShareBackfillScope) {
    const { account, pending } = this.scan(scope);
    const current = this.latest(account.id);
    if (this.active.has(account.id) || (current && this.config(current).ownerUid === account.uid && current.status !== "completed"))
      throw new AppError("ACTIVE_JOBS", "该账号已有未完成的补录任务，请继续原任务。");
    if (!pending.length) throw new AppError("NOTHING_TO_DO", "所选范围没有待补录的本人资源。");
    this.d.assertIdle(account.id);
    const runId = id(kind);
    this.db.transaction(() => {
      this.db.run("INSERT INTO operation_runs(id,kind,title,status,config,total,created_at,updated_at) VALUES(?,?,?,'running',?,?,?,?)",
        runId, kind, "批量补录分享", JSON.stringify({ ...scope, ownerUid: account.uid }), pending.length, now(), now());
      const insert = this.db.db.prepare("INSERT INTO operation_items(id,run_id,item_key,status,data) VALUES(?,?,?,'pending',?)");
      for (const row of pending) insert.run(id("share_item"), runId, row.resourceId, JSON.stringify({ copyId: row.copyId, title: row.title }));
      this.log(this.run(runId), `开始补录 ${pending.length} 项资源。`);
    });
    this.launch(this.run(runId));
    return this.view(this.run(runId));
  }
  pause(runId: string) {
    const run = this.run(runId), accountId = this.config(run).accountId;
    if (run.status === "running") {
      this.status(run, "pausing", "正在暂停，已提交的建链会先核对结果。");
      this.active.get(accountId)?.abort();
      this.d.changed();
    }
    return this.view(this.run(runId));
  }
  resume(runId: string) {
    const run = this.run(runId), accountId = this.config(run).accountId;
    if (["running", "pausing", "completed"].includes(run.status) || this.active.has(accountId))
      throw new AppError("ACTIVE_JOBS", "此任务当前无法继续。");
    if (this.item(run, "'uncertain','sending'")) throw new AppError("SHARE_CREATION_PENDING", "请先核对上次建链结果。");
    this.d.assertIdle(accountId);
    this.status(run, "running");
    this.log(run, "继续补录剩余资源。");
    this.launch(run);
    return this.view(this.run(runId));
  }
  private launch(run: Run) {
    const accountId = this.config(run).accountId;
    const controller = new AbortController();
    this.active.set(accountId, controller);
    this.d.changed();
    void this.execute(run, controller.signal).catch((error: unknown) => {
      if (this.closed) return;
      const message = safeMessage(error);
      this.status(run, "blocked", message);
      this.log(run, message, "error");
    }).finally(() => {
      this.active.delete(accountId);
      if (!this.closed) this.d.changed();
    });
  }
  private existing(resourceId: string) {
    return !!this.db.get(`SELECT 1 FROM copies c JOIN accounts a ON a.id=c.account_id WHERE c.resource_id=? AND ${verified} LIMIT 1`, resourceId);
  }
  private target(run: Run, item: Item, data: ItemData): ResourceCopy {
    const copy = this.d.repo.getCopy(data.copyId), owner = this.owner(run);
    this.d.assertMutable(item.item_key);
    if (copy.resourceId !== item.item_key || copy.accountId !== owner.id || copy.ownerUid !== owner.uid ||
      !copy.verifiedAt || !copy.files.length || (data.manifest && manifest(copy.files) !== data.manifest))
      throw new AppError("FILES_CHANGED", "资源归属或文件清单已变化，请核对原资源。");
    return copy;
  }
  private async shareLookup(account: Account, provider: DriveProvider) {
    if (!provider.ownShareLookup) throw new AppError("UNSUPPORTED", "当前夸克连接无法读取完整本人分享记录。");
    return provider.ownShareLookup(account);
  }
  private async archive(run: Run, item: Item, data: ItemData, share: OwnShare, state: "reused" | "created") {
    const copy = this.target(run, item, data);
    const parsed = parseShare(share.url, share.code);
    if (share.ownerUid !== copy.ownerUid || parsed.provider !== "quark" || !share.id)
      throw new AppError("OWNERSHIP_UNVERIFIED", "分享与当前资源的本人账号不一致。");
    if (this.existing(item.item_key)) {
      this.saveItem(item, "reused", data);
      return;
    }
    if (this.db.get("SELECT 1 FROM copies WHERE share_url=? AND resource_id<>? LIMIT 1", parsed.url, item.item_key))
      throw new AppError("SHARE_ALREADY_ASSIGNED", "该分享已关联其他资源，请人工核对。");
    await this.d.secrets.set(`share:${copy.id}`, parsed.code, { preserveEmpty: true });
    if (this.closed) throw new Error("补录服务已停止。");
    this.db.transaction(() => {
      this.target(run, item, data);
      this.db.run("UPDATE copies SET status='ready',share_id=?,share_url=?,share_owner_uid=?,share_version=share_version+1,share_verified_at=?,error=NULL,updated_at=? WHERE id=?",
        share.id, parsed.url, share.ownerUid, now(), now(), copy.id);
      this.saveItem(item, state, data);
      this.log(run, `${state === "created" ? "已创建并补录" : "已复用"} · ${data.title}`);
    });
    await saveReturnedSharePassphrase(this.d.secrets, { key: `share-passphrase:copy:${copy.id}`, provider: "quark", accountId: copy.accountId, ownerUid: share.ownerUid, shareId: share.id, url: parsed.url, code: parsed.code }, share);
    if (!this.closed) await this.d.afterSaved(copy.id).catch(() => this.log(run, `${data.title} · 分享已保存，关联入口同步需检查。`, "warning"));
    this.d.secrets.remove(codeKey(item.id));
  }
  private async execute(run: Run, signal: AbortSignal) {
    const { accountId } = this.config(run);
    let lookup: Lookup | undefined;
    while (!signal.aborted && !this.closed) {
      this.owner(run);
      const item = this.item(run, "'pending'");
      if (!item) {
        this.status(run, "completed", "本批补录已处理完毕。");
        this.log(run, "本批补录已处理完毕。");
        return;
      }
      const data = this.itemData(item);
      this.saveItem(item, "checking", data);
      this.d.changed();
      try {
        this.d.assertIdle(accountId);
        await this.d.authenticated(accountId, async (account, provider) => {
          if (signal.aborted || this.closed) return;
          const copy = this.target(run, item, data);
          if (account.uid !== copy.ownerUid) throw new AppError("ACCOUNT_UID_MISMATCH", "请登录原夸克账号。");
          if (this.existing(item.item_key)) {
            this.saveItem(item, "reused", data);
            this.log(run, `已有可用分享 · ${data.title}`);
            return;
          }
          data.manifest = manifest(copy.files);
          lookup ??= await this.shareLookup(account, provider);
          const prior = await lookup(copy.files);
          if (signal.aborted || this.closed) return;
          if (prior) await this.archive(run, item, data, prior, "reused");
        });
        if (signal.aborted || this.closed) break;
        if (item.status !== "checking") continue;
        const wait = Math.max(0, this.cooldown(accountId) - this.time());
        if (wait) {
          this.d.changed();
          await (this.d.wait?.(wait, signal) ?? delay(wait, undefined, { signal }));
        }
        if (signal.aborted || this.closed) break;
        this.d.assertIdle(accountId);
        await this.d.authenticated(accountId, async (account, provider) => {
          if (signal.aborted || this.closed) return;
          const copy = this.target(run, item, data);
          if (account.uid !== copy.ownerUid) throw new AppError("ACCOUNT_UID_MISMATCH", "请登录原夸克账号。");
          if (this.existing(item.item_key)) {
            this.saveItem(item, "reused", data);
            return;
          }
          if (!provider.createShareWithOptions) throw new AppError("UNSUPPORTED", "当前账号不支持创建分享。");
          const directory = await locateResourceParent(account, provider, copy);
          const files = copy.files.map((expected) => directory.files.find((file) =>
            file.id === expected.id && file.name === expected.name && file.isDirectory === expected.isDirectory &&
            (file.isDirectory || expected.size == null || expected.size === file.size)));
          if (files.some((file) => !file)) throw new AppError("FILES_CHANGED", "资源文件已变化，请核对原目录。");
          if (signal.aborted || this.closed) return;
          this.target(run, item, data);
          if (this.existing(item.item_key)) {
            this.saveItem(item, "reused", data);
            return;
          }
          this.saveItem(item, "sending", data);
          this.d.changed();
          try {
            const share = await provider.createShareWithOptions(account, files as RemoteFile[], data.title, { expiresInDays: 0 }, async (returned) => {
              if (this.closed || returned.ownerUid !== account.uid || !returned.id) return;
              data.shareId = returned.id;
              this.saveItem(item, "sending", data);
              if (returned.code) await this.d.secrets.set(codeKey(item.id), returned.code);
            });
            if (this.closed) return;
            data.shareId = share.id;
            this.saveItem(item, "sending", data);
            if (!share.code) throw new AppError("SHARE_CODE_UNAVAILABLE", "分享已返回，提取码待核对。", true);
            await this.archive(run, item, data, share, "created");
          } finally {
            if (!this.closed) this.db.setSetting(cooldownKey(accountId), this.time() + (this.d.interval?.() ?? randomInt(30, 61) * 1000));
          }
        });
      } catch (error) {
        if (this.closed) return;
        const limited = rateLimited(error);
        const waiting = error instanceof ProviderHttpError ? error.retryAfterMs : null;
        if (waiting != null) this.db.setSetting(cooldownKey(accountId), Math.max(this.cooldown(accountId), this.time() + waiting));
        const rejected = error instanceof ProviderHttpError && error.status === 429 && !data.shareId;
        const uncertain = item.status === "sending" && !rejected;
        if (uncertain || limited || accountBlocked(error) || error instanceof AppError && error.code === "SHARE_ALREADY_ASSIGNED") {
          this.saveItem(item, uncertain ? "uncertain" : "pending", data);
          const message = limited ? "夸克限制了请求，已暂停此账号。" : uncertain ? "建链结果待核对，已暂停此账号。" : safeMessage(error);
          this.status(run, "blocked", message);
          this.log(run, `${data.title} · ${message}`, "warning");
          return;
        }
        if (signal.aborted) break;
        this.saveItem(item, "failed", data);
        this.log(run, `${data.title} · ${safeMessage(error)}`, "warning");
      } finally {
        if (!this.closed) {
          if (["reused", "created", "failed"].includes(item.status)) this.db.run("UPDATE operation_runs SET done=done+1,updated_at=? WHERE id=?", now(), run.id);
          if (signal.aborted && item.status === "checking") this.saveItem(item, "pending", data);
          this.d.changed();
        }
      }
    }
    if (!this.closed) {
      this.status(run, "paused", "已暂停，补录进度已保存。");
      this.log(run, "已暂停补录。");
    }
  }
  async recheck(runId: string) {
    const run = this.run(runId), { accountId } = this.config(run);
    const item = this.item(run, "'uncertain'");
    if (!item || this.active.has(accountId)) throw new AppError("ACTIVE_JOBS", "没有可核对的建链结果。");
    this.d.assertIdle(accountId);
    this.active.set(accountId, new AbortController());
    const data = this.itemData(item);
    try {
      await this.d.authenticated(accountId, async (account, provider) => {
        const copy = this.target(run, item, data);
        if (account.uid !== copy.ownerUid) throw new AppError("ACCOUNT_UID_MISMATCH", "请登录原夸克账号。");
        const lookup = await this.shareLookup(account, provider);
        const share = await lookup(copy.files, data.shareId);
        if (this.closed) return;
        if (!share) {
          this.saveItem(item, "uncertain", { ...data, checkedAbsent: !data.shareId });
          this.status(run, "blocked", "分享历史中尚未核对到原结果，请在夸克官网确认。");
          this.log(run, `${data.title} · 尚未核对到原结果。`, "warning");
          return;
        }
        const savedCode = await this.d.secrets.get(codeKey(item.id));
        await this.archive(run, item, data, { ...share, code: share.code || savedCode || "" }, "created");
        this.db.run("UPDATE operation_runs SET done=done+1 WHERE id=?", run.id);
        this.status(run, "paused", "上次分享已核对，可以继续补录。");
      });
      return this.view(this.run(runId));
    } finally {
      this.active.delete(accountId);
      if (!this.closed) this.d.changed();
    }
  }
  confirmAbsent(runId: string) {
    const run = this.run(runId), item = this.item(run, "'uncertain'");
    if (!item || this.active.has(this.config(run).accountId)) throw new AppError("ACTIVE_JOBS", "没有可确认的原请求。");
    const data = this.itemData(item);
    if (!data.checkedAbsent || data.shareId) throw new AppError("SHARE_CREATION_PENDING", "请先只读核对原请求。");
    this.saveItem(item, "pending", { ...data, checkedAbsent: false });
    this.status(run, "paused", "已记录未创建，可以继续补录。");
    this.log(run, `${data.title} · 已确认原请求未创建。`);
    this.d.changed();
    return this.view(this.run(runId));
  }
  close() {
    this.closed = true;
    for (const controller of this.active.values()) controller.abort();
  }
}

import { z } from "zod";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
  chmod,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { Database, id, now } from "./database";
import { Repository } from "./repository";
import { SecretStore, type SecretCodec } from "./secrets";
import { AccountMutex, TransferQueue } from "./queue";
import { NoteExporter } from "./notes";
import { AiService } from "./ai";
import { TrafficService } from "./traffic";
import { BitBrowser } from "./bitbrowser";
import { BulkImporter } from "./bulk";
import { inspectBackup, stageRestore } from "./backups";
import { localTemplate } from "./templates";
import { Operations } from "./operations";
import { AppError, safeMessage } from "./errors";
import { csv } from "./csv";
import {
  parseShare,
  validateEditorUrl,
  validateOutgoingLinks,
  validateLoopback,
  validatePublicationUrl,
} from "./links";
import {
  normalizedDirectory,
  assertManifest,
  type DriveProvider,
} from "./providers/provider";
import type {
  Account,
  BrowserBinding,
  Provider,
  ResourceInput,
  ResourceCopy,
  BackupPreview,
  ShareCheck,
} from "../shared/types";
import { platformSpecs } from "../shared/platforms";
import {
  endpointSchema,
  fileSchema,
  keywordSchema,
  platformSchema,
  providerSchema,
  querySchema,
  resourceInputSchema,
} from "../shared/schemas";

export interface AppPorts {
  login(account: Account): Promise<void>;
  clearSession(accountId: string): Promise<void>;
  closeAccountWindow(accountId: string): Promise<void>;
  chooseDirectory(
    kind: "vault" | "backup" | "restore" | "content",
  ): Promise<string | null>;
  readText(
    kind: "csv" | "summary",
  ): Promise<{ name: string; text: string } | null>;
  activateDataPath(path: string): Promise<void>;
  normalizeCover(bytes: Buffer): Promise<Buffer>;
  openPath(path: string): Promise<void>;
  openAccountPage(account: Account, url: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  saveFile(name: string, bytes: Buffer): Promise<string | null>;
}
export class AppService {
  readonly db: Database;
  readonly repo: Repository;
  readonly secrets: SecretStore;
  readonly queue: TransferQueue;
  readonly notes: NoteExporter;
  readonly ai: AiService;
  readonly traffic: TrafficService;
  readonly bit: BitBrowser;
  readonly importer: BulkImporter;
  readonly operations: Operations;
  private backupPreview: (BackupPreview & { hash: string }) | null = null;
  private switchingWorkspace = false;
  readonly mutex = new AccountMutex();
  constructor(
    readonly dataPath: string,
    codec: SecretCodec,
    private providers: Record<Provider, DriveProvider>,
    private ports: AppPorts,
    private changed: () => void,
    dbPath = join(dataPath, "panxu.db"),
  ) {
    this.db = new Database(dbPath);
    this.repo = new Repository(this.db);
    this.secrets = new SecretStore(this.db, codec);
    this.notes = new NoteExporter(this.repo, this.secrets, dataPath);
    this.queue = new TransferQueue(
      this.repo,
      providers,
      this.secrets,
      this.notes,
      this.mutex,
      changed,
    );
    this.ai = new AiService(this.repo, this.secrets, changed);
    this.traffic = new TrafficService(this.db, this.secrets, changed);
    this.bit = new BitBrowser(async () => ({
      url: this.db.setting("bitUrl", ""),
      key: await this.secrets.get("bit"),
    }));
    this.importer = new BulkImporter(this.repo, (input) =>
      this.saveResource(input),
    );
    this.operations = new Operations(
      this.repo,
      providers,
      this.secrets,
      this.notes,
      (id) => this.verifyAccount(id),
      changed,
    );
    for (const kind of [
      "batch_inspect",
      "split_preview",
      "split_share",
    ] as const)
      this.queue.workers[kind] = (jobId) => this.operations.execute(jobId);
    this.queue.onAccountBlocked = (accountId, stage, message) =>
      this.operations.pauseAccount(accountId, stage, message);
  }
  snapshot(resourceId?: string) {
    return this.repo.snapshot(
      (key) => this.secrets.has(key),
      this.dataPath,
      resourceId,
    );
  }
  private account(id: string) {
    const a = this.repo.getAccount(id);
    if (!a.enabled)
      throw new AppError("ACCOUNT_DISABLED", "该账号已停用，请先启用。");
    return a;
  }
  private async verifyAccount(accountId: string) {
    try {
      const account = this.account(accountId),
        identity = await this.providers[account.provider].identity(account);
      if (account.uid && identity.uid !== account.uid)
        throw new AppError(
          "ACCOUNT_UID_MISMATCH",
          "此登录窗口的UID与原账号不同。请退出后登录原账号，或新建账号记录。",
        );
      const duplicate = this.repo
        .accounts()
        .find(
          (a) =>
            a.id !== account.id &&
            a.provider === account.provider &&
            a.uid === identity.uid,
        );
      if (duplicate)
        throw new AppError(
          "DUPLICATE_ACCOUNT",
          `此UID已绑定「${duplicate.alias}」，请使用该账号记录。`,
        );
      this.db.run(
        "UPDATE accounts SET uid=?,status=?,verified_at=?,error=NULL,updated_at=? WHERE id=?",
        identity.uid,
        "connected",
        now(),
        now(),
        account.id,
      );
      this.changed();
      return this.repo.getAccount(account.id);
    } catch (error) {
      this.db.run(
        "UPDATE accounts SET status=?,error=?,updated_at=? WHERE id=?",
        "expired",
        safeMessage(error),
        now(),
        accountId,
      );
      this.changed();
      throw error;
    }
  }
  async authenticated<T>(
    accountId: string,
    fn: (account: Account, provider: DriveProvider) => Promise<T>,
  ) {
    return this.mutex.run(accountId, async () => {
      const a = await this.verifyAccount(accountId);
      return fn(a, this.providers[a.provider]);
    });
  }
  async invoke(method: string, raw: unknown = undefined): Promise<unknown> {
    if (this.switchingWorkspace && method !== "snapshot")
      throw new AppError(
        "WORKSPACE_SWITCHING",
        "工作空间正在切换，请等待应用重启。",
      );
    const object = raw ?? {};
    switch (method) {
      case "snapshot":
        return this.snapshot(
          z.object({ resourceId: z.string().max(100).optional() }).parse(object)
            .resourceId,
        );
      case "resource.search":
        return this.repo.resources(
          z.object({ query: z.string().max(200) }).parse(object).query,
        );
      case "resource.get": {
        const { id } = z.object({ id: z.string() }).parse(object);
        return this.repo.getResource(id);
      }
      case "resource.page":
        return this.repo.resourcePage(
          z
            .object({
              query: z.string().max(200).default(""),
              category: z.string().max(60).default("all"),
              accountId: z.string().max(100).default("all"),
              page: z.number().int().min(1).max(100000).default(1),
              pageSize: z.number().int().min(1).max(100).default(25),
            })
            .parse(object),
        );
      case "resource.importPreview": {
        const { text, targets } = z
          .object({
            text: z.string().max(2_000_000),
            targets: z
              .object({
                quark: z.string().optional(),
                baidu: z.string().optional(),
              })
              .default({}),
          })
          .parse(object);
        return this.importer.preview(text, targets);
      }
      case "resource.importCommit": {
        const { token, rows } = z
          .object({
            token: z.string(),
            rows: z.array(z.number().int().min(2).max(501)).max(500),
          })
          .parse(object);
        return this.importer.commit(token, rows);
      }
      case "resource.importFile":
        return this.ports.readText("csv");
      case "resource.summaryFile":
        return this.ports.readText("summary");
      case "batch.candidates": {
        const i = z
          .object({
            query: z.string().max(200).default(""),
            accountId: z.string().default("all"),
            page: z.number().int().min(1).max(100000).default(1),
          })
          .parse(object);
        return this.operations.candidates(i.query, i.accountId, i.page);
      }
      case "batch.list":
        return this.operations.batches();
      case "batch.get":
        return this.operations.batch(
          z.object({ id: z.string() }).parse(object).id,
        );
      case "batch.preview": {
        const { copyIds } = z
          .object({ copyIds: z.array(z.string()).min(1).max(100) })
          .parse(object);
        const result = this.operations.createBatch(copyIds);
        void this.queue.pump();
        return result;
      }
      case "batch.selection": {
        const i = z
          .object({ itemId: z.string(), fileIds: z.array(z.string()).max(100) })
          .parse(object);
        return this.operations.selectBatchItem(i.itemId, i.fileIds);
      }
      case "batch.start": {
        const i = z
          .object({
            id: z.string(),
            itemIds: z.array(z.string()).min(1).max(100),
            rightsConfirmed: z.literal(true),
          })
          .parse(object);
        const batch = this.operations.batch(i.id);
        for (const accountId of new Set(
          batch.items
            .filter((item) => i.itemIds.includes(item.id))
            .map((item) => item.accountId),
        ))
          await this.ports.closeAccountWindow(accountId);
        const result = this.operations.startBatch(i.id, i.itemIds);
        void this.queue.pump();
        return result;
      }
      case "batch.cancel":
      case "batch.retry":
      case "split.cancel": {
        const { id } = z.object({ id: z.string() }).parse(object),
          ids =
            method === "split.cancel"
              ? this.operations.splitJobs(id)
              : this.operations.batchJobs(id);
        for (const jobId of ids) {
          const job = this.repo.getJob(jobId);
          if (
            method === "batch.retry" &&
            ["failed", "waiting_login", "needs_review", "cancelled"].includes(
              job.stage,
            )
          )
            await this.invoke("job.retry", { id: jobId });
          else if (
            method !== "batch.retry" &&
            !["completed", "cancelled"].includes(job.stage)
          )
            await this.invoke("job.cancel", { id: jobId });
        }
        return true;
      }
      case "split.list":
        return this.operations.splits(
          z.object({ copyId: z.string() }).parse(object).copyId,
        );
      case "split.get":
        return this.operations.split(
          z.object({ id: z.string() }).parse(object).id,
        );
      case "split.preview": {
        const i = z
          .object({
            copyId: z.string(),
            depth: z.number().int().min(1).max(3),
            mode: z.enum(["level", "all"]).default("level"),
          })
          .parse(object);
        const result = this.operations.createSplit(i.copyId, i.depth, i.mode);
        void this.queue.pump();
        return result;
      }
      case "split.start": {
        const i = z
            .object({
              id: z.string(),
              itemIds: z.array(z.string()).min(1).max(100),
              rightsConfirmed: z.literal(true),
            })
            .parse(object),
          run = this.operations.split(i.id);
        await this.ports.closeAccountWindow(
          this.repo.getCopy(run.copyId).accountId,
        );
        const result = this.operations.startSplit(i.id, i.itemIds);
        void this.queue.pump();
        return result;
      }
      case "split.link": {
        const i = z
            .object({
              itemId: z.string(),
              includeCode: z.boolean().default(true),
            })
            .parse(object),
          item = this.operations.splitItem(i.itemId);
        return this.authenticated(
          this.repo.getCopy(item.copyId).accountId,
          () => this.operations.splitLink(item.id, i.includeCode),
        );
      }
      case "split.recover": {
        const i = z
            .object({
              itemId: z.string(),
              text: z.string().min(1).max(8000),
              code: z.string().max(30).optional(),
            })
            .parse(object),
          item = this.operations.splitItem(i.itemId);
        if (
          item.jobId &&
          ["queued", "preflight", "verifying", "sharing", "archiving"].includes(
            this.repo.getJob(item.jobId).stage,
          )
        )
          throw new AppError(
            "JOB_RUNNING",
            "该拆分项仍在执行，请先停止本地等待。",
          );
        return this.authenticated(
          this.repo.getCopy(item.copyId).accountId,
          () => this.operations.recoverSplit(item.id, i.text, i.code),
        );
      }
      case "split.package":
      case "split.export": {
        const i = z
            .object({
              id: z.string(),
              itemIds: z.array(z.string()).min(1).max(100),
              includeCodes: z.boolean().default(false),
            })
            .parse(object),
          run = this.operations.split(i.id);
        if (i.itemIds.some((id) => !run.items.some((item) => item.id === id)))
          throw new AppError("INVALID_SELECTION", "拆分项不属于该预览。");
        const rows: (string | number)[][] = [
          ["路径", "标题", "本人网盘链接", "提取码"],
        ];
        for (const itemId of new Set(i.itemIds)) {
          const link = (await this.invoke("split.link", {
            itemId,
            includeCode: i.includeCodes,
          })) as { path: string; title: string; url: string; code: string };
          rows.push([link.path, link.title, link.url, link.code]);
        }
        if (method === "split.package")
          return {
            text: rows
              .slice(1)
              .map(
                (row) =>
                  `${row[0]}\n${row[2]}${row[3] ? `\n提取码：${row[3]}` : ""}`,
              )
              .join("\n\n"),
          };
        return this.ports.saveFile(
          "本人拆分链接.csv",
          Buffer.from(csv(rows), "utf8"),
        );
      }
      case "account.add": {
        const input = z
            .object({
              provider: providerSchema,
              alias: z.string().trim().min(1).max(60),
            })
            .parse(object),
          accountId = id("account"),
          time = now();
        const isDefault = !this.repo
          .accounts()
          .some((a) => a.provider === input.provider && a.enabled);
        this.db.run(
          "INSERT INTO accounts(id,provider,alias,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?)",
          accountId,
          input.provider,
          input.alias,
          Number(isDefault),
          time,
          time,
        );
        this.changed();
        return this.repo.getAccount(accountId);
      }
      case "account.update": {
        const input = z
          .object({
            id: z.string(),
            alias: z.string().trim().min(1).max(60),
            defaultDirectory: z.string().max(500),
            enabled: z.boolean(),
          })
          .parse(object);
        const account = this.repo.getAccount(input.id);
        if (!input.enabled) this.assertNoActiveJobs(account.id);
        this.db.run(
          "UPDATE accounts SET alias=?,default_directory=?,enabled=?,status=CASE WHEN ?=0 THEN ? WHEN uid IS NOT NULL THEN ? ELSE ? END,updated_at=? WHERE id=?",
          input.alias,
          normalizedDirectory(input.defaultDirectory),
          Number(input.enabled),
          Number(input.enabled),
          "disabled",
          account.status === "disabled" ? "expired" : account.status,
          "disconnected",
          now(),
          input.id,
        );
        if (!input.enabled)
          this.db.run("UPDATE accounts SET is_default=0 WHERE id=?", input.id);
        this.changed();
        return this.repo.getAccount(input.id);
      }
      case "account.default": {
        const { id: accountId } = z.object({ id: z.string() }).parse(object),
          account = this.account(accountId);
        this.db.transaction(() => {
          this.db.run(
            "UPDATE accounts SET is_default=0 WHERE provider=?",
            account.provider,
          );
          this.db.run(
            "UPDATE accounts SET is_default=1 WHERE id=?",
            account.id,
          );
        });
        this.changed();
        return true;
      }
      case "account.login": {
        const { id: accountId } = z.object({ id: z.string() }).parse(object);
        this.assertNoActiveJobs(accountId);
        await this.ports.login(this.account(accountId));
        return true;
      }
      case "account.check": {
        const { id: accountId } = z.object({ id: z.string() }).parse(object);
        const account = await this.mutex.run(accountId, () =>
          this.verifyAccount(accountId),
        );
        await this.ports.closeAccountWindow(accountId);
        this.db.run(
          "UPDATE jobs SET stage=?,error=NULL WHERE copy_id IN (SELECT id FROM copies WHERE account_id=?) AND stage=?",
          "queued",
          account.id,
          "waiting_login",
        );
        void this.queue.pump();
        return account;
      }
      case "account.clear": {
        const { id: accountId } = z.object({ id: z.string() }).parse(object);
        this.assertNoActiveJobs(accountId);
        await this.ports.clearSession(accountId);
        this.db.run(
          "UPDATE accounts SET status=?,enabled=0,is_default=0,verified_at=NULL WHERE id=?",
          "disabled",
          accountId,
        );
        this.changed();
        return true;
      }
      case "share.parse": {
        const { text, code } = z
          .object({
            text: z.string().max(8000),
            code: z.string().max(30).optional(),
          })
          .parse(object);
        return parseShare(text, code);
      }
      case "share.inspect": {
        const input = z
            .object({
              accountId: z.string(),
              sourceText: z.string().max(8000),
              code: z.string().max(30).optional(),
              resourceId: z.string().optional(),
              parentId: z.string().max(1000).default("0"),
              page: z.number().int().min(1).max(100).default(1),
            })
            .parse(object),
          source = parseShare(input.sourceText, input.code);
        if (
          !source.code &&
          input.resourceId &&
          this.repo.getResource(input.resourceId).sourceUrl === source.url
        )
          source.code =
            (await this.secrets.get(`source:${input.resourceId}`)) ?? "";
        return this.authenticated(input.accountId, async (a, p) => {
          if (a.provider !== source.provider)
            throw new AppError(
              "CROSS_PROVIDER_UNSUPPORTED",
              "首版仅支持同网盘转存。",
            );
          return p.inspect(a, source, input.parentId, input.page);
        });
      }
      case "directory.list": {
        const { accountId, parentId } = z
          .object({ accountId: z.string(), parentId: z.string().max(1000) })
          .parse(object);
        return this.authenticated(accountId, async (a, p) =>
          (await p.list(a, parentId)).filter((f) => f.isDirectory),
        );
      }
      case "resource.save":
        return this.saveResource(resourceInputSchema.parse(object));
      case "cover.export": {
        const { id: coverId } = z
          .object({ id: z.string().regex(/^[a-f0-9]{64}$/) })
          .parse(object);
        return this.ports.saveFile(
          "资源封面.png",
          await readFile(join(this.dataPath, "covers", `${coverId}.png`)),
        );
      }
      case "copy.link": {
        const { copyId } = z.object({ copyId: z.string() }).parse(object);
        const copy = this.repo.getCopy(copyId),
          account = this.assertOwnCopy(copy);
        await this.authenticated(account.id, async (a, p) => {
          if (!(await p.verifyShare(a, copy.shareId!, copy.files)))
            throw new AppError("SHARE_INVALID", "本人分享未能通过有效性检查。");
        });
        const code = await this.secrets.get(`share:${copy.id}`);
        return { text: `${copy.shareUrl}${code ? `\n提取码：${code}` : ""}` };
      }
      case "copies.check": {
        const { copyIds } = z
          .object({ copyIds: z.array(z.string()).min(1).max(25) })
          .parse(object);
        const results: ShareCheck[] = [];
        for (const copyId of new Set(copyIds))
          results.push(await this.checkShare(copyId));
        return results;
      }
      case "cover.get": {
        const { id: coverId } = z
          .object({ id: z.string().regex(/^[a-f0-9]{64}$/) })
          .parse(object);
        return (
          "data:image/png;base64," +
          (
            await readFile(join(this.dataPath, "covers", `${coverId}.png`))
          ).toString("base64")
        );
      }
      case "job.retry": {
        const { id: jobId } = z.object({ id: z.string() }).parse(object);
        const job = this.repo.getJob(jobId);
        if (
          !["waiting_login", "needs_review", "failed", "cancelled"].includes(
            job.stage,
          )
        )
          throw new AppError("JOB_RUNNING", "任务仍在运行或已完成。");
        this.account(job.accountId);
        await this.ports.closeAccountWindow(job.accountId);
        this.db.run(
          "UPDATE jobs SET stage=?,error=NULL,attempts=attempts+1,updated_at=? WHERE id=?",
          "queued",
          now(),
          jobId,
        );
        this.changed();
        void this.queue.pump();
        return true;
      }
      case "job.cancel": {
        const { id: jobId } = z.object({ id: z.string() }).parse(object);
        const job = this.repo.getJob(jobId);
        if (job.stage === "completed")
          throw new AppError("JOB_COMPLETED", "任务已完成，不需要取消。");
        this.db.run(
          "UPDATE jobs SET stage=?,error=?,updated_at=? WHERE id=?",
          "cancelled",
          "本地等待已停止，未撤销网盘已执行的操作。",
          now(),
          jobId,
        );
        if (job.kind === "transfer")
          this.db.run(
            "UPDATE copies SET status=?,error=? WHERE id=?",
            ["new", "folder_ready"].includes(job.checkpoint)
              ? "draft"
              : "needs_review",
            "请核对远端结果；不会自动删除文件。",
            job.copyId,
          );
        else this.operations.cancelled(job);
        this.changed();
        return true;
      }
      case "copy.open": {
        const { id: copyId } = z.object({ id: z.string() }).parse(object);
        const copy = this.repo.getCopy(copyId),
          resource = this.repo.getResource(copy.resourceId);
        this.assertNoActiveJobs(copy.accountId);
        await this.ports.openAccountPage(
          this.account(copy.accountId),
          copy.shareUrl ??
            (resource.provider === "quark"
              ? "https://pan.quark.cn/"
              : "https://pan.baidu.com/disk/main"),
        );
        return true;
      }
      case "copy.createShare":
      case "copy.recoverShare": {
        const { copyId, text, code } = z
          .object({
            copyId: z.string(),
            text: z.string().max(8000).default(""),
            code: z.string().max(30).optional(),
          })
          .parse(object);
        const copy = this.repo.getCopy(copyId),
          resource = this.repo.getResource(copy.resourceId),
          source = text ? parseShare(text, code) : null;
        if (
          !copy.folderId ||
          !copy.ownerUid ||
          !copy.verifiedAt ||
          !copy.files.length ||
          (source &&
            (source.url === resource.sourceUrl ||
              source.provider !== resource.provider)) ||
          (method === "copy.recoverShare" && !source)
        )
          throw new AppError(
            "OWNERSHIP_UNVERIFIED",
            "请先完成目标文件核验，并填写本人新建的分享链接。",
          );
        this.assertNoActiveJobs(copy.accountId);
        return this.authenticated(copy.accountId, async (a, p) => {
          if (a.uid !== copy.ownerUid)
            throw new AppError("ACCOUNT_UID_MISMATCH", "文件归属UID不匹配。");
          const actual = await p.list(a, copy.folderId!);
          assertManifest(copy.files, actual);
          if (
            actual.length !== copy.files.length ||
            !copy.files.every((f) => actual.some((c) => c.id === f.id))
          )
            throw new AppError(
              "TARGET_CHANGED",
              "目标文件发生变化，请先核对网盘目录。",
            );
          let share;
          try {
            share =
              method === "copy.createShare"
                ? await p.findOwnShare(a, copy.files)
                : await p.recoverOwnShare(a, source!, copy.files);
            if (!share) {
              this.db.run(
                "UPDATE jobs SET checkpoint=? WHERE copy_id=? AND kind='transfer' AND stage<>?",
                "share_requested",
                copy.id,
                "completed",
              );
              share = await p.createShare(a, copy.files, resource.title);
            }
          } catch (error) {
            this.db.run(
              "UPDATE copies SET error=? WHERE id=?",
              safeMessage(error),
              copyId,
            );
            this.db.run(
              "UPDATE jobs SET stage=?,error=? WHERE copy_id=? AND kind='transfer' AND stage<>?",
              "needs_review",
              safeMessage(error),
              copyId,
              "completed",
            );
            this.changed();
            throw error;
          }
          const parsedShare = parseShare(share.url);
          if (
            parsedShare.provider !== resource.provider ||
            parsedShare.url === resource.sourceUrl ||
            !(await p.verifyShare(a, share.id, copy.files))
          )
            throw new AppError(
              "OWNERSHIP_UNVERIFIED",
              "本人分享仍未通过文件与有效性核验。",
            );
          if (
            share.ownerUid !== a.uid ||
            (source && parsedShare.url !== source.url)
          )
            throw new AppError(
              "OWNERSHIP_UNVERIFIED",
              "本人分享归属核验失败。",
            );
          const changedVersion =
            copy.shareId !== share.id ||
            copy.shareUrl !== parsedShare.url ||
            (await this.secrets.get(`share:${copyId}`)) !== share.code;
          await this.secrets.set(`share:${copyId}`, share.code);
          this.db.transaction(() => {
            this.db.run(
              "UPDATE copies SET status=?,share_id=?,share_url=?,share_owner_uid=?,share_version=share_version+?,share_verified_at=?,error=NULL WHERE id=?",
              "ready",
              share.id,
              parsedShare.url,
              a.uid,
              Number(changedVersion),
              now(),
              copyId,
            );
            this.db.run(
              "UPDATE jobs SET stage=?,checkpoint=?,error=NULL,updated_at=? WHERE copy_id=? AND kind='transfer' AND stage<>?",
              "completed",
              "complete",
              now(),
              copyId,
              "completed",
            );
            this.notes.enqueue(copyId);
          });
          await this.notes.flush();
          this.changed();
          return this.repo.getCopy(copyId);
        });
      }
      case "notes.export": {
        const { copyId } = z.object({ copyId: z.string() }).parse(object);
        this.notes.enqueue(copyId);
        await this.notes.flush();
        this.changed();
        return this.repo.getCopy(copyId);
      }
      case "notes.open": {
        const { copyId } = z.object({ copyId: z.string() }).parse(object);
        const row = this.db.get<{ path: string }>(
          "SELECT path FROM note_exports WHERE copy_id=?",
          copyId,
        );
        if (!row)
          throw new AppError("NOTE_NOT_EXPORTED", "此副本尚未导出知识笔记。");
        await this.ports.openPath(row.path);
        return true;
      }
      case "settings.vault": {
        const path = await this.ports.chooseDirectory("vault");
        if (path) {
          this.db.setSetting("vaultPath", path);
          for (const c of this.db.all<{ id: string }>(
            "SELECT id FROM copies WHERE status='ready'",
          ))
            this.notes.enqueue(c.id);
          void this.notes.flush().finally(() => this.changed());
          this.changed();
        }
        return path;
      }
      case "settings.save": {
        const input = z
          .object({
            model: z.string().max(200),
            exportCodes: z.boolean(),
            bitUrl: z.string().max(300),
            dailyAiBudgetMicros: z.number().int().nonnegative().nullable(),
          })
          .parse(object);
        if (input.bitUrl) validateLoopback(input.bitUrl);
        this.db.transaction(() => {
          for (const [key, value] of Object.entries(input))
            this.db.setSetting(key, value);
        });
        this.changed();
        return true;
      }
      case "secret.save": {
        const input = z
          .object({
            kind: z.enum([
              "openrouter",
              "bit",
              "5118:longtail",
              "5118:suggest",
              "5118:metrics",
              "5118:radar",
            ]),
            value: z.string().max(20000),
          })
          .parse(object);
        await this.secrets.set(input.kind, input.value);
        this.db.setSetting(
          `keyRevision:${input.kind.replace("5118:", "")}`,
          now(),
        );
        this.changed();
        return true;
      }
      case "api.plan": {
        const input = z
          .object({
            endpoint: endpointSchema,
            unitPriceMicros: z
              .number()
              .int()
              .nonnegative()
              .max(1_000_000_000)
              .nullable(),
            dailyUnits: z.number().int().min(1).max(1_000_000),
            dailyBudgetMicros: z.number().int().nonnegative().nullable(),
            enabled: z.boolean(),
          })
          .parse(object);
        if (input.dailyBudgetMicros != null && input.unitPriceMicros == null)
          throw new AppError(
            "API_PRICE_REQUIRED",
            "设置金额预算需录入实际套餐单价。",
          );
        this.db.run(
          "UPDATE api_plans SET unit_price_micros=?,daily_units=?,daily_budget_micros=?,enabled=? WHERE endpoint=?",
          input.unitPriceMicros,
          input.dailyUnits,
          input.dailyBudgetMicros,
          Number(input.enabled),
          input.endpoint,
        );
        this.changed();
        return true;
      }
      case "api.export": {
        const calls = this.db.all<Record<string, any>>(
          "SELECT * FROM api_calls ORDER BY created_at",
        );
        return this.ports.saveFile(
          "盘序-调用费用台账.csv",
          Buffer.from(
            csv([
              [
                "时间UTC",
                "接口",
                "阶段",
                "外部请求数",
                "预留计费单位",
                "币种",
                "套餐摊销估算",
                "预算预留",
                "API返回实际金额",
                "状态",
                "说明",
              ],
              ...calls.map((c) => [
                c.created_at,
                c.endpoint,
                c.phase,
                c.request_count,
                c.units,
                c.endpoint === "openrouter" ? "USD" : "CNY",
                c.estimated_micros == null ? null : c.estimated_micros / 1e6,
                c.reserved_micros == null ? null : c.reserved_micros / 1e6,
                c.confirmed_micros == null ? null : c.confirmed_micros / 1e6,
                c.status,
                c.message,
              ]),
            ]),
          ),
        );
      }
      case "traffic.releaseSubmission": {
        const { taskId } = z.object({ taskId: z.string() }).parse(object);
        const task = this.db.get<{ status: string }>(
          "SELECT status FROM async_queries WHERE task_id=?",
          taskId,
        );
        if (!task || task.status !== "uncertain")
          throw new AppError(
            "INVALID_TASK_STATE",
            "只可解除已人工核对的待核提交记录。",
          );
        this.db.run(
          "UPDATE async_queries SET status='released' WHERE task_id=?",
          taskId,
        );
        this.changed();
        return true;
      }
      case "traffic.query":
        return this.traffic.query(querySchema.parse(object));
      case "traffic.suggestionResult": {
        const { id } = z.object({ id: z.string() }).parse(object);
        return this.traffic.suggestionResult(id);
      }
      case "traffic.resumeSuggestion": {
        const { id } = z
          .object({ id: z.string(), chargeAcknowledged: z.literal(true) })
          .parse(object);
        return this.traffic.resumeSuggestion(id);
      }
      case "ai.connection":
        return this.ai.connection();
      case "ai.models":
        return this.ai.models();
      case "ai.keywords": {
        const { resourceId } = z
          .object({ resourceId: z.string() })
          .parse(object);
        return this.ai.extract(resourceId);
      }
      case "pool.save": {
        const input = z
          .object({
            name: z.string().trim().min(1).max(100),
            resourceId: z.string().nullable(),
            keywords: z.array(keywordSchema).min(1).max(1000),
          })
          .parse(object);
        if (input.resourceId) this.repo.getResource(input.resourceId);
        const poolId = id("pool");
        this.db.run(
          "INSERT INTO pools(id,name,resource_id,keywords,created_at) VALUES(?,?,?,?,?)",
          poolId,
          input.name,
          input.resourceId,
          JSON.stringify(input.keywords),
          now(),
        );
        this.changed();
        return this.repo.pools().find((p) => p.id === poolId);
      }
      case "pool.manual": {
        const input = z
          .object({
            name: z.string().trim().min(1).max(100),
            resourceId: z.string().nullable(),
            words: z.string().max(100000),
          })
          .parse(object);
        const words = [
          ...new Set(
            input.words
              .split(/[,，\n]/)
              .map((w) => w.trim())
              .filter(Boolean),
          ),
        ];
        if (
          !words.length ||
          words.length > 1000 ||
          words.some((w) => w.length > 200)
        )
          throw new AppError(
            "INVALID_KEYWORDS",
            "请录入1至1000个词，每词不超过200字。",
          );
        return this.invoke("pool.save", {
          name: input.name,
          resourceId: input.resourceId,
          keywords: words.map((word) => ({
            id: id("manual"),
            word,
            source: "手工录入",
            platform: null,
            metrics: {},
            sourceUpdatedAt: null,
            fetchedAt: now(),
          })),
        });
      }
      case "draft.generate": {
        const { copyId, platform, poolId } = z
          .object({
            copyId: z.string(),
            platform: platformSchema,
            poolId: z.string().nullable(),
          })
          .parse(object);
        return this.ai.draft(copyId, platform, poolId);
      }
      case "draft.manual": {
        const { copyId, platform, template } = z
          .object({
            copyId: z.string(),
            platform: platformSchema,
            template: z.boolean().default(false),
          })
          .parse(object);
        const copy = this.repo.getCopy(copyId),
          resource = this.repo.getResource(copy.resourceId),
          draftId = id("draft"),
          time = now();
        const content = template
          ? localTemplate(resource, platform)
          : { title: resource.title, body: "", tags: [], coverText: "" };
        this.db.run(
          "INSERT INTO drafts(id,resource_id,copy_id,platform,title,body,tags,resource_revision,share_version,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          draftId,
          resource.id,
          copyId,
          platform,
          content.title,
          content.body,
          JSON.stringify(content.tags),
          resource.revision,
          copy.shareVersion,
          template ? "local-template" : "manual",
          time,
          time,
        );
        this.changed();
        return this.repo.draft(draftId);
      }
      case "draft.save": {
        const input = z
          .object({
            id: z.string(),
            title: z.string().trim().min(1).max(200),
            body: z.string().max(30000),
            tags: z.array(z.string().max(60)).max(30),
            coverText: z.string().max(300),
          })
          .parse(object);
        const draft = this.repo.draft(input.id),
          draftId = id("draft"),
          time = now();
        this.db.run(
          "INSERT INTO drafts(id,resource_id,copy_id,platform,pool_id,title,body,tags,cover_text,version,resource_revision,share_version,model,reviewed,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          draftId,
          draft.resourceId,
          draft.copyId,
          draft.platform,
          draft.poolId,
          input.title,
          input.body,
          JSON.stringify(input.tags),
          input.coverText,
          draft.version + 1,
          draft.resourceRevision,
          draft.shareVersion,
          draft.model,
          0,
          time,
          time,
        );
        this.changed();
        return this.repo.draft(draftId);
      }
      case "draft.review": {
        const { id: draftId, reviewed } = z
          .object({ id: z.string(), reviewed: z.boolean() })
          .parse(object);
        const draft = this.repo.draft(draftId),
          resource = this.repo.getResource(draft.resourceId),
          copy = this.repo.getCopy(draft.copyId);
        if (reviewed && !draft.body.trim())
          throw new AppError("EMPTY_DRAFT", "请先填写内容正文。");
        this.db.run(
          "UPDATE drafts SET reviewed=?,resource_revision=?,share_version=?,updated_at=? WHERE id=?",
          Number(reviewed),
          resource.revision,
          copy.shareVersion,
          now(),
          draftId,
        );
        this.changed();
        return this.repo.draft(draftId);
      }
      case "bit.health":
        return this.bit.health();
      case "bit.windows":
        return this.bit.windows();
      case "binding.open": {
        const { id: bindingId } = z.object({ id: z.string() }).parse(object);
        const binding = this.repo.bindings().find((b) => b.id === bindingId);
        if (!binding)
          throw new AppError("NOT_FOUND", "未找到对应的平台窗口映射。");
        return this.openBinding(binding);
      }
      case "binding.save": {
        const input = z
          .object({
            id: z.string().optional(),
            platform: platformSchema,
            alias: z.string().trim().min(1).max(80),
            windowId: z.string().min(1).max(200),
            editorUrl: z.string().max(2000),
            linkPermission: z.enum(["none", "allowed"]),
            ruleNote: z.string().max(2000),
          })
          .parse(object);
        const spec = platformSpecs.find((p) => p.id === input.platform)!;
        if (input.id) {
          const prior = this.repo.bindings().find((b) => b.id === input.id);
          if (!prior || prior.platform !== input.platform)
            throw new AppError(
              "BINDING_MISMATCH",
              "已有映射不能修改所属平台，请为新平台新建映射。",
            );
        }
        if (
          input.linkPermission === "allowed" &&
          (spec.linkMode === "blocked" || input.ruleNote.trim().length < 10)
        )
          throw new AppError(
            "CHANNEL_RULE_REQUIRED",
            "此平台默认禁止链接，或尚未记录足够的账号场景核实依据。",
          );
        const bindingId = input.id ?? id("binding");
        this.db.run(
          "INSERT INTO browser_bindings(id,platform,alias,window_id,editor_url,link_permission,rule_note,verified_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET alias=excluded.alias,window_id=excluded.window_id,editor_url=excluded.editor_url,link_permission=excluded.link_permission,rule_note=excluded.rule_note,verified_at=excluded.verified_at,last_checked_at=NULL,last_opened_at=NULL,open_error=NULL",
          bindingId,
          input.platform,
          input.alias,
          input.windowId,
          validateEditorUrl(input.platform, input.editorUrl),
          input.linkPermission,
          input.ruleNote,
          now(),
        );
        this.changed();
        return this.repo.bindings().find((b) => b.id === bindingId);
      }
      case "publication.package": {
        const input = z
          .object({
            draftId: z.string(),
            bindingId: z.string().nullable(),
            includeLink: z.boolean(),
          })
          .parse(object);
        return this.contentPackage(
          input.draftId,
          input.bindingId,
          input.includeLink,
        );
      }
      case "publication.open": {
        const { draftId, bindingId } = z
          .object({ draftId: z.string(), bindingId: z.string() })
          .parse(object);
        await this.contentPackage(draftId, bindingId, false);
        const binding = this.repo.bindings().find((b) => b.id === bindingId)!;
        const result = await this.openBinding(binding);
        const draft = this.repo.draft(draftId);
        this.db.run(
          "INSERT INTO publications(id,draft_id,draft_version,binding_id,status,created_at) VALUES(?,?,?,?,?,?)",
          id("pub"),
          draftId,
          draft.version,
          bindingId,
          "opened",
          now(),
        );
        this.changed();
        return result;
      }
      case "publication.export": {
        const { draftId, bindingId, includeLink } = z
          .object({
            draftId: z.string(),
            bindingId: z.string().nullable(),
            includeLink: z.boolean(),
          })
          .parse(object);
        const result = await this.contentPackage(
          draftId,
          bindingId,
          includeLink,
        );
        const selected = await this.ports.chooseDirectory("content");
        if (!selected) return null;
        const folder = join(selected, `盘序内容包-${id("export")}`);
        await mkdir(folder, { mode: 0o700 });
        try {
          await writeFile(join(folder, "发布文案.txt"), result.text, {
            mode: 0o600,
          });
          await writeFile(
            join(folder, "内容信息.json"),
            JSON.stringify(
              {
                title: result.title,
                platform: result.platform,
                exportedAt: now(),
                published: false,
                includesOwnLink: includeLink,
              },
              null,
              2,
            ),
            { mode: 0o600 },
          );
          if (result.coverId)
            await copyFile(
              join(this.dataPath, "covers", `${result.coverId}.png`),
              join(folder, "封面.png"),
            );
          return { folder };
        } catch (error) {
          await rm(folder, { recursive: true, force: true });
          throw error;
        }
      }
      case "publication.mark": {
        const { draftId, bindingId, url } = z
          .object({
            draftId: z.string(),
            bindingId: z.string(),
            url: z.url().max(2000),
          })
          .parse(object);
        const draft = this.repo.draft(draftId);
        validatePublicationUrl(draft.platform, url);
        if (
          !this.db.get(
            "SELECT id FROM publications WHERE draft_id=? AND draft_version=? AND binding_id=? AND status=?",
            draftId,
            draft.version,
            bindingId,
            "opened",
          )
        )
          throw new AppError(
            "EDITOR_NOT_OPENED",
            "当前草稿版本尚未打开指定编辑器。",
          );
        this.db.run(
          "INSERT INTO publications(id,draft_id,draft_version,binding_id,status,url,created_at) VALUES(?,?,?,?,?,?,?)",
          id("pub"),
          draftId,
          draft.version,
          bindingId,
          "published",
          url,
          now(),
        );
        this.changed();
        return true;
      }
      case "system.copyText": {
        const { text } = z
          .object({ text: z.string().max(100000) })
          .parse(object);
        await this.ports.copyText(text);
        return true;
      }
      case "system.dataFolder":
        await this.ports.openPath(this.dataPath);
        return true;
      case "system.backup":
        return this.backup();
      case "system.backupPreview": {
        const folder = await this.ports.chooseDirectory("restore");
        if (!folder) return null;
        const checked = await inspectBackup(folder);
        const preview: BackupPreview = {
          token: id("restore"),
          folder,
          createdAt: checked.createdAt,
          resources: checked.resources,
          accounts: checked.accounts,
          drafts: checked.drafts,
          covers: checked.covers.length,
        };
        this.backupPreview = { ...preview, hash: checked.databaseSha256 };
        return preview;
      }
      case "system.restore": {
        const { token } = z
          .object({ token: z.string(), confirmed: z.literal(true) })
          .parse(object);
        if (!this.backupPreview || this.backupPreview.token !== token)
          throw new AppError(
            "RESTORE_PREVIEW_REQUIRED",
            "请先选择备份并完成预检。",
          );
        if (this.hasRunningJobs())
          throw new AppError(
            "JOBS_RUNNING",
            "请先停止当前任务并核对远端结果，再恢复工作空间。",
          );
        const preview = this.backupPreview;
        this.backupPreview = null;
        this.switchingWorkspace = true;
        try {
          const restored = await stageRestore(
            preview.folder,
            this.dataPath,
            preview.hash,
          );
          await this.ports.activateDataPath(restored.dataPath);
          return restored;
        } catch (error) {
          this.switchingWorkspace = false;
          throw error;
        }
      }
      case "system.previousWorkspace": {
        const previous = this.db.setting<string>("restorePreviousDataPath", "");
        if (!previous)
          throw new AppError("NOT_FOUND", "当前没有恢复前的工作空间。");
        if (this.hasRunningJobs())
          throw new AppError("JOBS_RUNNING", "请先停止任务后再切换工作空间。");
        this.switchingWorkspace = true;
        try {
          await this.ports.activateDataPath(previous);
        } catch (error) {
          this.switchingWorkspace = false;
          throw error;
        }
        return true;
      }
      case "system.external": {
        const { url } = z.object({ url: z.url().max(2000) }).parse(object);
        const u = new URL(url);
        const allowed = [
          "www.5118.com",
          "account.5118.com",
          "openrouter.ai",
          "doc.bitbrowser.cn",
          "www.bitbrowser.cn",
          ...platformSpecs.flatMap((p) => [new URL(p.ruleUrl).hostname]),
        ];
        if (
          u.protocol !== "https:" ||
          !allowed.includes(u.hostname) ||
          u.username ||
          u.password
        )
          throw new AppError(
            "EXTERNAL_URL_BLOCKED",
            "此外部地址未在应用允许列表内。",
          );
        await this.ports.openExternal(url);
        return true;
      }
      default:
        throw new AppError("UNKNOWN_METHOD", "不支持此操作。");
    }
  }
  private assertNoActiveJobs(accountId: string) {
    if (
      this.db.get(
        "SELECT j.id FROM jobs j JOIN copies c ON c.id=j.copy_id WHERE c.account_id=? AND j.stage IN ('queued','preflight','transferring','verifying','sharing','archiving') LIMIT 1",
        accountId,
      )
    )
      throw new AppError(
        "ACTIVE_JOBS",
        "此账号有正在执行的任务，请先停止等待并核对远端结果。",
      );
  }
  async saveResource(input: ResourceInput) {
    const source = parseShare(input.sourceText, input.extractionCode),
      account = this.account(input.accountId);
    if (source.provider !== account.provider)
      throw new AppError(
        "CROSS_PROVIDER_UNSUPPORTED",
        "来源与目标账号网盘类型不同，首版仅支持同网盘转存。",
      );
    if (
      input.enqueue &&
      (!input.rightsConfirmed || !input.selectedFiles?.length)
    )
      throw new AppError(
        "SELECTION_REQUIRED",
        "开始转存前，请确认分享权利并读取、选择需要保存的文件。",
      );
    const existing = this.db.get<{ id: string }>(
      "SELECT id FROM resources WHERE source_url=?",
      source.url,
    );
    const resourceId = input.id ?? existing?.id ?? id("resource");
    if (input.id && this.repo.getResource(input.id).sourceUrl !== source.url)
      throw new AppError(
        "SOURCE_IMMUTABLE",
        "已有资源的来源链接不能直接更换，请新建资源。",
      );
    let coverId: string | null | undefined;
    if (input.coverData === null) coverId = null;
    else if (input.coverData) {
      const match = input.coverData.match(
        /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/,
      );
      if (!match)
        throw new AppError("INVALID_COVER", "仅支持PNG、JPEG、WebP封面。");
      const bytes = Buffer.from(match[2], "base64");
      if (bytes.length > 8 * 1024 * 1024)
        throw new AppError("COVER_TOO_LARGE", "封面不能超过8MB。");
      const normalized = await this.ports.normalizeCover(bytes);
      coverId = createHash("sha256").update(normalized).digest("hex");
      await mkdir(join(this.dataPath, "covers"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(this.dataPath, "covers", `${coverId}.png`),
        normalized,
        { mode: 0o600 },
      );
    }
    if (source.code)
      await this.secrets.set(`source:${resourceId}`, source.code);
    const resourceExists = !!existing || !!input.id;
    let directory =
      normalizedDirectory(input.directory || account.defaultDirectory) +
      "/" +
      input.title
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
        .trim()
        .slice(0, 40) +
      "__" +
      resourceId.slice(-8);
    if (input.copyId) {
      const editedCopy = this.repo.getCopy(input.copyId);
      if (
        editedCopy.resourceId !== resourceId ||
        editedCopy.accountId !== account.id
      )
        throw new AppError(
          "COPY_MISMATCH",
          "编辑资料时不能改绑已有副本账号；请新建该账号的副本。",
        );
      directory = editedCopy.directory;
    }
    const priorCopy = this.db.get<{ id: string; status: string }>(
      "SELECT id,status FROM copies WHERE resource_id=? AND account_id=? AND directory=?",
      resourceId,
      account.id,
      directory,
    );
    if (input.enqueue && priorCopy && priorCopy.status !== "draft")
      throw new AppError(
        "COPY_EXISTS",
        "该账号和目录已有此资源副本，请到转存任务中核对或恢复，避免重复转存。",
      );
    const copyId = priorCopy?.id ?? id("copy"),
      time = now();
    let jobId: string | null = null;
    this.db.transaction(() => {
      if (!resourceExists)
        this.db.run(
          "INSERT INTO resources(id,title,source_url,source_key,provider,category,tags,summary,cover_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          resourceId,
          input.title,
          source.url,
          source.shareKey,
          source.provider,
          input.category,
          JSON.stringify(input.tags),
          input.summary,
          coverId ?? null,
          time,
          time,
        );
      else if (input.id)
        this.db.run(
          "UPDATE resources SET title=?,category=?,tags=?,summary=?,cover_id=?,revision=revision+1,updated_at=? WHERE id=?",
          input.title,
          input.category,
          JSON.stringify(input.tags),
          input.summary,
          coverId === undefined
            ? this.repo.getResource(input.id).coverId
            : coverId,
          time,
          resourceId,
        );
      if (!priorCopy)
        this.db.run(
          "INSERT INTO copies(id,resource_id,account_id,directory,selected_files,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
          copyId,
          resourceId,
          account.id,
          directory,
          JSON.stringify(input.selectedFiles ?? []),
          time,
          time,
        );
      else if (input.selectedFiles?.length)
        this.db.run(
          "UPDATE copies SET selected_files=? WHERE id=?",
          JSON.stringify(input.selectedFiles),
          copyId,
        );
      if (input.enqueue) {
        jobId = id("job");
        this.db.run(
          "INSERT INTO jobs(id,copy_id,stage,created_at,updated_at) VALUES(?,?,?,?,?)",
          jobId,
          copyId,
          account.uid ? "queued" : "waiting_login",
          time,
          time,
        );
        this.db.run("UPDATE copies SET status=? WHERE id=?", "queued", copyId);
      }
      if (input.id) {
        for (const copy of this.repo.getResource(resourceId).copies) {
          if (copy.status === "ready") this.notes.enqueue(copy.id);
        }
      }
    });
    if (input.id) await this.notes.flush();
    this.changed();
    if (input.enqueue) {
      await this.ports.closeAccountWindow(account.id);
      void this.queue.pump();
    }
    return { resourceId, copyId, jobId };
  }
  private async openBinding(binding: BrowserBinding) {
    try {
      const result = await this.bit.open(binding);
      this.db.run(
        "UPDATE browser_bindings SET last_checked_at=?,last_opened_at=?,open_error=NULL WHERE id=?",
        now(),
        now(),
        binding.id,
      );
      return result;
    } catch (error) {
      this.db.run(
        "UPDATE browser_bindings SET last_checked_at=?,open_error=? WHERE id=?",
        now(),
        safeMessage(error),
        binding.id,
      );
      throw error;
    } finally {
      this.changed();
    }
  }
  private hasRunningJobs() {
    return !!this.db.get(
      "SELECT id FROM jobs WHERE stage IN ('queued','preflight','transferring','verifying','sharing','archiving') LIMIT 1",
    );
  }
  private async checkShare(copyId: string): Promise<ShareCheck> {
    const copy = this.repo.getCopy(copyId);
    let status: ShareCheck["status"] = "unavailable",
      message = "";
    try {
      const resource = this.repo.getResource(copy.resourceId);
      const valid = await this.authenticated(
        copy.accountId,
        async (account, provider) => {
          if (
            copy.status !== "ready" ||
            !copy.shareId ||
            !copy.shareUrl ||
            copy.shareUrl === resource.sourceUrl ||
            !copy.files.length ||
            !copy.verifiedAt ||
            copy.ownerUid !== account.uid ||
            copy.shareOwnerUid !== account.uid
          )
            throw new AppError(
              "OWNERSHIP_UNVERIFIED",
              "副本或本人分享归属尚未核验，请先完成转存或恢复分享。",
            );
          return provider.verifyShare(account, copy.shareId, copy.files);
        },
      );
      status = valid ? "valid" : "invalid";
      message = valid
        ? "本人分享记录与文件清单核验通过。"
        : "本人分享已失效或文件不匹配，请恢复本人分享。";
      this.db.run(
        "UPDATE copies SET share_verified_at=? WHERE id=?",
        valid ? now() : null,
        copyId,
      );
    } catch (error) {
      message = safeMessage(error);
    }
    const checkedAt = now();
    this.db.run(
      "INSERT INTO share_checks(copy_id,status,checked_at,message) VALUES(?,?,?,?) ON CONFLICT(copy_id) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,message=excluded.message",
      copyId,
      status,
      checkedAt,
      message,
    );
    this.changed();
    return { copyId, status, checkedAt, message };
  }
  private assertOwnCopy(copy: ResourceCopy) {
    const account = this.account(copy.accountId);
    if (
      copy.status !== "ready" ||
      !copy.verifiedAt ||
      !copy.shareVerifiedAt ||
      !copy.shareUrl ||
      !copy.shareId ||
      !account.uid ||
      copy.ownerUid !== account.uid ||
      copy.shareOwnerUid !== account.uid
    )
      throw new AppError(
        "OWNERSHIP_UNVERIFIED",
        "资源副本与本人分享尚未通过同账号UID核验，禁止分发。",
      );
    if (copy.shareUrl === this.repo.getResource(copy.resourceId).sourceUrl)
      throw new AppError(
        "FOREIGN_SHARE_BLOCKED",
        "本人分享与来源链接相同，禁止分发。",
      );
    return account;
  }
  async contentPackage(
    draftId: string,
    bindingId: string | null,
    includeLink: boolean,
  ) {
    const draft = this.repo.draft(draftId),
      copy = this.repo.getCopy(draft.copyId),
      resource = this.repo.getResource(draft.resourceId),
      account = this.assertOwnCopy(copy);
    if (!draft.reviewed)
      throw new AppError("REVIEW_REQUIRED", "请先保存并人工审阅当前内容版本。");
    if (
      draft.resourceRevision !== resource.revision ||
      draft.shareVersion !== copy.shareVersion
    )
      throw new AppError(
        "STALE_DRAFT",
        "资源信息或分享链接已更新，请重新审阅草稿。",
      );
    const binding = bindingId
      ? this.repo.bindings().find((b) => b.id === bindingId)
      : null;
    if (bindingId && (!binding || binding.platform !== draft.platform))
      throw new AppError("BINDING_MISMATCH", "所选发布账号与草稿平台不匹配。");
    const spec = platformSpecs.find((p) => p.id === draft.platform)!;
    const allowLinks =
      !!binding &&
      binding.linkPermission === "allowed" &&
      spec.linkMode !== "blocked" &&
      !!binding.verifiedAt &&
      Date.now() - new Date(binding.verifiedAt).getTime() < 30 * 24 * 3600_000;
    if (includeLink && !allowLinks)
      throw new AppError(
        "CHANNEL_LINK_BLOCKED",
        "此发布场景未核实允许网盘链接，或权限核实记录已超过30天。",
      );
    let text = `${draft.title}\n\n${draft.body}\n\n${draft.tags.join(" ")}`;
    validateOutgoingLinks(text, copy.shareUrl!, allowLinks);
    await this.authenticated(account.id, async (a, p) => {
      if (!(await p.verifyShare(a, copy.shareId!, copy.files))) {
        this.db.run(
          "UPDATE copies SET share_verified_at=NULL,error=? WHERE id=?",
          "本人分享已失效或文件不匹配，请重新处理分享。",
          copy.id,
        );
        this.changed();
        throw new AppError(
          "SHARE_INVALID",
          "未能重新确认本人分享有效性，已阻止分发。",
        );
      }
    });
    this.db.run(
      "UPDATE copies SET share_verified_at=? WHERE id=?",
      now(),
      copy.id,
    );
    if (includeLink) {
      const code = await this.secrets.get(`share:${copy.id}`);
      text += `\n\n资源链接：${copy.shareUrl}${code ? `\n提取码：${code}` : ""}`;
    }
    return {
      text,
      coverId: resource.coverId,
      title: draft.title,
      platform: draft.platform,
    };
  }
  async backup() {
    const selected = await this.ports.chooseDirectory("backup");
    if (!selected) return null;
    const folder = join(selected, `盘序备份-${now().replace(/[:.]/g, "-")}`);
    await mkdir(folder, { mode: 0o700 });
    const file = join(folder, "panxu.db");
    this.db.run("VACUUM INTO ?", file);
    const copy = new Database(file);
    copy.run("PRAGMA secure_delete=ON");
    copy.run("DELETE FROM secrets");
    copy.run("UPDATE accounts SET status=?,verified_at=NULL", "disconnected");
    copy.run("VACUUM");
    copy.run("PRAGMA journal_mode=DELETE");
    copy.close();
    await chmod(file, 0o600);
    const covers = join(this.dataPath, "covers");
    await mkdir(join(folder, "covers"), { mode: 0o700 });
    try {
      for (const entry of await readdir(covers))
        if (/^[a-f0-9]{64}\.png$/.test(entry))
          await copyFile(join(covers, entry), join(folder, "covers", entry));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(
      join(folder, "manifest.json"),
      JSON.stringify(
        {
          product: "panxu-studio",
          schemaVersion: Number(
            this.db.get<{ user_version: number }>("PRAGMA user_version")
              ?.user_version ?? 2,
          ),
          createdAt: now(),
          credentialsIncluded: false,
          databaseSha256: createHash("sha256")
            .update(await readFile(file))
            .digest("hex"),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    return folder;
  }
  close() {
    this.queue.stop();
    this.db.close();
  }
}

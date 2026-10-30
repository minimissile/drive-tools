import { createHash, randomUUID } from "node:crypto";
import { now } from "./database";
import { AppError } from "./errors";
import type { Repository } from "./repository";
import type { ResourceDeletion } from "./resource-deletion";
import type {
  AccountDeletePreview,
  AccountDeleteResult,
} from "../shared/account-deletion";

interface Dependencies {
  repo: Repository;
  resources: ResourceDeletion;
  hasRunningJobs(): boolean;
  locked<T>(id: string, action: () => Promise<T>): Promise<T>;
  clearSession(id: string): Promise<void>;
  changed(): void;
}
interface Intent {
  preview: AccountDeletePreview;
  fingerprint: string;
  expiresAt: number;
}
const receiptKey = (token: string) => `account-deletion-result:${token}`;

/** Removes workspace records and isolated local sessions; never contacts a drive provider. */
export class AccountDeletion {
  private previews = new Map<string, Intent>();
  private active: string | null = null;
  constructor(private d: Dependencies) {}
  get isBusy() {
    return this.active !== null;
  }
  private get db() {
    return this.d.repo.db;
  }
  private fingerprint(accountId: string) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          this.db.get("SELECT * FROM accounts WHERE id=?", accountId),
          this.d.resources.accountResources(accountId),
          this.db.all(
            "SELECT d.id,d.version FROM drafts d WHERE d.resource_id IN (SELECT resource_id FROM copies WHERE account_id=?) ORDER BY d.id",
            accountId,
          ),
        ]),
      )
      .digest("hex");
  }
  private blockers(id: string) {
    const reasons = this.d.resources.accountBlockers(id);
    if (this.d.hasRunningJobs())
      reasons.push("仍有任务正在执行，请等待完成或停止后再删除账号。");
    if (
      this.db.get(
        "SELECT account_id FROM drive_share_intents WHERE account_id=? AND json_extract(data,'$.state') IN ('requested','created','uncertain') LIMIT 1",
        id,
      )
    )
      reasons.push("此账号有网盘分享结果待核对，请先处理原分享操作。");
    if (
      this.db.get(
        "SELECT key FROM settings WHERE substr(key,1,length(?))=? AND value!='null' LIMIT 1",
        `drive-write-pending:${id}:`,
        `drive-write-pending:${id}:`,
      )
    )
      reasons.push("此账号有网盘文件写入结果待核对，请先处理原操作。");
    if (
      this.db.get(
        "SELECT key FROM settings WHERE key LIKE 'share-creation:%' AND json_valid(value) AND json_extract(value,'$.accountId')=? AND json_extract(value,'$.receipt.state')='uncertain' LIMIT 1",
        id,
      )
    )
      reasons.push("此账号有独立建链结果待核对，请先处理原分享记录。");
    if (
      this.db.get(
        "SELECT r.id FROM insertion_runs r,json_each(r.data,'$.items') i WHERE json_extract(i.value,'$.target.accountId')=? AND json_extract(i.value,'$.state') IN ('writing','uncertain') LIMIT 1",
        id,
      )
    )
      reasons.push("此账号有广告插入结果待核对，请先处理原任务。");
    return [...new Set(reasons)];
  }
  preview(id: string): AccountDeletePreview {
    const account = this.d.repo.getAccount(id);
    const resources = this.d.resources.accountResources(id);
    const preview: AccountDeletePreview = {
      token: randomUUID(),
      accountId: id,
      alias: account.alias,
      provider: account.provider,
      resources: resources.map((resource) => ({
        id: resource.id,
        title: resource.title,
        removeResource: resource.copies.every((copy) => copy.accountId === id),
        copyCount: resource.copies.filter((copy) => copy.accountId === id)
          .length,
      })),
      copyCount: this.db.get<{ n: number }>(
        "SELECT count(*) n FROM copies WHERE account_id=?",
        id,
      )!.n,
      draftCount: this.db.get<{ n: number }>(
        "SELECT count(*) n FROM drafts d WHERE copy_id IN (SELECT id FROM copies WHERE account_id=?) AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.draft_id=d.id)",
        id,
      )!.n,
      blockers: this.blockers(id),
    };
    for (const [key, intent] of this.previews)
      if (intent.expiresAt < Date.now()) this.previews.delete(key);
    this.previews.set(preview.token, {
      preview,
      fingerprint: this.fingerprint(id),
      expiresAt: Date.now() + 15 * 60_000,
    });
    return preview;
  }
  private check(intent: Intent) {
    if (
      intent.expiresAt < Date.now() ||
      intent.fingerprint !== this.fingerprint(intent.preview.accountId)
    )
      throw new AppError(
        "ACCOUNT_DELETE_PREVIEW_CHANGED",
        "账号或关联资料已变化，请刷新删除范围后再操作。",
      );
    const blockers = this.blockers(intent.preview.accountId);
    if (blockers.length)
      throw new AppError("ACCOUNT_IN_USE", blockers.join(" "));
  }
  async remove(token: string): Promise<AccountDeleteResult> {
    const completed = this.db.setting<AccountDeleteResult | null>(
      receiptKey(token),
      null,
    );
    if (completed) return completed;
    const intent = this.previews.get(token);
    if (!intent)
      throw new AppError(
        "ACCOUNT_DELETE_PREVIEW_EXPIRED",
        "删除预览已失效，请重新打开。",
      );
    if (this.active)
      throw new AppError("ACCOUNT_DELETE_BUSY", "正在删除账号，请等待完成。");
    this.check(intent);
    this.active = intent.preview.accountId;
    try {
      return await this.d.locked(intent.preview.accountId, async () => {
        this.check(intent);
        // Clear while the account still exists; ports may need its provider to clear credentials.
        await this.d.clearSession(intent.preview.accountId);
        this.check(intent);
        const result = this.db.transaction(() => {
          const { accountId, provider, resources, copyCount } = intent.preview;
          const removedCopyIds = this.db
            .all<{ id: string }>(
              "SELECT id FROM copies WHERE account_id=?",
              accountId,
            )
            .map((r) => r.id);
          this.d.resources.removeAccountResources(accountId);
          this.db.run(
            "DELETE FROM share_statistics WHERE account_id=?",
            accountId,
          );
          this.db.run(
            "DELETE FROM share_statistics_syncs WHERE account_id=?",
            accountId,
          );
          this.db.run(
            "DELETE FROM drive_share_intents WHERE account_id=?",
            accountId,
          );
          for (const row of this.db.all<{ key: string }>(
            "SELECT key FROM settings WHERE key LIKE 'share-creation:%' AND json_valid(value) AND json_extract(value,'$.accountId')=?",
            accountId,
          )) {
            const operationId = row.key.slice("share-creation:".length);
            this.db.run(
              "DELETE FROM secrets WHERE key IN (?,?)",
              `share-creation-request:${operationId}`,
              `share-creation-result:${operationId}`,
            );
            this.db.run("DELETE FROM settings WHERE key=?", row.key);
          }
          for (const prefix of [
            `drive-write:${accountId}:`,
            `drive-write-pending:${accountId}:`,
          ])
            this.db.run(
              "DELETE FROM settings WHERE substr(key,1,length(?))=?",
              prefix,
              prefix,
            );
          const sharePrefix = `drive-share:${accountId}:`;
          this.db.run(
            "DELETE FROM secrets WHERE substr(key,1,length(?))=?",
            sharePrefix,
            sharePrefix,
          );
          this.db.run(
            "DELETE FROM secrets WHERE key=?",
            `drive-auth:${provider}:${accountId}`,
          );
          this.db.run(
            "DELETE FROM settings WHERE key IN (?,?)",
            `account:capacity:${accountId}`,
            `intake:directories:${accountId}`,
          );
          this.db.run("DELETE FROM accounts WHERE id=?", accountId);
          const replacement =
            this.d.repo
              .accounts()
              .find(
                (a) => a.provider === provider && a.enabled && a.isDefault,
              ) ??
            this.d.repo
              .accounts()
              .find((a) => a.provider === provider && a.enabled);
          if (replacement && !replacement.isDefault)
            this.db.run(
              "UPDATE accounts SET is_default=1,updated_at=? WHERE id=?",
              now(),
              replacement.id,
            );
          const value: AccountDeleteResult = {
            accountId,
            provider,
            replacementAccountId: replacement?.id ?? null,
            resourceCount: resources.filter((r) => r.removeResource).length,
            copyCount,
            removedResourceIds: resources
              .filter((r) => r.removeResource)
              .map((r) => r.id),
            removedCopyIds,
            message: "账号及关联本地记录已删除，网盘文件和分享保留。",
          };
          this.db.setSetting(receiptKey(token), value);
          return value;
        });
        this.previews.delete(token);
        this.d.changed();
        return result;
      });
    } finally {
      this.active = null;
    }
  }
}

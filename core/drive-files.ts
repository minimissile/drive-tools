import { id, now, parseJson } from "./database";
import type { Database } from "./database";
import type { Repository } from "./repository";
import type { SecretStore } from "./secrets";
import { AppError, safeMessage } from "./errors";
import { parseShare } from "./links";
import {
  normalizedDirectory,
  type DriveProvider,
  type OwnShare,
} from "./providers/provider";
import type { Account, RemoteFile } from "../shared/types";
import type { DriveShareResult } from "../shared/zhidao";

interface Dependencies {
  db: Database;
  repo: Repository;
  secrets: SecretStore;
  changed(): void;
  authenticated<T>(
    accountId: string,
    action: (account: Account, provider: DriveProvider) => Promise<T>,
  ): Promise<T>;
  assertNoActiveJobs(accountId: string): void;
}
interface Intent {
  state: "requested" | "created" | "verified" | "uncertain";
  file: RemoteFile;
  share?: Omit<OwnShare, "code">;
  message?: string;
}
export class DriveFiles {
  private busy = new Set<string>();
  busyAccount(accountId: string) {
    return this.busy.has(accountId);
  }
  get isBusy() {
    return this.busy.size > 0;
  }
  constructor(private d: Dependencies) {}
  list(accountId: string, path: string) {
    return this.d.authenticated(accountId, async (account, provider) =>
      provider.list(
        account,
        account.provider === "baidu" ? normalizedDirectory(path) : path,
      ),
    );
  }
  async manage(v: {
    accountId: string;
    action: "mkdir" | "rename" | "delete";
    path: string;
    name?: string;
    fileId?: string;
  }) {
    this.d.assertNoActiveJobs(v.accountId);
    this.busy.add(v.accountId);
    try {
      const path = normalizedDirectory(v.path);
      if (v.action !== "mkdir" && (path === "/" || !v.fileId))
        throw new AppError(
          "ROOT_PROTECTED",
          "请选择具体文件，不能修改网盘根目录。",
        );
      await this.d.authenticated(v.accountId, async (account, provider) => {
        if (account.provider !== "baidu" || !provider.manage)
          throw new AppError("UNSUPPORTED", "当前网盘暂不支持文件管理操作。");
        if (v.action !== "mkdir") {
          const parent = path.slice(0, path.lastIndexOf("/")) || "/";
          const files = await provider.list(account, parent);
          if (
            !files.some(
              (f) =>
                f.id === v.fileId &&
                (f.path ?? parent.replace(/\/$/, "") + "/" + f.name) === path,
            )
          )
            throw new AppError(
              "FILES_CHANGED",
              "所选文件或路径已变化，请刷新目录再操作。",
            );
        }
        await provider.manage(account, v.action, path, v.name);
      });
      if (v.action !== "mkdir")
        this.d.db.transaction(() => {
          const copies = this.d.db
            .all<{ id: string; directory: string; files: string }>(
              "SELECT id,directory,files FROM copies WHERE account_id=?",
              v.accountId,
            )
            .filter(
              (copy) =>
                copy.directory === path ||
                copy.directory.startsWith(path + "/") ||
                parseJson<RemoteFile[]>(copy.files, []).some(
                  (file) =>
                    file.id === v.fileId ||
                    (file.isDirectory &&
                      path.startsWith(
                        (file.path ??
                          copy.directory.replace(/\/$/, "") + "/" + file.name) +
                          "/",
                      )),
                ),
            );
          for (const copy of copies) {
            this.d.db.run(
              "UPDATE copies SET share_verified_at=NULL,verified_at=NULL,error='网盘目录发生变更，请重新核对' WHERE id=?",
              copy.id,
            );
            this.d.db.run(
              "UPDATE drafts SET reviewed=0 WHERE copy_id=?",
              copy.id,
            );
          }
        });
      this.d.changed();
      return true;
    } finally {
      this.busy.delete(v.accountId);
    }
  }
  private intent(accountId: string, fileId: string) {
    return parseJson<Intent | null>(
      this.d.db.get<{ data: string }>(
        "SELECT data FROM drive_share_intents WHERE account_id=? AND file_id=?",
        accountId,
        fileId,
      )?.data,
      null,
    );
  }
  private saveIntent(accountId: string, fileId: string, value: Intent) {
    this.d.db.run(
      "INSERT INTO drive_share_intents(account_id,file_id,data) VALUES(?,?,?) ON CONFLICT(account_id,file_id) DO UPDATE SET data=excluded.data",
      accountId,
      fileId,
      JSON.stringify(value),
    );
  }
  async share(
    accountId: string,
    path: string,
    fileIds: string[],
  ): Promise<DriveShareResult> {
    this.d.assertNoActiveJobs(accountId);
    this.busy.add(accountId);
    try {
      const result: DriveShareResult = { urls: [], failures: [] };
      await this.d.authenticated(accountId, async (account, provider) => {
        if (account.provider !== "baidu")
          throw new AppError(
            "BAIDU_REQUIRED",
            "此入口当前支持百度网盘文件分享。",
          );
        const parent = normalizedDirectory(path);
        const files = await provider.list(account, parent);
        const selected = files.filter((f) => fileIds.includes(f.id));
        if (selected.length !== new Set(fileIds).size)
          throw new AppError("FILES_CHANGED", "所选文件已变化，请刷新目录。");
        for (const file of selected) {
          let intent = this.intent(accountId, file.id);
          let sent = false;
          try {
            if (
              intent &&
              (intent.file.name !== file.name ||
                intent.file.isDirectory !== file.isDirectory ||
                intent.file.size !== file.size)
            )
              throw new AppError(
                "FILES_CHANGED",
                "文件清单已变化，请在网盘核对原分享。",
              );
            let share: OwnShare | null = await provider.findOwnShare(account, [
              file,
            ]);
            if (!share && intent?.share) {
              const code = await this.d.secrets.get(
                `drive-share:${accountId}:${file.id}`,
              );
              share = { ...intent.share, code: code ?? "" };
            }
            if (!share && intent)
              throw new AppError(
                "UNCERTAIN_REMOTE_RESULT",
                "先前分享请求尚未找到结果，请核对原分享；不会重复创建。",
                true,
              );
            if (!share) {
              this.saveIntent(accountId, file.id, { state: "requested", file });
              sent = true;
              share = await provider.createShare(account, [file], file.name);
            }
            this.saveIntent(accountId, file.id, {
              state: "created",
              file,
              share: { id: share.id, url: share.url, ownerUid: share.ownerUid },
            });
            await this.d.secrets.set(
              `drive-share:${accountId}:${file.id}`,
              share.code,
            );
            if (
              share.ownerUid !== account.uid ||
              !(await provider.verifyShare(
                account,
                share.id,
                [file],
                share.code,
              ))
            )
              throw new AppError(
                "SHARE_UNVERIFIED",
                "分享已创建但核验未完成，请稍后重新核对。",
                true,
              );
            const copyId = await this.archive(account, file, parent, share);
            this.saveIntent(accountId, file.id, {
              state: "verified",
              file,
              share: { id: share.id, url: share.url, ownerUid: share.ownerUid },
              message: copyId,
            });
            result.urls.push(share.url);
          } catch (error) {
            const current = this.intent(accountId, file.id);
            const uncertain =
              !!current && (current.state !== "verified" || sent);
            if (current?.state === "requested") {
              const rejected =
                error instanceof AppError &&
                !error.uncertain &&
                [
                  "AUTH_EXPIRED",
                  "USER_ACTION_REQUIRED",
                  "REMOTE_ERROR",
                  "QUOTA_EXCEEDED",
                ].includes(error.code);
              if (rejected)
                this.d.db.run(
                  "DELETE FROM drive_share_intents WHERE account_id=? AND file_id=?",
                  accountId,
                  file.id,
                );
              else
                this.saveIntent(accountId, file.id, {
                  ...current,
                  state: "uncertain",
                  message: safeMessage(error),
                });
            }
            result.failures.push({
              id: file.id,
              name: file.name,
              message: safeMessage(error),
              uncertain,
            });
          }
        }
      });
      this.d.changed();
      return result;
    } finally {
      this.busy.delete(accountId);
    }
  }
  private async archive(
    account: Account,
    file: RemoteFile,
    parent: string,
    share: OwnShare,
  ) {
    const prior = this.d.db.get<{ id: string }>(
      "SELECT id FROM copies WHERE account_id=? AND share_url=?",
      account.id,
      share.url,
    );
    if (prior) {
      this.d.db.run(
        "UPDATE copies SET share_verified_at=?,verified_at=?,error=NULL WHERE id=?",
        now(),
        now(),
        prior.id,
      );
      return prior.id;
    }
    const oldResource = this.d.db.get<{ id: string }>(
      "SELECT id FROM resources WHERE source_url=?",
      share.url,
    );
    const resourceId = oldResource?.id ?? id("resource"),
      copyId = id("copy"),
      time = now();
    await this.d.secrets.set(`share:${copyId}`, share.code);
    await this.d.secrets.set(`source:${resourceId}`, share.code);
    this.d.db.transaction(() => {
      if (!oldResource)
        this.d.db.run(
          "INSERT INTO resources(id,title,source_url,source_key,provider,category,tags,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          resourceId,
          file.name,
          share.url,
          parseShare(share.url, share.code).shareKey,
          "baidu",
          "本人网盘",
          "[]",
          "本人网盘已有文件",
          time,
          time,
        );
      this.d.db.run(
        "UPDATE resources SET source_kind='owned' WHERE id=?",
        resourceId,
      );
      this.d.db.run(
        "INSERT INTO copies(id,resource_id,account_id,directory,folder_id,files,status,owner_uid,verified_at,share_id,share_url,share_owner_uid,share_version,share_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        copyId,
        resourceId,
        account.id,
        parent,
        parent,
        JSON.stringify([file]),
        "ready",
        account.uid,
        time,
        share.id,
        share.url,
        share.ownerUid,
        1,
        time,
        time,
        time,
      );
    });
    return copyId;
  }
  reset(accountId: string, fileIds: string[]) {
    this.d.assertNoActiveJobs(accountId);
    this.d.repo.getAccount(accountId);
    for (const fileId of fileIds) {
      const intent = this.intent(accountId, fileId);
      if (intent?.share)
        throw new AppError(
          "SHARE_EXISTS",
          "已有分享记录，请重新核对已有分享，不能清除后重复创建。",
        );
    }
    this.d.db.transaction(() => {
      for (const fileId of fileIds)
        this.d.db.run(
          "DELETE FROM drive_share_intents WHERE account_id=? AND file_id=?",
          accountId,
          fileId,
        );
    });
    return true;
  }
}

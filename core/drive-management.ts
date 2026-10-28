import { createHash } from "node:crypto";
import { now } from "./database";
import { AppError, safeMessage } from "./errors";
import { insertionName } from "../shared/insertion";
import type {
  DriveDirectory,
  DriveWriteInput,
  DriveMaterialInput,
  DriveWriteReceipt,
  ProviderFileMutation,
} from "../shared/drive-files";
import type { Account, RemoteFile } from "../shared/types";
import type { Repository } from "./repository";
import type { DriveProvider } from "./providers/provider";
import { normalizedDirectory } from "./providers/provider";
import type { InsertionService } from "./insertion";

interface Dependencies {
  repo: Repository;
  authenticated<T>(
    id: string,
    fn: (a: Account, p: DriveProvider) => Promise<T>,
  ): Promise<T>;
  assertNoActiveJobs(id: string): void;
  changed(): void;
  material: InsertionService["materialDetail"];
}
interface WriteRecord {
  ownerUid: string;
  path: string;
  folderId: string;
  receipt: DriveWriteReceipt;
  expected: RemoteFile[];
  beforeIds: string[];
  name?: string;
  size?: number;
  directory?: boolean;
  fingerprint?: string;
}
export class DriveManagement {
  private active = new Set<string>();
  get isBusy() {
    return this.active.size > 0;
  }
  busyAccount(id: string) {
    return this.active.has(id);
  }
  constructor(private d: Dependencies) {}
  private get db() {
    return this.d.repo.db;
  }
  private slot(accountId: string, path: string) {
    return `drive-write-pending:${accountId}:${createHash("sha256").update(path).digest("hex")}`;
  }
  private recordKey(accountId: string, id: string) {
    return `drive-write:${accountId}:${id}`;
  }
  /** Durable evidence used by recovery workflows; never creates or repeats a write. */
  writeReceipt(accountId: string, operationId: string): DriveWriteReceipt | null {
    const record = this.db.setting<WriteRecord | null>(
      this.recordKey(accountId, operationId),
      null,
    );
    if (!record) return null;
    if (record.ownerUid !== this.d.repo.getAccount(accountId).uid)
      throw new AppError(
        "ACCOUNT_UID_MISMATCH",
        "此写入操作属于另一个账号身份，请登录原账号后核对。",
      );
    return record.receipt;
  }
  private pending(accountId: string, path: string) {
    const id = this.db.setting<string | null>(this.slot(accountId, path), null);
    return id
      ? this.db.setting<WriteRecord | null>(this.recordKey(accountId, id), null)
      : null;
  }
  private store(accountId: string, record: WriteRecord) {
    this.db.transaction(() => {
      this.db.setSetting(this.recordKey(accountId, record.receipt.id), record);
      this.db.setSetting(
        this.slot(accountId, record.path),
        record.receipt.state === "success" ? null : record.receipt.id,
      );
    });
    this.d.changed();
  }
  private fingerprint(input: DriveWriteInput | DriveMaterialInput) {
    const file = (f: RemoteFile) => [f.id, f.name, f.isDirectory, f.size];
    return createHash("sha256")
      .update(
        JSON.stringify(
          "action" in input
            ? [input.action, input.name, input.files.map(file)]
            : [
                "material",
                input.materialId,
                input.replace ? file(input.replace) : null,
              ],
        ),
      )
      .digest("hex");
  }
  async resolveDirectory(a: Account, p: DriveProvider, raw: string) {
    const path = normalizedDirectory(raw);
    const segments = path.split("/").filter(Boolean);
    if (segments.length > 32)
      throw new AppError(
        "DIRECTORY_DEPTH",
        "目录层级超过32层，请使用更浅的目录。",
      );
    let folderId = a.provider === "baidu" ? "/" : "0";
    let currentPath = "";
    for (const name of segments) {
      const matches = (await p.list(a, folderId)).filter(
        (f) => f.name === name && f.isDirectory,
      );
      if (matches.length !== 1)
        throw new AppError(
          "DIRECTORY_CHANGED",
          "目录不存在或重名，请从上级目录重新选择。",
        );
      currentPath += "/" + name;
      folderId =
        a.provider === "baidu"
          ? (matches[0].path ?? currentPath)
          : matches[0].id;
    }
    return { path, folderId, files: await p.list(a, folderId) };
  }
  browse(accountId: string, raw: string): Promise<DriveDirectory> {
    return this.d.authenticated(accountId, async (a, p) => {
      const directory = await this.resolveDirectory(a, p, raw);
      const pending = this.pending(accountId, directory.path);
      return {
        ...directory,
        accountId,
        provider: a.provider,
        readAt: now(),
        capabilities: {
          rename: !!p.manageFile || !!p.manage,
          delete: !!p.manageFile || !!p.manage,
          upload: !!p.upload,
        },
        pending: pending?.ownerUid === a.uid ? pending.receipt : null,
      };
    });
  }
  private selected(expected: RemoteFile[], actual: RemoteFile[]) {
    if (new Set(expected.map((f) => f.id)).size !== expected.length)
      throw new AppError("INVALID_SELECTION", "文件选择存在重复，请重新选择。");
    for (const f of expected) {
      const match = actual.find((r) => r.id === f.id);
      if (
        !match ||
        match.name !== f.name ||
        match.isDirectory !== f.isDirectory ||
        match.size !== f.size
      )
        throw new AppError(
          "FILES_CHANGED",
          "文件名称、类型或大小已变化，请刷新目录后重试。",
        );
    }
    return expected.map((f) => actual.find((r) => r.id === f.id)!);
  }
  private async mutate(
    a: Account,
    p: DriveProvider,
    input: ProviderFileMutation,
  ) {
    if (p.manageFile) return p.manageFile(a, input);
    if (a.provider === "baidu" && p.manage)
      return p.manage(
        a,
        input.action,
        input.file?.path ??
          (input.file
            ? input.path.replace(/\/$/, "") + "/" + input.file.name
            : input.path),
        input.name,
      );
    if (input.action === "mkdir") {
      await p.ensureFolder(a, input.path.replace(/\/$/, "") + "/" + input.name);
      return;
    }
    throw new AppError(
      "FILE_MANAGEMENT_UNSUPPORTED",
      "此网盘尚未提供该文件管理能力，请使用官方窗口处理。",
    );
  }
  private invalidate(accountId: string, path: string) {
    // A folder share includes descendants; any overlapping path loses its old proof.
    const copies = this.db.all<{ id: string; directory: string }>(
      "SELECT id,directory FROM copies WHERE account_id=?",
      accountId,
    );
    this.db.transaction(() => {
      for (const copy of copies) {
        if (
          path !== "/" &&
          copy.directory !== "/" &&
          copy.directory !== path &&
          !path.startsWith(copy.directory + "/") &&
          !copy.directory.startsWith(path + "/")
        )
          continue;
        this.db.run(
          "UPDATE copies SET verified_at=NULL,share_verified_at=NULL,share_version=share_version+1,error='本人网盘内容已变更，请重新核验资料与分享' WHERE id=?",
          copy.id,
        );
        this.db.run("UPDATE drafts SET reviewed=0 WHERE copy_id=?", copy.id);
        this.db.run(
          "UPDATE split_items SET status=CASE WHEN share_id IS NULL THEN status ELSE 'needs_review' END,verified_at=NULL,error='网盘内容变更，请重新核验' WHERE copy_id=?",
          copy.id,
        );
      }
    });
  }
  private async write<T extends DriveWriteInput | DriveMaterialInput>(
    input: T,
    prepare: (
      a: Account,
      p: DriveProvider,
      directory: Awaited<ReturnType<DriveManagement["resolveDirectory"]>>,
    ) => Promise<{ record: WriteRecord; submit(): Promise<void> }>,
  ) {
    this.d.assertNoActiveJobs(input.accountId);
    this.active.add(input.accountId);
    try {
      return await this.d.authenticated(input.accountId, async (a, p) => {
        const old = this.db.setting<WriteRecord | null>(
          this.recordKey(a.id, input.operationId),
          null,
        );
        if (old) {
          if (
            old.ownerUid !== a.uid ||
            old.path !== normalizedDirectory(input.path) ||
            old.fingerprint !== this.fingerprint(input)
          )
            throw new AppError(
              "OPERATION_MISMATCH",
              "此请求已提交，不能更改后重复使用；请关闭对话框并重新读取目录核对结果。",
            );
          return old.receipt;
        }
        if (this.pending(a.id, normalizedDirectory(input.path)))
          throw new AppError(
            "WRITE_PENDING",
            "此目录有待核对的写入，请先核对上次结果。",
          );
        const directory = await this.resolveDirectory(a, p, input.path);
        const { record, submit } = await prepare(a, p, directory);
        record.fingerprint = this.fingerprint(input);
        this.store(a.id, record);
        this.invalidate(a.id, directory.path);
        let failure: unknown;
        let confirmed = false;
        try {
          await submit();
        } catch (error) {
          failure = error;
        }
        // A lost acknowledgement must never cause a write retry. Read the result once.
        try {
          confirmed = await this.confirm(a, p, record);
        } catch (error) {
          failure ??= error;
        }
        if (confirmed) {
          record.receipt.state = "success";
          record.receipt.message = record.receipt.backupName
            ? `已替换，原文件备份保留为「${record.receipt.backupName}」。`
            : "已完成并重新读取目录核对。";
        } else {
          record.receipt.state = "uncertain";
          record.receipt.message = `${failure ? safeMessage(failure) : "操作已提交，目录中尚未确认全部结果。"} 请先核对目录；不会自动重复写入。${record.receipt.backupName ? ` 原文件备份名：${record.receipt.backupName}。` : ""}`;
        }
        this.store(a.id, record);
        return record.receipt;
      });
    } finally {
      this.active.delete(input.accountId);
    }
  }
  manage(input: DriveWriteInput) {
    return this.write(input, async (a, p, directory) => {
      const files = this.selected(input.files, directory.files);
      if (
        input.action === "mkdir"
          ? files.length > 0
          : input.action === "rename"
            ? files.length !== 1
            : !files.length
      )
        throw new AppError("INVALID_SELECTION", "请选择与操作对应的文件。");
      const name =
        input.action === "delete" ? undefined : insertionName.parse(input.name);
      if (input.action === "rename" && name === files[0].name)
        throw new AppError("NAME_UNCHANGED", "名称没有变化，请输入新名称。");
      if (
        name &&
        directory.files.some((f) => f.name === name && f.id !== files[0]?.id)
      )
        throw new AppError("NAME_EXISTS", "目录已有同名项目，请使用其他名称。");
      if (input.action !== "mkdir" && !p.manageFile && !p.manage)
        throw new AppError("UNSUPPORTED", "此网盘尚未接入重命名或删除。");
      const record: WriteRecord = {
        ownerUid: a.uid!,
        path: directory.path,
        folderId: directory.folderId,
        receipt: {
          id: input.operationId,
          action: input.action,
          state: "pending",
          message: "已记录操作意图，正在提交。",
        },
        expected: files,
        beforeIds: directory.files.map((f) => f.id),
        name,
        directory: input.action === "mkdir",
      };
      return {
        record,
        submit: async () => {
          if (input.action === "mkdir")
            await this.mutate(a, p, {
              action: "mkdir",
              parentId: directory.folderId,
              path: directory.path,
              name,
            });
          else
            for (const file of files)
              await this.mutate(a, p, {
                action: input.action,
                parentId: directory.folderId,
                path: directory.path,
                file,
                name,
              });
        },
      };
    });
  }
  material(input: DriveMaterialInput) {
    return this.write(input, async (a, p, directory) => {
      const material = this.d.material(input.materialId);
      const replace = input.replace
        ? this.selected([input.replace], directory.files)[0]
        : null;
      if (replace?.isDirectory || (replace && material.kind === "folder"))
        throw new AppError(
          "REPLACE_FILE_ONLY",
          "替换只支持TXT或图片文件，文件夹请单独管理。",
        );
      if (replace && !p.manageFile && !p.manage)
        throw new AppError(
          "UNSUPPORTED",
          "此网盘未接入重命名，无法安全备份后替换。",
        );
      if (material.kind !== "folder" && !p.upload)
        throw new AppError("UPLOAD_UNSUPPORTED", "此网盘未提供文件上传能力。");
      const name = insertionName.parse(replace?.name ?? material.name);
      const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
      const imageMime: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
      };
      if (
        replace &&
        (material.kind === "txt"
          ? extension !== "txt"
          : imageMime[extension] !== material.mime)
      )
        throw new AppError(
          "FORMAT_MISMATCH",
          "替换素材与原文件扩展名不同，请选择格式一致的素材。",
        );
      if (directory.files.some((f) => f.name === name && f.id !== replace?.id))
        throw new AppError(
          "NAME_EXISTS",
          "已存在同名文件；请选中该文件后使用“替换广告”。",
        );
      const backupName = replace
        ? `${replace.name.slice(0, 100)}.替换前备份-${input.operationId.slice(-10)}`
        : undefined;
      if (backupName && directory.files.some((f) => f.name === backupName))
        throw new AppError("NAME_EXISTS", "备份名称已存在，请重新核对目录。");
      const record: WriteRecord = {
        ownerUid: a.uid!,
        path: directory.path,
        folderId: directory.folderId,
        receipt: {
          id: input.operationId,
          action: replace ? "replace" : "upload",
          state: "pending",
          message: "正在写入素材。",
          backupName,
        },
        expected: replace ? [replace] : [],
        beforeIds: directory.files.map((f) => f.id),
        name,
        size: material.size,
        directory: material.kind === "folder",
      };
      return {
        record,
        submit: async () => {
          if (replace) {
            await this.mutate(a, p, {
              action: "rename",
              path: directory.path,
              parentId: directory.folderId,
              file: replace,
              name: backupName,
            });
            const backup = (await p.list(a, directory.folderId)).find(
              (f) => f.id === replace.id && f.name === backupName,
            );
            if (!backup)
              throw new AppError(
                "BACKUP_UNCONFIRMED",
                "原文件备份尚未确认，未上传替换文件。",
                true,
              );
          }
          // Check again after the backup write; never overwrite an unrelated arrival.
          if (
            (await p.list(a, directory.folderId)).some((f) => f.name === name)
          )
            throw new AppError(
              "NAME_EXISTS",
              "提交前出现同名项目，已停止，请核对目录。",
            );
          if (material.kind === "folder")
            await this.mutate(a, p, {
              action: "mkdir",
              path: directory.path,
              parentId: directory.folderId,
              name,
            });
          else {
            const bytes =
              material.kind === "txt"
                ? Buffer.from(material.text!, "utf8")
                : Buffer.from(material.dataUrl!.split(",")[1], "base64");
            await p.upload!(a, directory.folderId, {
              name,
              bytes,
              mime: material.mime,
            });
          }
        },
      };
    });
  }
  private async confirm(a: Account, p: DriveProvider, r: WriteRecord) {
    const { files, folderId } = await this.resolveDirectory(a, p, r.path);
    if (folderId !== r.folderId)
      throw new AppError(
        "DIRECTORY_CHANGED",
        "原目录已被移动或重建，请在网盘核对上次操作结果。",
      );
    if (r.receipt.action === "delete")
      return r.expected.every((f) => !files.some((v) => v.id === f.id));
    if (r.receipt.action === "rename")
      return files.some((f) => f.id === r.expected[0].id && f.name === r.name);
    if (
      r.receipt.action === "replace" &&
      !files.some(
        (f) => f.id === r.expected[0].id && f.name === r.receipt.backupName,
      )
    )
      return false;
    return (
      files.filter(
        (f) =>
          !r.beforeIds.includes(f.id) &&
          f.name === r.name &&
          f.isDirectory === r.directory &&
          (f.isDirectory || f.size === r.size),
      ).length === 1
    );
  }
  recheck(accountId: string, path: string) {
    return this.d.authenticated(accountId, async (a, p) => {
      const record = this.pending(accountId, normalizedDirectory(path));
      if (!record) return null;
      if (record.ownerUid !== a.uid)
        throw new AppError(
          "ACCOUNT_UID_MISMATCH",
          "此待核对操作属于另一个账号身份。",
        );
      if (await this.confirm(a, p, record)) {
        record.receipt.state = "success";
        record.receipt.message = "已读取目录确认上次操作结果，没有重复写入。";
        this.store(accountId, record);
      }
      return record.receipt;
    });
  }
  async adoptCopy(input: {
    copyId: string;
    accountId: string;
    path: string;
    files: RemoteFile[];
  }) {
    this.d.assertNoActiveJobs(input.accountId);
    this.active.add(input.accountId);
    try {
      return await this.d.authenticated(
        input.accountId,
        async (account, provider) => {
          const copy = this.d.repo.getCopy(input.copyId);
          if (
            copy.accountId !== account.id ||
            copy.status !== "ready" ||
            copy.ownerUid !== account.uid ||
            !copy.folderId ||
            normalizedDirectory(copy.directory) !==
              normalizedDirectory(input.path)
          )
            throw new AppError(
              "COPY_SCOPE_MISMATCH",
              "此目录与已归档资源副本不匹配，请打开该资源原来的保存目录。",
            );
          if (this.pending(account.id, normalizedDirectory(input.path)))
            throw new AppError(
              "WRITE_PENDING",
              "请先核对目录中尚未确认的写入结果。",
            );
          const directory = await this.resolveDirectory(
            account,
            provider,
            input.path,
          );
          if (directory.folderId !== copy.folderId)
            throw new AppError(
              "DIRECTORY_CHANGED",
              "原目录已被移动或重建，请核对资源归属。",
            );
          const files = this.selected(input.files, directory.files);
          this.db.transaction(() => {
            this.db.run(
              "UPDATE copies SET files=?,verified_at=?,share_verified_at=NULL,share_version=share_version+1,error='资源文件清单已更新，请核验或重新创建本人分享',updated_at=? WHERE id=?",
              JSON.stringify(files),
              now(),
              now(),
              copy.id,
            );
            this.db.run(
              "UPDATE drafts SET reviewed=0 WHERE copy_id=?",
              copy.id,
            );
            this.db.run(
              "UPDATE split_items SET status=CASE WHEN share_id IS NULL THEN status ELSE 'needs_review' END,verified_at=NULL,error='资源文件清单变更，请重新核验' WHERE copy_id=?",
              copy.id,
            );
          });
          this.d.changed();
          return true;
        },
      );
    } finally {
      this.active.delete(input.accountId);
    }
  }
  resolve(accountId: string, path: string, operationId: string) {
    this.d.assertNoActiveJobs(accountId);
    const record = this.pending(accountId, normalizedDirectory(path));
    if (!record || record.receipt.id !== operationId)
      throw new AppError("OPERATION_CHANGED", "待核对操作已变化，请重新读取。");
    if (record.ownerUid !== this.d.repo.getAccount(accountId).uid)
      throw new AppError(
        "ACCOUNT_UID_MISMATCH",
        "待核对操作与当前账号身份不同，请登录原账号后处理。",
      );
    this.db.setSetting(this.slot(accountId, normalizedDirectory(path)), null);
    this.d.changed();
    return true;
  }
}

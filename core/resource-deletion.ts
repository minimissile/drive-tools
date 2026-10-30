import { createHash, randomUUID } from "node:crypto";
import { now, parseJson } from "./database";
import { AppError, safeMessage } from "./errors";
import { removeResourceRecords } from "./resource-records";
import type { Repository } from "./repository";
import type { DriveFiles } from "./drive-files";
import type { Resource, RemoteFile } from "../shared/types";
import type {
  ResourceDeleteCopy,
  ResourceDeletePreview,
  ResourceDeleteResult,
} from "../shared/resource-deletion";

interface Dependencies {
  repo: Repository;
  driveFiles: DriveFiles;
  hasRunningJobs(): boolean;
  changed(): void;
}
interface Target {
  copyId: string;
  accountId: string;
  ownerUid: string;
  files: RemoteFile[];
  operationId: string;
  path: string | null;
  folderId: string | null;
  attempted: boolean;
}
interface DeleteRecord {
  preview: ResourceDeletePreview;
  fingerprint: string;
  expiresAt: number;
  result: ResourceDeleteResult;
  targets: Target[];
}
const prefix = "resource-deletion:";
const pendingKey = (id: string) => `resource-deletion-pending:${id}`;
const fingerprint = (resource: Resource) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        resource.id,
        resource.revision,
        resource.sourceUrl,
        resource.copies.map((copy) => [
          copy.id,
          copy.accountId,
          copy.directory,
          copy.folderId,
          copy.ownerUid,
          copy.files,
        ]),
      ]),
    )
    .digest("hex");
const sameFile = (a: RemoteFile, b: RemoteFile) =>
  a.id === b.id &&
  a.name === b.name &&
  a.isDirectory === b.isDirectory &&
  a.size === b.size;

/** Explicit resource removal. Remote receipts survive restarts and are never replayed. */
export class ResourceDeletion {
  private previews = new Map<string, DeleteRecord>();
  private active = new Set<string>();
  get isBusy() {
    return this.active.size > 0;
  }
  constructor(private d: Dependencies) {}
  private get db() {
    return this.d.repo.db;
  }
  private stored(token: string) {
    return this.db.setting<DeleteRecord | null>(prefix + token, null);
  }
  private pending(resourceId: string) {
    const token = this.db.setting<string | null>(pendingKey(resourceId), null);
    return token ? this.stored(token) : null;
  }
  assertMutable(resourceId: string) {
    if (this.active.has(resourceId) || this.pending(resourceId))
      throw new AppError(
        "RESOURCE_DELETE_PENDING",
        "此资源正在删除或等待核对删除结果，请先完成删除结果核对。",
      );
  }
  private blockers(resourceId: string, allowedOperations: string[] = []) {
    const reasons: string[] = [];
    if (this.db.get(
      "SELECT id FROM resource_links WHERE resource_id=? AND (json_extract(data,'$.enabled')=1 OR json_extract(data,'$.operationId') IS NOT NULL) LIMIT 1",
      resourceId,
    )) reasons.push("此资源仍有启用或待核对的固定入口，请先在资源详情停用入口并完成同步，再删除本地记录。");
    if (
      this.db.get(
        "SELECT p.id FROM publications p JOIN drafts d ON d.id=p.draft_id WHERE d.resource_id=? LIMIT 1",
        resourceId,
      )
    )
      reasons.push("此资源已关联发布记录。为保留发布和效果历史，暂不能删除。");
    if (
      this.db.get(
        "SELECT article.key FROM settings article WHERE article.key LIKE 'smzdm:article:v1:%' AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(article.value) THEN article.value ELSE '{}' END,'$.links') link WHERE json_extract(link.value,'$.resourceId')=? OR json_extract(link.value,'$.copyId') IN (SELECT id FROM copies WHERE resource_id=?)) LIMIT 1",
        resourceId,
        resourceId,
      )
    )
      reasons.push(
        "此资源仍被什么值得买文章引用，请先处理文章或解除资源关联后再删除。",
      );
    if (
      this.db.get(
        "SELECT id FROM studio_jobs WHERE draft_id IN (SELECT id FROM drafts WHERE resource_id=?) AND json_extract(data,'$.status') IN ('submitting','pending','in_progress','uncertain','download_failed') LIMIT 1",
        resourceId,
      )
    )
      reasons.push("此资源仍有关联媒体任务等待完成或核对，请先处理原任务。");
    if (
      this.db.get(
        "SELECT key FROM settings WHERE (key LIKE 'weiboMarketing:v1:%' OR key LIKE 'resourceAnswers:run:%') AND json_valid(value) AND json_extract(value,'$.draftId') IN (SELECT id FROM drafts WHERE resource_id=?) LIMIT 1",
        resourceId,
      )
    )
      reasons.push(
        "此资源的稿件已关联图文营销或资源问答历史，请先保留并处理原流程。",
      );
    if (
      this.db.get(
        "SELECT t.id FROM distribution_tasks t WHERE t.status IN ('submitting','uncertain') AND (t.resource_id=? OR EXISTS(SELECT 1 FROM distribution_task_sources s WHERE s.task_id=t.id AND s.resource_id=? AND s.active=1)) LIMIT 1",
        resourceId,
        resourceId,
      )
    )
      reasons.push("此资源仍有分发结果待核对，请先核对原提交记录。");
    if (
      this.db.get(
        "SELECT j.id FROM jobs j JOIN copies c ON c.id=j.copy_id WHERE c.resource_id=? AND j.stage IN ('queued','preflight','transferring','verifying','sharing','archiving') LIMIT 1",
        resourceId,
      )
    )
      reasons.push(
        "此资源仍有进行中的转存、分享或归档任务，请先停止或完成任务。",
      );
    if (
      this.db.get(
        "SELECT j.id FROM jobs j JOIN copies c ON c.id=j.copy_id WHERE c.resource_id=? AND j.stage!='completed' AND (j.stage='needs_review' OR j.checkpoint IN ('transfer_requested','remote_task','share_requested')) LIMIT 1",
        resourceId,
      )
    )
      reasons.push(
        "此资源先前的转存或建链结果仍待核对，请先处理原任务，不能直接移除恢复记录。",
      );
    if (
      this.db.get(
        "SELECT i.account_id FROM drive_share_intents i WHERE i.account_id IN (SELECT account_id FROM copies WHERE resource_id=?) AND json_extract(i.data,'$.state') IN ('requested','created','uncertain') LIMIT 1",
        resourceId,
      )
    )
      reasons.push(
        "资源所属账号仍有网盘分享结果待核对，请先处理本人分享记录。",
      );
    if (
      this.db.get(
        "SELECT r.id FROM insertion_runs r,json_each(r.data,'$.items') item WHERE json_extract(item.value,'$.target.accountId') IN (SELECT account_id FROM copies WHERE resource_id=?) AND json_extract(item.value,'$.state') IN ('writing','uncertain') LIMIT 1",
        resourceId,
      )
    )
      reasons.push("资源所属账号仍有广告插入结果待核对，请先处理原插入任务。");
    const accounts = this.db.all<{ account_id: string }>(
      "SELECT DISTINCT account_id FROM copies WHERE resource_id=?",
      resourceId,
    );
    const pending = this.db.all<{ key: string; value: string }>(
      "SELECT key,value FROM settings WHERE key LIKE 'drive-write-pending:%' AND value!='null'",
    );
    if (
      pending.some(
        (row) =>
          accounts.some((account) =>
            row.key.startsWith(`drive-write-pending:${account.account_id}:`),
          ) && !allowedOperations.includes(parseJson(row.value, "")),
      )
    )
      reasons.push(
        "资源所属账号仍有待核对的网盘写入，请先核对目录中的原操作结果。",
      );
    return reasons;
  }
  private copyPreview(resource: Resource): ResourceDeleteCopy[] {
    return resource.copies.map((copy) => {
      const account = this.d.repo.getAccount(copy.accountId);
      let reason = "";
      if (!account.enabled || !account.uid)
        reason = "账号未启用或尚未确认本人身份。";
      else if (copy.status !== "ready" || copy.ownerUid !== account.uid)
        reason = "副本尚未核验为此账号的本人网盘文件。";
      else if (!copy.files.length) reason = "未记录可核对的网盘文件清单。";
      else if (
        copy.files.some(
          (file) =>
            !file.id ||
            ["0", "/"].includes(file.id) ||
            !file.name ||
            file.path === "/",
        )
      )
        reason = "文件清单中含根目录或无法确定的项目。";
      return {
        copyId: copy.id,
        accountId: account.id,
        accountAlias: account.alias,
        directory: copy.directory,
        files: copy.files,
        canDeleteRemote: !reason,
        reason,
      };
    });
  }
  accountResources(accountId: string) {
    return this.db
      .all<{ resource_id: string }>(
        "SELECT DISTINCT resource_id FROM copies WHERE account_id=? ORDER BY resource_id",
        accountId,
      )
      .map((row) => this.d.repo.getResource(row.resource_id));
  }
  accountBlockers(accountId: string) {
    const reasons: string[] = [];
    for (const resource of this.accountResources(accountId)) {
      if (this.active.has(resource.id) || this.pending(resource.id))
        reasons.push(`${resource.title}：已有资源删除操作待完成或核对。`);
      reasons.push(
        ...this.blockers(resource.id).map(
          (reason) => `${resource.title}：${reason}`,
        ),
      );
    }
    return [...new Set(reasons)];
  }
  removeAccountResources(accountId: string) {
    const blockers = this.accountBlockers(accountId);
    if (blockers.length)
      throw new AppError("ACCOUNT_RESOURCES_IN_USE", blockers.join(" "));
    for (const resource of this.accountResources(accountId))
      removeResourceRecords(
        this.db,
        resource,
        resource.copies.filter((copy) => copy.accountId === accountId),
      );
  }
  preview(resourceId: string): ResourceDeletePreview {
    const previous = this.pending(resourceId);
    if (previous) return { ...previous.preview, pending: previous.result };
    const resource = this.d.repo.getResource(resourceId);
    const copies = this.copyPreview(resource);
    const remoteBlockers = copies
      .filter((copy) => !copy.canDeleteRemote)
      .map((copy) => `${copy.accountAlias}：${copy.reason}`);
    if (!copies.length) remoteBlockers.push("此资源没有已记录的本人网盘副本。");
    const seen = new Set<string>();
    for (const copy of copies)
      for (const file of copy.files) {
        const key = `${copy.accountId}:${file.id}`;
        if (seen.has(key))
          remoteBlockers.push(
            "副本文件清单存在重复或重叠，请先核对各账号的资源清单。",
          );
        seen.add(key);
      }
    const token = randomUUID();
    const preview: ResourceDeletePreview = {
      token,
      resourceId,
      title: resource.title,
      copies,
      draftCount: this.db.get<{ n: number }>(
        "SELECT count(*) n FROM drafts WHERE resource_id=?",
        resourceId,
      )!.n,
      blockers: this.blockers(resourceId),
      remoteBlockers: [...new Set(remoteBlockers)],
      pending: null,
    };
    const record: DeleteRecord = {
      preview,
      fingerprint: fingerprint(resource),
      expiresAt: Date.now() + 15 * 60_000,
      result: {
        operationId: token,
        resourceId,
        mode: "local",
        state: "pending",
        message: "等待确认删除。",
        copies: [],
      },
      targets: [],
    };
    // A preview never writes the workspace or contacts the cloud.
    for (const [key, value] of this.previews)
      if (value.expiresAt < Date.now()) this.previews.delete(key);
    this.previews.set(token, record);
    return preview;
  }
  private save(record: DeleteRecord) {
    this.db.transaction(() => {
      this.db.setSetting(prefix + record.result.operationId, record);
      this.db.setSetting(
        pendingKey(record.result.resourceId),
        record.result.state === "deleted" ? null : record.result.operationId,
      );
    });
    this.d.changed();
  }
  private checkCurrent(record: DeleteRecord) {
    const resource = this.d.repo.getResource(record.result.resourceId);
    if (fingerprint(resource) !== record.fingerprint)
      throw new AppError(
        "RESOURCE_CHANGED",
        "资源资料或副本文件清单已变化，请重新打开删除预览核对；本地资料仍保留。",
      );
    const blockers = this.blockers(
      resource.id,
      record.targets.map((target) => target.operationId),
    );
    if (blockers.length)
      throw new AppError("RESOURCE_IN_USE", blockers.join(" "));
    return resource;
  }
  async remove(input: {
    token: string;
    mode: "local" | "remote";
    confirmed: true;
  }): Promise<ResourceDeleteResult> {
    const stored = this.stored(input.token);
    const record = stored ?? this.previews.get(input.token);
    if (!record)
      throw new AppError(
        "DELETE_PREVIEW_EXPIRED",
        "删除预览已失效，请重新打开并核对。",
      );
    if (stored && stored.result.mode !== input.mode)
      throw new AppError(
        "DELETE_MODE_MISMATCH",
        "已有删除操作不能更换删除范围，请先核对原操作。",
      );
    if (record.result.state === "deleted") return record.result;
    if (this.active.has(record.result.resourceId))
      throw new AppError(
        "RESOURCE_DELETE_BUSY",
        "此资源正在处理删除，请等待当前操作完成。",
      );
    if (this.d.hasRunningJobs())
      throw new AppError(
        "ACTIVE_JOBS",
        "仍有任务正在执行，请先完成或停止任务后再删除资源。",
      );
    if (!stored && record.expiresAt < Date.now())
      throw new AppError(
        "DELETE_PREVIEW_EXPIRED",
        "删除预览已过期，请重新打开并核对。",
      );
    const existing = this.pending(record.result.resourceId);
    if (existing && existing.result.operationId !== input.token)
      throw new AppError(
        "RESOURCE_DELETE_PENDING",
        "此资源已有待核对的删除操作，请先核对原结果。",
      );
    this.checkCurrent(record);
    if (input.mode === "remote" && record.preview.remoteBlockers.length)
      throw new AppError(
        "REMOTE_DELETE_UNAVAILABLE",
        record.preview.remoteBlockers.join(" "),
      );
    this.active.add(record.result.resourceId);
    try {
      if (input.mode === "local") {
        if (existing)
          throw new AppError(
            "RESOURCE_DELETE_PENDING",
            "请先核对已提交的网盘删除结果，不能直接移除本地记录。",
          );
        record.result.mode = "local";
        return this.finish(record);
      }
      if (!stored) {
        record.result.mode = "remote";
        record.targets = record.preview.copies.map((copy) => ({
          copyId: copy.copyId,
          accountId: copy.accountId,
          ownerUid: this.d.repo.getAccount(copy.accountId).uid!,
          files: copy.files,
          operationId: randomUUID(),
          path: null,
          folderId: null,
          attempted: false,
        }));
        record.result.copies = record.preview.copies.map((copy) => ({
          copyId: copy.copyId,
          accountAlias: copy.accountAlias,
          directory: copy.directory,
          state: "waiting",
          receipt: null,
        }));
        this.save(record);
      }
      if (record.result.copies.some((copy) => copy.state === "uncertain"))
        return record.result;
      // Locate every not-yet-submitted copy before the first write. A folder in
      // one copy must not implicitly remove a different copy's selected files.
      const planned: {
        accountId: string;
        id: string;
        path: string;
        directory: boolean;
      }[] = [];
      for (const target of record.targets) {
        const item = record.result.copies.find(
          (copy) => copy.copyId === target.copyId,
        )!;
        if (item.state === "success") continue;
        const location = await this.locate(target);
        for (const file of location.files)
          planned.push({
            accountId: target.accountId,
            id: file.id,
            path:
              file.path ??
              location.directory.path.replace(/\/$/, "") + "/" + file.name,
            directory: file.isDirectory,
          });
      }
      if (
        planned.some((file, index) =>
          planned.some(
            (other, otherIndex) =>
              index !== otherIndex &&
              file.accountId === other.accountId &&
              (file.id === other.id ||
                (file.directory &&
                  other.path.startsWith(file.path.replace(/\/$/, "") + "/"))),
          ),
        )
      )
        throw new AppError(
          "OVERLAPPING_RESOURCE_FILES",
          "副本网盘文件存在重复或父子重叠，请先整理资源清单；没有继续删除网盘文件。",
        );
      for (const target of record.targets) {
        const item = record.result.copies.find(
          (copy) => copy.copyId === target.copyId,
        )!;
        if (item.state === "success") continue;
        // Resolve and compare the exact manifest before recording any remote intent.
        const location = await this.locate(target);
        target.path = location.directory.path;
        target.folderId = location.directory.folderId;
        item.directory = target.path;
        target.attempted = true;
        item.state = "uncertain";
        record.result.state = "uncertain";
        record.result.message =
          "正在提交已确认的网盘文件删除；本地资源暂时保留。";
        this.save(record);
        try {
          const receipt = await this.d.driveFiles.management.manage({
            operationId: target.operationId,
            accountId: target.accountId,
            path: target.path,
            action: "delete",
            files: location.files,
            confirmed: true,
          });
          item.receipt = receipt;
          item.state = receipt.state === "success" ? "success" : "uncertain";
        } catch (error) {
          record.result.message = `${safeMessage(error)} 本地资源已保留，请只读核对结果，不会重复提交。`;
          this.save(record);
          return record.result;
        }
        if (item.state !== "success") {
          record.result.message =
            "网盘删除结果尚未全部确认，本地资源已保留。请只读核对结果；不会自动重复删除。";
          this.save(record);
          return record.result;
        }
        record.result.state = "pending";
        record.result.message =
          "已确认一个副本的网盘文件删除，正在继续其余副本。";
        this.save(record);
      }
      return this.finish(record);
    } catch (error) {
      if (
        input.mode === "remote" &&
        record.targets.every((target) => !target.attempted)
      ) {
        // Failure during read-only preflight is safe to abandon. Keep the preview
        // reusable so the user can choose local-only removal instead.
        this.db.run(
          "DELETE FROM settings WHERE key IN (?,?)",
          prefix + input.token,
          pendingKey(record.result.resourceId),
        );
        record.targets = [];
        record.result.mode = "local";
        record.result.copies = [];
        throw error;
      }
      if (input.mode === "remote") {
        record.result.state = record.result.copies.some(
          (copy) => copy.state === "uncertain",
        )
          ? "uncertain"
          : "pending";
        record.result.message = `${safeMessage(error)} 本地资源继续保留。`;
        this.save(record);
        return record.result;
      }
      throw error;
    } finally {
      this.active.delete(record.result.resourceId);
    }
  }
  private async locate(target: Target) {
    const location = await this.d.driveFiles.locateCopy(target.copyId);
    if (
      this.d.repo.getAccount(target.accountId).uid !== target.ownerUid ||
      target.files.length !== location.files.length ||
      !target.files.every((file) =>
        location.files.some((current) => sameFile(file, current)),
      )
    )
      throw new AppError(
        "FILES_CHANGED",
        "本人身份或文件清单已变化，请核对资源；本地记录仍保留。",
      );
    if (!location.directory.capabilities.delete || location.directory.pending)
      throw new AppError(
        "REMOTE_DELETE_UNAVAILABLE",
        "此网盘暂不支持删除，或目录仍有待核对的写入。请先处理原操作。",
      );
    return location;
  }
  async recheck(operationId: string): Promise<ResourceDeleteResult> {
    const record = this.stored(operationId);
    if (!record) throw new AppError("NOT_FOUND", "删除操作记录不存在。");
    if (record.result.state === "deleted") return record.result;
    if (record.result.mode !== "remote")
      throw new AppError(
        "INVALID_DELETE_MODE",
        "此操作没有需要核对的网盘删除。",
      );
    if (this.active.has(record.result.resourceId) || this.d.hasRunningJobs())
      throw new AppError(
        "ACTIVE_JOBS",
        "仍有任务正在执行，请稍后核对删除结果。",
      );
    this.active.add(record.result.resourceId);
    try {
      for (const target of record.targets) {
        const item = record.result.copies.find(
          (copy) => copy.copyId === target.copyId,
        )!;
        if (!target.attempted || item.state === "success" || !target.path)
          continue;
        if (this.d.repo.getAccount(target.accountId).uid !== target.ownerUid)
          throw new AppError(
            "ACCOUNT_UID_MISMATCH",
            "请登录原来的本人账号后核对删除结果。",
          );
        const recorded = this.d.driveFiles.management.writeReceipt(
          target.accountId,
          target.operationId,
        );
        // recheck never starts a write. A null pending slot alone proves neither
        // success nor failure; inspect the durable operation before recovery.
        const receipt =
          recorded?.state === "success"
            ? recorded
            : recorded
              ? await this.d.driveFiles.management.recheck(
                  target.accountId,
                  target.path,
                )
              : null;
        if (receipt && receipt.id === target.operationId) {
          item.receipt = receipt;
          item.state = receipt.state === "success" ? "success" : "uncertain";
        } else if (!receipt) {
          // A restart may occur after the drive receipt was confirmed but before
          // this workflow persisted it. Absence in the same directory is evidence;
          // a cleared pending slot alone is not.
          const directory = await this.d.driveFiles.management.browse(
            target.accountId,
            target.path,
          );
          if (
            directory.folderId === target.folderId &&
            target.files.every(
              (file) =>
                !directory.files.some((current) => current.id === file.id),
            )
          ) {
            item.receipt = {
              id: target.operationId,
              action: "delete",
              state: "success",
              message: "已只读确认原目录中的全部目标文件不存在，没有重复写入。",
            };
            item.state = "success";
          } else if (
            !recorded &&
            !directory.pending &&
            directory.folderId === target.folderId &&
            target.files.every((file) =>
              directory.files.some((current) => sameFile(file, current)),
            )
          ) {
            // The process stopped between this workflow's intent and the drive
            // intent. No drive intent was ever saved and the complete original
            // manifest remains, so an explicit continue may submit it once.
            target.attempted = false;
            item.state = "waiting";
            item.receipt = null;
          }
        }
      }
      if (record.result.copies.every((copy) => copy.state === "success"))
        return this.finish(record);
      record.result.state = record.result.copies.some(
        (copy) => copy.state === "uncertain",
      )
        ? "uncertain"
        : "pending";
      record.result.message =
        record.result.state === "uncertain"
          ? "仍有网盘删除结果未确认，本地资源继续保留；请核对原目录，不会重复写入。"
          : "已确认先前提交的删除结果；其余副本尚未提交，请明确确认后继续删除。";
      this.save(record);
      return record.result;
    } finally {
      this.active.delete(record.result.resourceId);
    }
  }
  private finish(record: DeleteRecord): ResourceDeleteResult {
    const resource = this.checkCurrent(record);
    const completed: ResourceDeleteResult = {
      ...record.result,
      state: "deleted",
      message:
        record.result.mode === "remote"
          ? "所有副本网盘文件已确认删除，本地资源记录已删除。"
          : "本地资源及关联未发布稿件已删除，网盘文件保留。",
    };
    this.db.transaction(() => {
      removeResourceRecords(this.db, resource);
      this.db.setSetting(prefix + completed.operationId, {
        ...record,
        result: completed,
      });
      this.db.setSetting(pendingKey(resource.id), null);
    });
    record.result = completed;
    this.previews.delete(record.result.operationId);
    this.d.changed();
    return record.result;
  }
}

import { now } from "./database";
import { randomBytes } from "node:crypto";
import { AppError, ProviderHttpError, safeMessage } from "./errors";
import { parseShare } from "./links";
import {
  shareCreationCapabilities,
  shareCreationOptionsError,
} from "../shared/share-options";
import type {
  ShareCreateInput,
  ShareCreationContext,
  ShareCreationReceipt,
} from "../shared/share-creation";
import type {
  Account,
  Provider,
  RemoteFile,
  ResourceCopy,
} from "../shared/types";
import type { Repository } from "./repository";
import type { SecretStore } from "./secrets";
import type { DriveFiles } from "./drive-files";
import type { DriveProvider, OwnShare } from "./providers/provider";

interface Dependencies {
  repo: Repository;
  secrets: SecretStore;
  driveFiles: DriveFiles;
  hasRunningJobs(): boolean;
  assertIdle(accountId: string): void;
  assertMutable(resourceId: string): void;
  authenticated<T>(
    accountId: string,
    action: (account: Account, provider: DriveProvider) => Promise<T>,
  ): Promise<T>;
  changed(): void;
}

interface CreationRecord {
  accountId: string;
  ownerUid: string;
  provider: Provider;
  files: RemoteFile[];
  shareId?: string;
  codeRequired: boolean;
  settingsConfirmed: boolean;
  expiresInDays: number;
  receipt: Omit<ShareCreationReceipt, "code">;
}

const recordKey = (id: string) => `share-creation:${id}`;
const latestKey = (copyId: string) => `share-creation-latest:${copyId}`;
const requestSecret = (id: string) => `share-creation-request:${id}`;
const resultSecret = (id: string) => `share-creation-result:${id}`;
const manifestKey = (files: RemoteFile[]) =>
  JSON.stringify(
    files.map((file) => [file.id, file.name, file.isDirectory, file.size]),
  );
const matchesFile = (expected: RemoteFile, actual: RemoteFile) =>
  expected.id === actual.id &&
  expected.name === actual.name &&
  expected.isDirectory === actual.isDirectory &&
  (expected.isDirectory ||
    expected.size == null ||
    expected.size === actual.size);
const definiteRejection = (error: unknown) => {
  if (!(error instanceof AppError) || error.uncertain) return false;
  if (error instanceof ProviderHttpError)
    return [
      400, 401, 402, 403, 404, 405, 406, 409, 410, 412, 413, 414, 415, 422, 423,
      429,
    ].includes(error.status);
  return [
    "AUTH_EXPIRED",
    "ACCOUNT_UID_MISMATCH",
    "USER_ACTION_REQUIRED",
    "QUOTA_EXCEEDED",
    "BAD_CODE",
    "SHARE_OPTIONS_UNSUPPORTED",
    "INVALID_SHARE_OPTIONS",
    "UNSUPPORTED",
  ].includes(error.code);
};
const publicFailure = (error: unknown, codes: (string | undefined)[]) => {
  let message = safeMessage(error).replace(
    /([?&](?:pwd|passcode|code)=)[^&\s]+/gi,
    "$1[已隐藏]",
  );
  for (const code of codes)
    if (code) message = message.split(code).join("[已隐藏提取码]");
  return message;
};

/** Independent explicit creation. Journal entries never become resource copies. */
export class ShareCreation {
  private active = new Set<string>();
  get isBusy() {
    return this.active.size > 0;
  }
  busyAccount(accountId: string) {
    return this.active.has(accountId);
  }
  constructor(private d: Dependencies) {}
  private get db() {
    return this.d.repo.db;
  }
  private record(operationId: string) {
    return this.db.setting<CreationRecord | null>(recordKey(operationId), null);
  }
  private latest(copyId: string) {
    const operationId = this.db.setting<string | null>(latestKey(copyId), null);
    return operationId ? this.record(operationId) : null;
  }
  private store(record: CreationRecord, updateLatest = false) {
    this.db.transaction(() => {
      this.db.setSetting(recordKey(record.receipt.operationId), record);
      if (updateLatest)
        this.db.setSetting(
          latestKey(record.receipt.copyId),
          record.receipt.operationId,
        );
    });
    this.d.changed();
  }
  private async receipt(record: CreationRecord): Promise<ShareCreationReceipt> {
    if (this.d.repo.getAccount(record.accountId).uid !== record.ownerUid)
      throw new AppError(
        "ACCOUNT_UID_MISMATCH",
        "此分享创建记录属于原网盘账号，请登录原账号后查看。",
      );
    const code = record.receipt.url
      ? await this.d.secrets.get(resultSecret(record.receipt.operationId))
      : null;
    const missingCode =
      record.receipt.state === "success" && record.codeRequired && !code;
    return {
      ...record.receipt,
      ...(missingCode
        ? {
            state: "uncertain" as const,
            message:
              "新分享已创建，但本地提取码尚未读取，请只读核对后再复制完整分享。",
          }
        : {}),
      hasReturnedShare: !!record.shareId,
      ...(code ? { code } : {}),
    };
  }
  private async rememberReturned(record: CreationRecord, share: OwnShare) {
    if (!share.id || (record.shareId && record.shareId !== share.id))
      throw new AppError("SHARE_UNVERIFIED", "返回的新分享ID缺失或发生变化。");
    record.shareId = share.id;
    record.receipt.hasReturnedShare = true;
    record.codeRequired ||= !!share.code;
    record.receipt.message =
      "网盘已返回新分享ID，正在读取并核对链接；原资源记录未修改。";
    // A returned ID remains recoverable even if the URL read or secret save fails.
    this.store(record);
    let code = share.code;
    if (share.url) {
      const parsed = parseShare(share.url, share.code);
      if (parsed.provider !== record.provider)
        throw new AppError(
          "SHARE_UNVERIFIED",
          "返回的分享类型与当前账号不一致。",
        );
      record.receipt.url = parsed.url;
      code = parsed.code;
      record.codeRequired ||= !!code;
      record.receipt.message =
        "网盘已返回新分享，正在核对结果；原资源记录未修改。";
    }
    if (share.expiresAt !== undefined)
      record.receipt.expiresAt = share.expiresAt;
    this.store(record);
    if (code) {
      try {
        await this.d.secrets.set(
          resultSecret(record.receipt.operationId),
          code,
        );
      } catch (error) {
        // Keep reading the URL after an ID-only response even if secret storage fails.
        if (share.url) throw error;
      }
    }
    return code || undefined;
  }
  async result(operationId: string) {
    const record = this.record(operationId);
    return record ? this.receipt(record) : null;
  }
  async options(copyId: string): Promise<ShareCreationContext> {
    const copy = this.d.repo.getCopy(copyId);
    const resource = this.d.repo.getResource(copy.resourceId);
    const account = this.d.repo.getAccount(copy.accountId);
    const latest = this.latest(copyId);
    return {
      copyId,
      title: resource.title,
      provider: account.provider,
      accountAlias: account.alias,
      capabilities: shareCreationCapabilities[account.provider],
      issue: this.localIssue(copy, account),
      latest: latest ? await this.receipt(latest) : null,
    };
  }
  private localIssue(copy: ResourceCopy, account: Account) {
    if (!account.enabled) return "原网盘账号已停用，请先启用。";
    if (!account.uid || copy.ownerUid !== account.uid)
      return "请先确认这份资源属于当前网盘账号，再创建分享。";
    if (!copy.files.length) return "尚未记录本人文件清单，请先核验资源。";
    if (!copy.verifiedAt) return "本人文件清单尚未完成核验，请先核验资源。";
    if (
      new Set(copy.files.map((file) => file.id)).size !== copy.files.length ||
      copy.files.some((file) => !file.id || ["0", "/"].includes(file.id))
    )
      return "本人文件清单存在重复或根目录项目，请先核对资源。";
    return null;
  }
  private async assertSameRequest(
    record: CreationRecord,
    input: ShareCreateInput,
  ) {
    const raw = await this.d.secrets.get(requestSecret(input.operationId));
    const original = raw
      ? (JSON.parse(raw) as { extractionCode: string })
      : null;
    if (
      record.receipt.copyId !== input.copyId ||
      record.expiresInDays !== input.expiresInDays ||
      original?.extractionCode !== (input.extractionCode?.trim() || "")
    )
      throw new AppError(
        "OPERATION_MISMATCH",
        "此创建请求已提交，不能修改参数后重复使用；请先查看原结果。",
      );
  }
  private async originalOptions(record: CreationRecord) {
    const raw = await this.d.secrets.get(
      requestSecret(record.receipt.operationId),
    );
    if (!raw)
      throw new AppError(
        "SHARE_CREATION_RECORD_INVALID",
        "原创建设置未能读取，请先在官网核对结果。",
      );
    const value = JSON.parse(raw) as {
      extractionCode: string;
      effectiveCode?: string;
    };
    return {
      expiresInDays: record.expiresInDays,
      extractionCode: value.effectiveCode || value.extractionCode || undefined,
    };
  }
  async recheck(operationId: string): Promise<ShareCreationReceipt> {
    const record = this.record(operationId);
    if (!record) throw new AppError("NOT_FOUND", "新分享创建记录不存在。");
    const currentReceipt = await this.receipt(record);
    if (currentReceipt.state !== "uncertain") return currentReceipt;
    record.receipt.state = "uncertain";
    if (!record.shareId) {
      record.receipt.message =
        "上次请求未返回可识别的分享结果，请在原账号官网核对。确认未创建后可记录这一事实；不会自动重发。";
      this.store(record);
      return this.receipt(record);
    }
    if (this.active.has(record.accountId) || this.d.hasRunningJobs())
      throw new AppError(
        "ACTIVE_JOBS",
        "仍有任务正在执行，请稍后核对新分享结果。",
      );
    this.d.assertIdle(record.accountId);
    this.active.add(record.accountId);
    try {
      return await this.d.authenticated(
        record.accountId,
        async (account, provider) => {
          if (
            account.uid !== record.ownerUid ||
            account.provider !== record.provider
          )
            throw new AppError(
              "ACCOUNT_UID_MISMATCH",
              "请登录原网盘账号后核对创建结果。",
            );
          const options = await this.originalOptions(record);
          let code =
            (await this.d.secrets.get(resultSecret(operationId))) ||
            options.extractionCode ||
            "";
          let valid = false;
          try {
            if (
              (!record.receipt.url || (record.codeRequired && !code)) &&
              provider.readCreatedShare
            ) {
              const recovered = await provider.readCreatedShare(
                account,
                record.shareId!,
                options,
                code,
              );
              if (
                !recovered ||
                recovered.id !== record.shareId ||
                recovered.ownerUid !== record.ownerUid
              )
                throw new AppError(
                  "SHARE_UNVERIFIED",
                  "未能按原分享ID确认返回结果。",
                );
              code = (await this.rememberReturned(record, recovered)) || code;
            }
            if (record.codeRequired && !code && record.receipt.url) {
              const recovered = await provider.recoverOwnShare(
                account,
                parseShare(record.receipt.url!),
                record.files,
              );
              if (
                recovered.id !== record.shareId ||
                recovered.ownerUid !== record.ownerUid ||
                !recovered.code
              )
                throw new AppError(
                  "SHARE_CODE_UNAVAILABLE",
                  "未能读取新分享提取码，请在官网核对。",
                );
              code = recovered.code;
            }
            if (!record.receipt.url || (record.codeRequired && !code))
              throw new AppError(
                "SHARE_CODE_UNAVAILABLE",
                "新分享链接或提取码未完整读取，请在官网核对。",
              );
            valid = provider.verifyShareWithOptions
              ? await provider.verifyShareWithOptions(
                  account,
                  record.shareId!,
                  record.files,
                  options,
                  code,
                )
              : record.settingsConfirmed &&
                (await provider.verifyShare(
                  account,
                  record.shareId!,
                  record.files,
                  code,
                ));
          } catch {
            // A read failure never releases the operation or triggers a new creation.
          }
          if (valid) {
            await this.d.secrets.set(resultSecret(operationId), code);
            record.settingsConfirmed = true;
            record.receipt.state = "success";
            record.receipt.message =
              "已只读核对新分享及创建设置，原资源记录未修改。";
          } else {
            record.receipt.message =
              "新分享或设置仍未核对成功，请在原账号官网查看；不会再次创建。";
          }
          this.store(record);
          return this.receipt(record);
        },
      );
    } finally {
      this.active.delete(record.accountId);
    }
  }
  async resolve(
    operationId: string,
    outcome: "not_created" | "handled",
  ): Promise<ShareCreationReceipt> {
    const record = this.record(operationId);
    if (!record) throw new AppError("NOT_FOUND", "新分享创建记录不存在。");
    if (this.active.has(record.accountId))
      throw new AppError(
        "ACTIVE_JOBS",
        "此账号仍在处理创建结果，请等待结束后核对。",
      );
    const currentReceipt = await this.receipt(record);
    if (currentReceipt.state !== "uncertain") return currentReceipt;
    // A known created link cannot truthfully be recorded as a missing submission.
    if (outcome === "not_created" && (record.shareId || record.receipt.url))
      throw new AppError(
        "SHARE_ALREADY_RETURNED",
        "网盘已返回分享链接，请核对现有结果，不能记录为未创建。",
      );
    record.receipt.state = "failed";
    record.receipt.resolution = outcome;
    record.receipt.message =
      outcome === "not_created"
        ? "已记录本人在官网核对未创建的结果，仅解除本地待核对意图，没有重发或修改资源。"
        : "已记录本人在网盘处理本次分享的结果，结束本地核对；没有重发、修改原资源或删除网盘分享。";
    this.store(record);
    return this.receipt(record);
  }
  async create(input: ShareCreateInput): Promise<ShareCreationReceipt> {
    const previous = this.record(input.operationId);
    if (previous) {
      await this.assertSameRequest(previous, input);
      return this.receipt(previous);
    }
    const copy = this.d.repo.getCopy(input.copyId);
    const account = this.d.repo.getAccount(copy.accountId);
    const issue = this.localIssue(copy, account);
    if (issue) throw new AppError("OWNERSHIP_UNVERIFIED", issue);
    const optionIssue = shareCreationOptionsError(account.provider, input);
    if (optionIssue)
      throw new AppError("SHARE_OPTIONS_UNSUPPORTED", optionIssue);
    const pending = this.latest(input.copyId);
    if (pending?.receipt.state === "uncertain")
      throw new AppError(
        "SHARE_CREATION_PENDING",
        "这份资源上次创建分享的结果仍待核对，请先查看原记录；不会再次创建。",
      );
    if (this.active.has(account.id) || this.d.hasRunningJobs())
      throw new AppError(
        "ACTIVE_JOBS",
        "仍有任务正在执行，请完成后再创建新分享。",
      );
    this.d.assertIdle(account.id);
    this.d.assertMutable(copy.resourceId);
    this.active.add(account.id);
    try {
      // This read supports directly recorded own resources with no saved folderId.
      const location = await this.d.driveFiles.locateCopy(copy.id);
      if (location.directory.pending)
        throw new AppError(
          "WRITE_PENDING",
          "资源目录仍有待核对的写入，请先处理原操作。",
        );
      return await this.d.authenticated(
        account.id,
        async (currentAccount, provider) => {
          this.d.assertIdle(account.id);
          this.d.assertMutable(copy.resourceId);
          const currentCopy = this.d.repo.getCopy(copy.id);
          if (
            currentAccount.uid !== account.uid ||
            currentCopy.accountId !== copy.accountId ||
            currentCopy.resourceId !== copy.resourceId ||
            currentCopy.ownerUid !== currentAccount.uid ||
            manifestKey(currentCopy.files) !== manifestKey(copy.files)
          )
            throw new AppError(
              "FILES_CHANGED",
              "资源身份或文件清单已变化，请重新打开创建窗口。",
            );
          if (!provider.createShareWithOptions)
            throw new AppError(
              "SHARE_OPTIONS_UNSUPPORTED",
              "此网盘暂不支持可配置的新分享创建。",
            );
          const actual = await provider.list(
            currentAccount,
            location.directory.folderId,
          );
          const files = copy.files.map((expected) =>
            actual.find((file) => matchesFile(expected, file)),
          );
          if (files.some((file) => !file))
            throw new AppError(
              "FILES_CHANGED",
              "原目录中的资源文件已变化，未创建新分享。",
            );
          const codeCapability =
            shareCreationCapabilities[account.provider].extractionCode;
          const effectiveCode =
            input.extractionCode?.trim() ||
            (codeCapability.mode === "custom"
              ? randomBytes(Math.ceil((codeCapability.length || 4) / 2))
                  .toString("hex")
                  .slice(0, codeCapability.length || 4)
              : undefined);
          const effectiveOptions = {
            expiresInDays: input.expiresInDays,
            extractionCode: effectiveCode,
          };
          const effectiveIssue = shareCreationOptionsError(
            account.provider,
            effectiveOptions,
          );
          if (effectiveIssue)
            throw new AppError("INVALID_SHARE_OPTIONS", effectiveIssue);
          // Confirm that encrypted persistence is available before any remote write.
          await this.d.secrets.set(
            requestSecret(input.operationId),
            JSON.stringify({
              extractionCode: input.extractionCode?.trim() || "",
              effectiveCode: effectiveCode || "",
            }),
          );
          const record: CreationRecord = {
            accountId: account.id,
            ownerUid: currentAccount.uid!,
            provider: account.provider,
            files: files as RemoteFile[],
            codeRequired:
              shareCreationCapabilities[account.provider].extractionCode
                .mode !== "none",
            settingsConfirmed: false,
            expiresInDays: input.expiresInDays,
            receipt: {
              operationId: input.operationId,
              copyId: copy.id,
              state: "uncertain",
              expiresInDays: input.expiresInDays,
              createdAt: now(),
              message: "新分享创建已提交，正在等待网盘结果；不会自动重复创建。",
            },
          };
          // The durable intent precedes the only call that can create a remote link.
          this.store(record, true);
          let returnedCode: string | undefined;
          const saveReturned = async (share: OwnShare) => {
            returnedCode =
              (await this.rememberReturned(record, share)) || returnedCode;
          };
          try {
            const share = await provider.createShareWithOptions(
              currentAccount,
              files as RemoteFile[],
              this.d.repo.getResource(copy.resourceId).title,
              effectiveOptions,
              saveReturned,
            );
            record.settingsConfirmed = true;
            await saveReturned(share);
            const parsed = parseShare(share.url, share.code);
            if (
              (record.codeRequired && !returnedCode) ||
              share.ownerUid !== currentAccount.uid ||
              (effectiveCode && effectiveCode !== parsed.code) ||
              !(await provider.verifyShare(
                currentAccount,
                share.id,
                files as RemoteFile[],
                parsed.code,
              ))
            )
              throw new AppError(
                "SHARE_UNVERIFIED",
                "新分享尚未通过本人归属或文件核验。",
              );
            record.receipt.state = "success";
            record.receipt.message =
              "新分享已创建，原资源的分享链接与版本保持不变。";
          } catch (error) {
            const rejected =
              !record.shareId &&
              !record.receipt.url &&
              definiteRejection(error);
            const failure = publicFailure(error, [
              input.extractionCode?.trim(),
              effectiveCode,
              returnedCode,
            ]);
            record.receipt.state = rejected ? "failed" : "uncertain";
            record.receipt.message = rejected
              ? `${failure} 网盘明确拒绝了本次创建，可处理后重新创建。`
              : record.receipt.url
                ? `${failure} 网盘已返回新分享，但结果或提取码保存尚未全部确认。请在原账号官网核对；不会重复创建。`
                : `${failure} 网盘创建结果尚未确认。请在原账号官网核对；不会重复创建或自动重试。`;
          }
          this.store(record);
          return {
            ...record.receipt,
            ...(returnedCode ? { code: returnedCode } : {}),
          };
        },
      );
    } finally {
      this.active.delete(account.id);
    }
  }
}

import {
  gcid,
  credentials,
  uploadOss,
  uploadS3,
  type UploadAsset,
} from "./small-upload";
import type {
  Account,
  RemoteFile,
  ShareInput,
  ShareInspection,
} from "../../shared/types";
import { AppError, ProviderHttpError, safeMessage } from "../errors";
import { providerSpecs } from "../../shared/providers";
import { providerRequestReferer } from "./request-context";
import { parseShare } from "../links";
import { normalizeShareStatistic } from "./share-statistics";
import { normalizeCapacity } from "./capacity";
import {
  normalizeRemoteFile,
  normalizedDirectory,
  type DriveProvider,
  type JsonObject,
  type OwnShare,
  type ProviderTransport,
  type ShareCreatedHandler,
} from "./provider";
import type { ShareCreationOptions } from "../../shared/share-options";
import {
  actualShareExpiry,
  newShareRequest,
  validateShareOptions,
} from "./share-options";

const root = (id: string) => (id === "0" ? "" : id);

/** Web-session adapter; no shared device IDs, client secrets or captcha bypass. */
export class TokenDriveProvider implements DriveProvider {
  constructor(
    private transport: ProviderTransport,
    readonly id: "xunlei" | "pikpak",
  ) {}
  private get name() {
    return providerSpecs[this.id].name;
  }
  private get api() {
    return `https://${providerSpecs[this.id].apiHosts[0]}/drive/v1/`;
  }

  private error(data: JsonObject): AppError | null {
    const code = Number(data.error_code ?? 0),
      name = String(data.error ?? ""),
      text = String(data.error_description ?? data.message ?? "");
    if (!code && (!name || name === "success")) return null;
    const detail = `${name} ${text}`;
    if (
      [401, 4121, 4122, 10, 16].includes(code) ||
      /unauthenticated|invalid_grant|token.*expired|登录失效/i.test(detail)
    )
      return new AppError(
        "AUTH_EXPIRED",
        `${this.name}登录已失效，请在原隔离窗口重新登录并核验。`,
      );
    if (/pass.?code|提取码|访问码/i.test(detail))
      return new AppError(
        "BAD_CODE",
        `${this.name}分享提取码不正确或尚未验证。`,
      );
    if (/quota|capacity|space.*(limit|full)|容量|空间不足/i.test(detail))
      return new AppError(
        "QUOTA_EXCEEDED",
        `${this.name}可用容量或本次转存配额不足，请在官网处理后恢复任务。`,
      );
    if (
      code === 9 ||
      /captcha|verify|review|risk|real.?name|实名|验证|频繁|风控|too_many/i.test(
        detail,
      )
    )
      return new AppError(
        "USER_ACTION_REQUIRED",
        `${this.name}要求人工验证或会话授权，请打开原隔离窗口处理后恢复任务。`,
      );
    if (/not_found|expired|deleted|取消分享/i.test(detail))
      return new AppError(
        "SHARE_EXPIRED",
        `${this.name}分享已失效、被删除或无法访问。`,
      );
    return new AppError(
      "REMOTE_ERROR",
      `${this.name}请求未成功（${Number.isFinite(code) ? code : "未知"}）。请在官方页面核对账号与分享状态。`,
    );
  }
  private async request(
    account: Account,
    path: string,
    query: Record<string, string | number> = {},
    body?: unknown,
    refreshed = false,
    method?: "PATCH",
  ): Promise<JsonObject> {
    const url = new URL(path.startsWith("https:") ? path : this.api + path);
    Object.entries(query).forEach(([key, value]) =>
      url.searchParams.set(key, String(value)),
    );
    const headers = await this.transport.authHeaders?.(account.id, refreshed);
    if (!headers?.authorization)
      throw new AppError(
        "AUTH_EXPIRED",
        `请先在该${this.name}账号的隔离窗口完成官方登录。`,
      );
    try {
      const data = await this.transport.json(account.id, url.href, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          ...headers,
          "Content-Type": "application/json",
          Referer: providerRequestReferer(this.id, url),
          Origin: new URL(providerSpecs[this.id].home).origin,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const error = this.error(data);
      if (error) throw error;
      return data;
    } catch (error) {
      const mapped =
        error instanceof ProviderHttpError
          ? this.error({
              error_code: Number(error.remoteCode) || error.status,
              error: "http_error",
              error_description: error.message,
            })
          : error;
      if (
        error instanceof ProviderHttpError &&
        mapped instanceof AppError &&
        !["AUTH_EXPIRED", "USER_ACTION_REQUIRED", "QUOTA_EXCEEDED"].includes(
          mapped.code,
        )
      )
        mapped.uncertain =
          error.uncertain || (body !== undefined && error.status >= 500);
      // Only repeat read requests after an explicit authentication rejection.
      // An uncertain write is always left to the queue's ownership recovery.
      if (
        body === undefined &&
        !refreshed &&
        mapped instanceof AppError &&
        mapped.code === "AUTH_EXPIRED"
      )
        return this.request(account, path, query, undefined, true);
      if (
        error instanceof ProviderHttpError &&
        [403, 429].includes(error.status)
      )
        throw new AppError(
          "USER_ACTION_REQUIRED",
          `${this.name}要求人工验证或限频等待，请在隔离窗口核对后重试。`,
        );
      throw mapped ?? error;
    }
  }
  async identity(account: Account) {
    const data = await this.request(
      account,
      `https://${providerSpecs[this.id].apiHosts[1]}/v1/user/me`,
    );
    const uid = data.sub ?? data.user_id ?? data.id;
    if (
      (typeof uid !== "string" && typeof uid !== "number") ||
      !String(uid ?? "") ||
      (typeof uid === "number" && !Number.isSafeInteger(uid))
    )
      throw new AppError(
        "UID_UNAVAILABLE",
        `${this.name}账号接口未返回稳定UID，未允许转存或分享。`,
      );
    return {
      uid: String(uid),
      nickname: String(data.name ?? data.nickname ?? ""),
    };
  }
  async capacity(account: Account) {
    const result = await this.request(account, "about");
    return normalizeCapacity(result.quota?.limit, result.quota?.usage);
  }
  private rows(data: JsonObject, parentId: string): RemoteFile[] {
    if (!Array.isArray(data.files))
      throw new AppError(
        "REMOTE_SCHEMA_CHANGED",
        `${this.name}未返回完整文件列表，未继续操作。`,
      );
    const rows = data.files.map((row: JsonObject) => {
      if (
        typeof row.id !== "string" ||
        !row.id ||
        typeof row.name !== "string" ||
        !row.name ||
        !["drive#file", "drive#folder"].includes(row.kind) ||
        (row.size != null &&
          (!Number.isSafeInteger(Number(row.size)) || Number(row.size) < 0))
      )
        throw new AppError(
          "REMOTE_SCHEMA_CHANGED",
          `${this.name}文件类型或大小字段发生变化。`,
        );
      return normalizeRemoteFile(row, this.id, parentId);
    });
    if (new Set(rows.map((f) => f.id)).size !== rows.length)
      throw new AppError(
        "INCOMPLETE_LIST",
        `${this.name}目录返回重复文件，未继续操作。`,
      );
    return rows;
  }
  private async shared(
    account: Account,
    source: ShareInput,
    parentId: string,
    cursor = "",
  ) {
    if (source.provider !== this.id)
      throw new AppError(
        "CROSS_PROVIDER_UNSUPPORTED",
        `${this.name}账号只能转存${this.name}分享。`,
      );
    const initial = await this.request(account, "share", {
      share_id: source.shareKey,
      pass_code: source.code,
      limit: 100,
      page_token: parentId === "0" ? cursor : "",
      thumbnail_size: "SIZE_SMALL",
    });
    if (initial.share_status !== "OK")
      throw new AppError(
        initial.share_status === "PASS_CODE_ERROR" ||
          initial.share_status === "NEED_PASS_CODE"
          ? "BAD_CODE"
          : "SHARE_EXPIRED",
        `${this.name}分享不可用、提取码未通过或仍在审核。`,
      );
    const token = initial.pass_code_token;
    if (typeof token !== "string" || !token)
      throw new AppError(
        "REMOTE_SCHEMA_CHANGED",
        `${this.name}未返回分享访问令牌，未继续操作。`,
      );
    const data =
      parentId === "0"
        ? initial
        : await this.request(account, "share/detail", {
            share_id: source.shareKey,
            parent_id: parentId,
            pass_code_token: token,
            page_token: cursor,
            limit: 100,
            thumbnail_size: "SIZE_SMALL",
          });
    if (data.share_status && data.share_status !== "OK")
      throw new AppError("SHARE_EXPIRED", `${this.name}子目录分享不可用。`);
    return {
      files: this.rows(data, parentId),
      token,
      next: this.cursor(data),
      title: String(initial.title ?? initial.files?.[0]?.name ?? ""),
    };
  }
  private cursor(data: JsonObject): string {
    if (data.next_page_token == null) return "";
    if (
      typeof data.next_page_token !== "string" ||
      data.next_page_token.length > 8000
    )
      throw new AppError(
        "REMOTE_SCHEMA_CHANGED",
        `${this.name}分页标记格式变化。`,
      );
    return data.next_page_token;
  }
  async inspect(
    account: Account,
    source: ShareInput,
    parentId = "0",
    page = 1,
    cursor?: string,
  ): Promise<ShareInspection> {
    if (page > 1 && !cursor)
      throw new AppError(
        "CURSOR_REQUIRED",
        `${this.name}下一页需要本次分享返回的分页标记，请重新读取目录。`,
      );
    const data = await this.shared(account, source, parentId, cursor);
    return {
      shareKey: source.shareKey,
      files: data.files,
      title: data.title,
      hasMore: !!data.next,
      page,
      parentId,
      nextCursor: data.next || undefined,
    };
  }
  async list(account: Account, parentId: string) {
    const files: RemoteFile[] = [],
      seen = new Set<string>(),
      cursors = new Set<string>();
    let cursor = "";
    for (let page = 0; page < 200; page++) {
      const data = await this.request(account, "files", {
        parent_id: root(parentId),
        page_token: cursor,
        limit: 100,
        space: "",
        filters: JSON.stringify({
          trashed: { eq: false },
          phase: { eq: "PHASE_TYPE_COMPLETE" },
        }),
      });
      for (const file of this.rows(data, parentId)) {
        if (seen.has(file.id))
          throw new AppError(
            "INCOMPLETE_LIST",
            `${this.name}分页出现重复文件，未继续操作。`,
          );
        seen.add(file.id);
        files.push(file);
      }
      cursor = this.cursor(data);
      if (!cursor) return files;
      if (cursors.has(cursor))
        throw new AppError(
          "INCOMPLETE_LIST",
          `${this.name}分页标记重复，请重新读取目录。`,
        );
      cursors.add(cursor);
    }
    throw new AppError(
      "TOO_MANY_FILES",
      `${this.name}目录超过读取上限，请缩小范围。`,
    );
  }
  async upload(account: Account, parentId: string, asset: UploadAsset) {
    const result = await this.request(
      account,
      "files",
      {},
      {
        kind: "drive#file",
        name: asset.name,
        parent_id: root(parentId),
        size: asset.bytes.length,
        hash: gcid(asset.bytes),
        upload_type: "UPLOAD_TYPE_RESUMABLE",
        ...(this.id === "pikpak"
          ? {
              objProvider: { provider: "UPLOAD_TYPE_UNKNOWN" },
              folder_type: "NORMAL",
            }
          : { space: "" }),
      },
    );
    if (result.resumable?.params) {
      const params = credentials(result.resumable.params);
      if (this.id === "pikpak") await uploadOss(this.id, params, asset);
      else await uploadS3(this.id, params, asset);
    } else if (!result.file?.id) {
      throw new AppError(
        "UNCERTAIN_REMOTE_RESULT",
        "上传未返回文件或存储任务，请核对目录。",
        true,
      );
    }
  }
  async manageFile(
    account: Account,
    input: import("../../shared/drive-files").ProviderFileMutation,
  ) {
    if (input.action === "mkdir") {
      await this.request(
        account,
        "files",
        {},
        {
          kind: "drive#folder",
          name: input.name,
          parent_id: root(input.parentId),
          space: "",
        },
      );
    } else if (input.action === "rename") {
      await this.request(
        account,
        `files/${encodeURIComponent(input.file!.id)}`,
        {},
        { name: input.name, ...(this.id === "xunlei" ? { space: "" } : {}) },
        false,
        "PATCH",
      );
    } else if (this.id === "xunlei") {
      await this.request(
        account,
        `files/${encodeURIComponent(input.file!.id)}/trash`,
        { space: "" },
        {},
        false,
        "PATCH",
      );
    } else {
      await this.request(
        account,
        "files:batchTrash",
        {},
        { ids: [input.file!.id] },
      );
    }
  }
  async ensureFolder(account: Account, path: string) {
    let parent = "0";
    for (const name of normalizedDirectory(path).split("/").filter(Boolean)) {
      const matches = (await this.list(account, parent)).filter(
        (f) => f.isDirectory && f.name === name,
      );
      if (matches.length > 1)
        throw new AppError(
          "AMBIGUOUS_FOLDER",
          `${this.name}发现多个同名目录，请先在官网整理。`,
        );
      if (matches[0]) {
        parent = matches[0].id;
        continue;
      }
      const data = await this.request(
        account,
        "files",
        {},
        { kind: "drive#folder", name, parent_id: root(parent), space: "" },
      );
      const reportedId = data.id ?? data.file?.id;
      try {
        const confirmed = (await this.list(account, parent)).filter(
          (f) => f.isDirectory && f.name === name,
        );
        if (
          confirmed.length !== 1 ||
          (reportedId != null && String(reportedId) !== confirmed[0].id)
        )
          throw new AppError(
            "UNCERTAIN_REMOTE_RESULT",
            `${this.name}创建目录结果待核，请先核对目标目录。`,
            true,
          );
        parent = confirmed[0].id;
      } catch (error) {
        throw new AppError(
          "UNCERTAIN_REMOTE_RESULT",
          `${this.name}目录已提交创建，后续核验未通过：${safeMessage(error)}`,
          true,
        );
      }
    }
    return parent;
  }
  async transfer(
    account: Account,
    source: ShareInput,
    selected: RemoteFile[],
    folderId: string,
  ) {
    if (
      !selected.length ||
      selected.length > 100 ||
      new Set(selected.map((f) => f.parentId)).size !== 1 ||
      new Set(selected.map((f) => f.id)).size !== selected.length
    )
      throw new AppError(
        "FILE_SELECTION_LIMIT",
        "单次请选择同一目录内的1–100个文件或文件夹。",
      );
    const parent = selected[0].parentId,
      found = new Map<string, RemoteFile>(),
      cursors = new Set<string>();
    let cursor = "",
      token = "";
    for (let page = 0; page < 100; page++) {
      const data = await this.shared(account, source, parent, cursor);
      token = data.token;
      data.files.forEach((f) => found.set(f.id, f));
      if (selected.every((f) => found.has(f.id)) || !data.next) break;
      if (cursors.has(data.next))
        throw new AppError(
          "INCOMPLETE_LIST",
          `${this.name}分享分页异常，未提交转存。`,
        );
      cursors.add(data.next);
      cursor = data.next;
    }
    if (
      !selected.every((f) => {
        const actual = found.get(f.id);
        return (
          actual &&
          actual.name === f.name &&
          actual.isDirectory === f.isDirectory &&
          (f.isDirectory || f.size == null || f.size === actual.size)
        );
      })
    )
      throw new AppError(
        "SOURCE_CHANGED",
        `${this.name}已选文件发生变化，请重新读取分享。`,
      );
    const data = await this.request(
      account,
      "share/restore",
      {},
      {
        parent_id: folderId,
        share_id: source.shareKey,
        pass_code_token: token,
        ancestor_ids: parent === "0" ? [] : [parent],
        specify_parent_id: true,
        file_ids: selected.map((f) => f.id),
      },
    );
    if (!data.restore_task_id)
      throw new AppError(
        "UNCERTAIN_REMOTE_RESULT",
        `${this.name}未返回转存任务ID，请核对目标文件，不要重复转存。`,
        true,
      );
    return { taskId: String(data.restore_task_id) };
  }
  async poll(account: Account, taskId: string) {
    const data = await this.request(
      account,
      `tasks/${encodeURIComponent(taskId)}`,
    );
    if (data.phase === "PHASE_TYPE_ERROR" || data.phase === "PHASE_TYPE_FAILED")
      throw new AppError(
        "REMOTE_TASK_FAILED",
        `${this.name}远端任务失败，请核对目标文件。`,
        true,
      );
    return (
      Number(data.progress) === 100 &&
      (!data.phase || data.phase === "PHASE_TYPE_COMPLETE")
    );
  }
  async shareStatistics(account: Account, _page: number, cursor = "") {
    const result = await this.request(account, "share/list", {
      space: "",
      limit: 100,
      page_token: cursor,
    });
    if (!Array.isArray(result.data))
      throw new AppError(
        "REMOTE_SCHEMA_CHANGED",
        `${this.name}本人分享统计列表结构已变化。`,
      );
    const nextCursor = this.cursor(result);
    return {
      items: result.data.map((row: JsonObject) =>
        normalizeShareStatistic(row, this.id),
      ),
      hasMore: !!nextCursor,
      nextCursor,
      total: null,
    };
  }
  private async ownRows(account: Account) {
    const rows: JsonObject[] = [],
      seen = new Set<string>();
    let cursor = "";
    for (let page = 0; page < 50; page++) {
      const data = await this.request(account, "share/list", {
        space: "",
        limit: 100,
        page_token: cursor,
      });
      if (!Array.isArray(data.data))
        throw new AppError(
          "REMOTE_SCHEMA_CHANGED",
          `${this.name}本人分享记录结构变化，未允许分发。`,
        );
      rows.push(...data.data);
      cursor = this.cursor(data);
      if (!cursor) return rows;
      if (seen.has(cursor))
        throw new AppError(
          "INCOMPLETE_LIST",
          `${this.name}本人分享记录分页异常。`,
        );
      seen.add(cursor);
    }
    throw new AppError(
      "TOO_MANY_SHARES",
      `${this.name}分享记录超过读取上限，请在官网核对后恢复本人链接。`,
    );
  }
  private shareInfo(row: JsonObject, uid: string, code = ""): OwnShare {
    const parsed = parseShare(
      String(row.share_url ?? ""),
      code || String(row.pass_code ?? ""),
    );
    if (parsed.provider !== this.id || !row.share_id)
      throw new AppError(
        "INVALID_OWN_SHARE",
        `${this.name}本人分享记录缺少有效链接或ID。`,
      );
    return {
      id: String(row.share_id),
      url: parsed.url,
      code: parsed.code,
      ownerUid: uid,
    };
  }
  private async verified(
    account: Account,
    row: JsonObject,
    files: RemoteFile[],
    uid: string,
    code = "",
  ) {
    if (
      row.share_status !== "OK" ||
      (row.user_id != null && String(row.user_id) !== uid) ||
      (row.file_num != null && Number(row.file_num) !== files.length)
    )
      return false;
    if (
      Array.isArray(row.file_ids) &&
      (row.file_ids.length !== files.length ||
        !files.every((f) => row.file_ids.map(String).includes(f.id)))
    )
      return false;
    const share = await this.knownShare(account, row, uid, code),
      source = parseShare(share.url, share.code),
      actual: RemoteFile[] = [];
    let cursor = "";
    for (let page = 0; page < 3; page++) {
      let data;
      try {
        data = await this.shared(account, source, "0", cursor);
      } catch (e) {
        if (e instanceof AppError && e.code === "SHARE_EXPIRED") return false;
        throw e;
      }
      actual.push(...data.files);
      if (!data.next)
        return (
          actual.length === files.length &&
          new Set(actual.map((f) => f.id)).size === actual.length &&
          files.every((f) =>
            actual.some(
              (a) =>
                a.id === f.id &&
                a.name === f.name &&
                a.isDirectory === f.isDirectory &&
                (f.isDirectory || f.size == null || a.size === f.size),
            ),
          )
        );
      if (data.next === cursor) return false;
      cursor = data.next;
    }
    return false;
  }
  async createShare(account: Account, files: RemoteFile[], title: string) {
    return this.createNewShare(account, files, title);
  }
  async createShareWithOptions(
    account: Account,
    files: RemoteFile[],
    title: string,
    options: ShareCreationOptions,
    onCreated?: ShareCreatedHandler,
  ) {
    return this.createNewShare(
      account,
      files,
      title,
      validateShareOptions(this.id, options),
      onCreated,
    );
  }
  private async createNewShare(
    account: Account,
    files: RemoteFile[],
    title: string,
    options?: ShareCreationOptions,
    onCreated?: ShareCreatedHandler,
  ): Promise<OwnShare> {
    const identity = await this.identity(account);
    if (account.uid && account.uid !== identity.uid)
      throw new AppError(
        "ACCOUNT_UID_MISMATCH",
        `${this.name}当前账号UID与原绑定不一致，未创建分享。`,
      );
    const submit = () =>
      this.request(
        account,
        "share",
        {},
        {
          file_ids: files.map((f) => f.id),
          share_to: this.id === "pikpak" ? "publiclink" : "copy",
          title,
          expiration_days: String(options?.expiresInDays || -1),
          ...(this.id === "pikpak"
            ? { pass_code_option: "NOT_REQUIRED" }
            : {
                restore_limit: "-1",
                params: { subscribe_push: "false", WithPassCodeInLink: "true" },
              }),
        },
      );
    const data = options ? await newShareRequest(submit) : await submit();
    try {
      if (onCreated && data.share_id && !data.share_url)
        await onCreated({
          id: String(data.share_id),
          url: "",
          code: String(data.pass_code ?? ""),
          ownerUid: identity.uid,
        });
      if (!data.share_id || !data.share_url)
        throw new AppError(
          "UNCERTAIN_SHARE_RESULT",
          `${this.name}分享结果待核，请核对本人分享记录，避免重复创建。`,
          true,
        );
      const share = this.shareInfo(data, identity.uid);
      await onCreated?.(share);
      const row = (await this.ownRows(account)).find(
        (r) => String(r.share_id) === share.id,
      );
      if (
        !row ||
        (options && !this.shareSettingsMatch({ ...row, ...data }, options)) ||
        !(await this.verified(
          account,
          { ...row, share_url: share.url },
          files,
          identity.uid,
          share.code,
        ))
      )
        throw new AppError(
          "OWNERSHIP_UNVERIFIED",
          `${this.name}新分享未通过本人记录及目标文件核验，暂不允许分发。`,
          true,
        );
      const expiresAt = options
        ? actualShareExpiry(
            data.expiration_at ??
              data.expiration_time ??
              row.expiration_at ??
              row.expiration_time,
          )
        : undefined;
      return { ...share, ...(expiresAt ? { expiresAt } : {}) };
    } catch (error) {
      throw new AppError(
        error instanceof AppError ? error.code : "UNCERTAIN_SHARE_RESULT",
        safeMessage(error),
        true,
      );
    }
  }
  private shareSettingsMatch(row: JsonObject, options: ShareCreationOptions) {
    const days = row.expiration_days;
    if (
      days != null &&
      days !== "" &&
      Number(days) !== (options.expiresInDays || -1)
    )
      return false;
    if (
      this.id === "pikpak" &&
      row.pass_code_option != null &&
      row.pass_code_option !== "NOT_REQUIRED"
    )
      return false;
    const expiry = actualShareExpiry(row.expiration_at ?? row.expiration_time);
    const created = actualShareExpiry(row.create_time ?? row.created_at);
    if (expiry && Date.parse(expiry) <= Date.now()) return false;
    if (
      expiry &&
      options.expiresInDays > 0 &&
      created &&
      Math.abs(
        Date.parse(expiry) -
          Date.parse(created) -
          options.expiresInDays * 86_400_000,
      ) > 86_400_000
    )
      return false;
    return true;
  }
  async verifyShareWithOptions(
    account: Account,
    shareId: string,
    files: RemoteFile[],
    options: ShareCreationOptions,
    code = "",
  ) {
    validateShareOptions(this.id, options);
    const identity = await this.identity(account);
    if (account.uid && identity.uid !== account.uid) return false;
    const row = (await this.ownRows(account)).find(
      (item) => String(item.share_id) === shareId,
    );
    return (
      !!row &&
      this.shareSettingsMatch(row, options) &&
      this.verified(account, row, files, identity.uid, code)
    );
  }
  async readCreatedShare(
    account: Account,
    shareId: string,
    options: ShareCreationOptions,
    code = "",
  ) {
    validateShareOptions(this.id, options);
    const identity = await this.identity(account);
    if (account.uid && identity.uid !== account.uid) return null;
    const row = (await this.ownRows(account)).find(
      (item) => String(item.share_id) === shareId,
    );
    if (!row || !this.shareSettingsMatch(row, options)) return null;
    const share = await this.knownShare(account, row, identity.uid, code);
    const expiresAt = actualShareExpiry(
      row.expiration_at ?? row.expiration_time,
    );
    return { ...share, ...(expiresAt ? { expiresAt } : {}) };
  }
  async findOwnShare(account: Account, files: RemoteFile[]) {
    const identity = await this.identity(account);
    for (const row of (await this.ownRows(account))
      .filter(
        (r) =>
          r.share_status === "OK" &&
          (r.file_num == null || Number(r.file_num) === files.length),
      )
      .slice(0, 30)) {
      try {
        if (await this.verified(account, row, files, identity.uid))
          return this.knownShare(account, row, identity.uid);
      } catch (e) {
        if (e instanceof AppError && e.code === "BAD_CODE")
          throw new AppError(
            "RECOVER_SHARE_MANUALLY",
            `${this.name}已有分享需要提取码，请到官方网盘核对并补全提取码，避免重复创建。`,
          );
        throw e;
      }
    }
    return null;
  }
  private async knownShare(
    account: Account,
    row: JsonObject,
    uid: string,
    code = "",
  ) {
    const knownCode =
      code ||
      String(row.pass_code ?? "") ||
      (await this.transport.ownShareCode?.(account.id, String(row.share_id))) ||
      "";
    return this.shareInfo(row, uid, knownCode);
  }
  async verifyShare(
    account: Account,
    shareId: string,
    files: RemoteFile[],
    code = "",
  ) {
    const identity = await this.identity(account);
    if (account.uid && identity.uid !== account.uid) return false;
    const row = (await this.ownRows(account)).find(
      (r) => String(r.share_id) === shareId,
    );
    return !!row && this.verified(account, row, files, identity.uid, code);
  }
  async recoverOwnShare(
    account: Account,
    source: ShareInput,
    files: RemoteFile[],
  ) {
    const identity = await this.identity(account);
    if (account.uid && account.uid !== identity.uid)
      throw new AppError(
        "ACCOUNT_UID_MISMATCH",
        `${this.name}登录账号已切换，请恢复原本人账号。`,
      );
    for (const row of await this.ownRows(account)) {
      if (
        row.share_url &&
        this.shareInfo(row, identity.uid).url === source.url &&
        (await this.verified(account, row, files, identity.uid, source.code))
      )
        return this.shareInfo(row, identity.uid, source.code);
    }
    throw new AppError(
      "OWNERSHIP_UNVERIFIED",
      `未在当前${this.name}账号的对应文件分享记录中确认此链接。`,
    );
  }
}

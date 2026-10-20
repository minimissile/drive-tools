import {
  digest,
  credentials,
  uploadOss,
  type UploadAsset,
} from "./small-upload";
import type {
  Account,
  RemoteFile,
  ShareInput,
  ShareInspection,
} from "../../shared/types";
import { AppError, ProviderHttpError, safeMessage } from "../errors";
import { parseShare } from "../links";
import { normalizeCapacity } from "./capacity";
import {
  normalizedDirectory,
  type DriveProvider,
  type JsonObject,
  type ProviderTransport,
  type OwnShare,
} from "./provider";

const api = "https://api.guangyapan.com";
const root = (id: string) => (id === "0" ? "" : id);
function stringId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value))
    throw new AppError(
      "REMOTE_SCHEMA_CHANGED",
      "光鸭未返回有效字符串 ID，未继续操作。",
    );
  return value;
}
/** First-party web compatibility protocol. OpenAPI v1.3 has no share/restore contract. */
export class GuangyaProvider implements DriveProvider {
  readonly id = "guangya" as const;
  constructor(private transport: ProviderTransport) {}
  private async request(
    account: Account,
    path: string,
    body: JsonObject = {},
    write = false,
    refreshed = false,
    acceptedCodes: number[] = [],
  ): Promise<JsonObject> {
    const headers = await this.transport.authHeaders?.(account.id, refreshed);
    if (!headers?.authorization)
      throw new AppError("AUTH_EXPIRED", "请先在光鸭隔离窗口登录本人账号。");
    // Account API and drive API use different CORS contracts on the official web client.
    // The account endpoint does not allow drive-only did/dt/smid headers.
    const accountRequest = path.startsWith("https:");
    const requestHeaders = accountRequest
      ? Object.fromEntries(
          Object.entries(headers).filter(([name]) =>
            [
              "authorization",
              "x-device-id",
              "x-client-id",
              "x-captcha-token",
              "user-agent",
            ].includes(name.toLowerCase()),
          ),
        )
      : {
          ...Object.fromEntries(
            Object.entries(headers).filter(([name]) =>
              ["authorization", "user-agent", "did", "dt", "smid"].includes(
                name.toLowerCase(),
              ),
            ),
          ),
          dt: "4",
        };
    try {
      const result = await this.transport.json(
        account.id,
        path.startsWith("https:") ? path : api + path,
        {
          method: path.startsWith("https:") ? "GET" : "POST",
          credentials: accountRequest ? "include" : "omit",
          headers: {
            ...requestHeaders,
            "Content-Type": "application/json",
            Origin: "https://www.guangyapan.com",
            Referer: "https://www.guangyapan.com/",
          },
          ...(path.startsWith("https:") ? {} : { body: JSON.stringify(body) }),
        },
      );
      if (path.startsWith("https:") && result.sub) return result;
      if (result.code !== 0 && !acceptedCodes.includes(Number(result.code))) {
        const code = Number(result.code ?? result.error_code),
          message = [result.msg, result.error_description, result.error]
            .filter((value) => typeof value === "string")
            .join(" ");
        if (
          [10, 16, 117, 401, 4121, 4122].includes(code) ||
          /unauthenticated|invalid_grant|token.*expired|未登录|登录失效/i.test(
            message,
          )
        )
          throw new AppError("AUTH_EXPIRED", "光鸭会话失效，请重新登录核验。");
        if (code === 209) throw new AppError("BAD_CODE", "光鸭提取码不正确。");
        if ([200, 201, 202].includes(code) && path.includes("share"))
          throw new AppError("SHARE_EXPIRED", "光鸭分享已失效或受限。");
        if ([157, 212].includes(code))
          throw new AppError("QUOTA_EXCEEDED", "光鸭空间或转存文件配额不足。");
        if (/captcha|verify|risk|实名|验证|频繁|风控/i.test(message))
          throw new AppError(
            "USER_ACTION_REQUIRED",
            "请在光鸭官方窗口完成人工验证后重试。",
          );
        throw new AppError(
          "REMOTE_ERROR",
          `光鸭请求未成功（${Number.isFinite(code) ? code : "结构变化"}），请核对官方页面。`,
          write,
        );
      }
      if (
        !result.data ||
        typeof result.data !== "object" ||
        Array.isArray(result.data)
      )
        throw new AppError(
          "REMOTE_SCHEMA_CHANGED",
          "光鸭响应结构变化，未确认操作成功。",
          write,
        );
      return result.data;
    } catch (e) {
      if (
        !write &&
        !refreshed &&
        e instanceof AppError &&
        e.code === "AUTH_EXPIRED"
      )
        return this.request(account, path, body, false, true);
      if (e instanceof ProviderHttpError && [403, 429].includes(e.status))
        throw new AppError(
          "USER_ACTION_REQUIRED",
          "光鸭要求官方窗口验证或限频等待。",
          write && e.uncertain,
        );
      if (e instanceof AppError && !write) e.uncertain = false; // These POSTs only read data.
      throw e;
    }
  }
  async identity(account: Account) {
    const data = await this.request(
      account,
      "https://account.guangyapan.com/v1/user/me",
    );
    return { uid: stringId(data.sub), nickname: String(data.name ?? "") };
  }
  async capacity(account: Account) {
    const data = await this.request(account, "/assets/v1/get_assets");
    return normalizeCapacity(data.totalSpaceSize, data.usedSpaceSize);
  }
  private rows(data: JsonObject, parentId: string): RemoteFile[] {
    if (!Array.isArray(data.list))
      throw new AppError(
        "REMOTE_SCHEMA_CHANGED",
        "光鸭目录结构变化，未继续操作。",
      );
    const rows = data.list.map((row: JsonObject): RemoteFile => {
      if (
        typeof row.fileName !== "string" ||
        !row.fileName ||
        ![1, 2].includes(row.resType) ||
        (row.fileSize != null &&
          (!/^\d+$/.test(String(row.fileSize)) ||
            !Number.isSafeInteger(Number(row.fileSize))))
      )
        throw new AppError(
          "REMOTE_SCHEMA_CHANGED",
          "光鸭文件信息不完整或超出精度范围。",
        );
      return {
        id: stringId(row.fileId),
        name: row.fileName,
        isDirectory: row.resType === 2,
        size: row.fileSize == null ? null : Number(row.fileSize),
        parentId,
      };
    });
    if (new Set(rows.map((f) => f.id)).size !== rows.length)
      throw new AppError("INCOMPLETE_LIST", "光鸭目录出现重复文件。");
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
        "光鸭账号只能保存光鸭分享。",
      );
    const summary = await this.request(
      account,
      "/userres/v1/get_share_summary",
      { shareId: source.shareKey },
    );
    if (summary.shareStatus != null && summary.shareStatus !== 1)
      throw new AppError("SHARE_EXPIRED", "光鸭分享已过期、审核中或受限。");
    const access = await this.request(
      account,
      "/userres/v1/get_share_access_token",
      {
        shareId: source.shareKey,
        ...(source.code ? { code: source.code } : {}),
      },
    );
    if (typeof access.accessToken !== "string" || !access.accessToken)
      throw new AppError("REMOTE_SCHEMA_CHANGED", "光鸭未返回分享访问令牌。");
    const data = await this.request(
      account,
      "/userres/v1/get_share_page_files_list",
      {
        accessToken: access.accessToken,
        parentId: root(parentId),
        cursor,
        pageSize: 100,
        orderBy: 0,
        sortType: 0,
      },
    );
    const files = this.rows(data, parentId);
    if (
      (data.hasMore != null && typeof data.hasMore !== "boolean") ||
      (data.hasMore &&
        (typeof data.cursor !== "string" ||
          !data.cursor ||
          data.cursor === cursor)) ||
      (data.hasMore == null && files.length === 100)
    )
      throw new AppError("INCOMPLETE_LIST", "光鸭分享分页信息不完整。");
    return {
      files,
      token: access.accessToken as string,
      summary,
      next: data.hasMore ? (data.cursor as string) : "",
    };
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
        "请重新读取光鸭目录以获取分页标记。",
      );
    const data = await this.shared(account, source, parentId, cursor);
    return {
      shareKey: source.shareKey,
      title: String(data.summary.title ?? ""),
      files: data.files,
      page,
      parentId,
      hasMore: !!data.next,
      nextCursor: data.next || undefined,
    };
  }
  async list(account: Account, parentId: string) {
    const files: RemoteFile[] = [],
      seen = new Set<string>();
    for (let page = 0; page < 200; page++) {
      const data = await this.request(
        account,
        "/userres/v1/file/get_file_list",
        {
          parentId: root(parentId),
          page,
          pageSize: 100,
          orderBy: 0,
          sortType: 0,
        },
      );
      const rows = this.rows(data, parentId);
      for (const f of rows) {
        if (seen.has(f.id))
          throw new AppError("INCOMPLETE_LIST", "光鸭文件分页重复。");
        seen.add(f.id);
        files.push(f);
      }
      if (!rows.length) return files;
    }
    throw new AppError("INCOMPLETE_LIST", "光鸭文件列表超过安全读取上限。");
  }
  async upload(account: Account, parentId: string, asset: UploadAsset) {
    const result = await this.request(
      account,
      "/userres/v2/get_res_center_token",
      {
        capacity: 2,
        name: asset.name,
        parentId: root(parentId),
        res: { fileSize: asset.bytes.length, md5: digest("md5", asset.bytes) },
      },
      true,
      false,
      [156],
    );
    if (!result.taskId)
      throw new AppError(
        "UNCERTAIN_REMOTE_RESULT",
        "光鸭未返回上传任务。",
        true,
      );
    if (result.endPoint || result.fullEndPoint)
      await uploadOss(this.id, credentials(result), asset);
    // Task completion is observed by the insertion service's bounded directory checks.
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
          "光鸭存在多个同名目录，请在官网整理。",
        );
      if (matches[0]) {
        parent = matches[0].id;
        continue;
      }
      const created = await this.request(
        account,
        "/userres/v1/file/create_dir",
        { parentId: root(parent), dirName: name, failIfNameExist: true },
        true,
      );
      try {
        const rows = (await this.list(account, parent)).filter(
          (f) => f.isDirectory && f.name === name,
        );
        if (
          rows.length !== 1 ||
          (created.fileId && created.fileId !== rows[0].id)
        )
          throw new Error("目标目录未唯一确认");
        parent = rows[0].id;
      } catch (e) {
        throw new AppError(
          "UNCERTAIN_REMOTE_RESULT",
          `光鸭目录已提交创建，后续核验未通过：${safeMessage(e)}`,
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
        "请选择同一目录内的 1–100 个不同文件或文件夹。",
      );
    const found: RemoteFile[] = [],
      seen = new Set<string>();
    let cursor = "",
      token = "";
    for (let page = 0; page < 200; page++) {
      const result = await this.shared(
        account,
        source,
        selected[0].parentId,
        cursor,
      );
      token = result.token;
      for (const f of result.files) {
        if (seen.has(f.id))
          throw new AppError(
            "INCOMPLETE_LIST",
            "光鸭分享分页重复，未提交转存。",
          );
        seen.add(f.id);
        found.push(f);
      }
      if (selected.every((f) => seen.has(f.id)) || !result.next) break;
      cursor = result.next;
    }
    if (
      !selected.every((f) =>
        found.some(
          (a) =>
            a.id === f.id &&
            a.name === f.name &&
            a.isDirectory === f.isDirectory &&
            (f.isDirectory || f.size == null || f.size === a.size),
        ),
      )
    )
      throw new AppError(
        "SOURCE_CHANGED",
        "光鸭已选文件发生变化，请重新读取分享。",
      );
    const result = await this.request(
      account,
      "/userres/v1/restore_share",
      {
        accessToken: token,
        fileIds: selected.map((f) => f.id),
        parentId: root(folderId),
      },
      true,
    );
    if (typeof result.taskId !== "string" || !result.taskId)
      throw new AppError(
        "UNCERTAIN_REMOTE_RESULT",
        "光鸭未返回转存任务 ID，请核对目标目录，勿重复提交。",
        true,
      );
    return { taskId: result.taskId };
  }
  async poll(account: Account, taskId: string) {
    const result = await this.request(account, "/userres/v1/get_task_status", {
      taskId,
    });
    if (
      result.status === 3 ||
      ([2, 3].includes(result.status) && result.detail?.code)
    )
      throw new AppError(
        "REMOTE_TASK_FAILED",
        "光鸭远端任务失败，请核对目标目录。",
        true,
      );
    if (![0, 1, 2, 3].includes(result.status))
      throw new AppError(
        "REMOTE_SCHEMA_CHANGED",
        "光鸭任务状态结构变化，请核对远端结果。",
        true,
      );
    return result.status === 2;
  }
  private async ownRows(account: Account) {
    const rows: JsonObject[] = [],
      seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const data = await this.request(account, "/userres/v1/get_share_list", {
        page,
        pageSize: 100,
        orderType: 1,
        sortType: 1,
      });
      if (!Array.isArray(data.list))
        throw new AppError(
          "REMOTE_SCHEMA_CHANGED",
          "光鸭本人分享记录结构变化。",
        );
      for (const row of data.list) {
        const key = stringId(row.shareId ?? row.id);
        if (seen.has(key))
          throw new AppError("INCOMPLETE_LIST", "光鸭本人分享记录分页重复。");
        seen.add(key);
        rows.push(row);
      }
      if (!data.list.length) return rows;
    }
    throw new AppError(
      "INCOMPLETE_LIST",
      "光鸭本人分享超过读取上限，请人工核对。",
    );
  }
  private async ownInfo(
    account: Account,
    row: JsonObject,
    uid: string,
    code = "",
  ): Promise<OwnShare> {
    const parsed = parseShare(
      String(row.shareUrl ?? ""),
      code ||
        String(row.code ?? "") ||
        (await this.transport.ownShareCode?.(
          account.id,
          String(row.shareId ?? row.id),
        )) ||
        "",
    );
    if (
      parsed.provider !== this.id ||
      parsed.shareKey !== String(row.shareId ?? row.id)
    )
      throw new AppError(
        "OWNERSHIP_UNVERIFIED",
        "光鸭本人分享记录 ID 与链接不匹配。",
      );
    return {
      id: parsed.shareKey,
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
      row.shareStatus !== 1 ||
      (row.userId != null && String(row.userId) !== uid)
    )
      return false;
    const share = await this.ownInfo(account, row, uid, code),
      source = parseShare(share.url, share.code),
      actual: RemoteFile[] = [],
      cursors = new Set<string>();
    let cursor = "";
    for (let page = 0; page < 200; page++) {
      const data = await this.shared(account, source, "0", cursor);
      // The public summary must explicitly identify the same owner as the authenticated account.
      if (String(data.summary.userId ?? "") !== uid) return false;
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
      if (actual.length > files.length || cursors.has(data.next)) return false;
      cursors.add(data.next);
      cursor = data.next;
    }
    return false;
  }
  private async owner(account: Account) {
    const identity = await this.identity(account);
    if (!account.uid || identity.uid !== account.uid)
      throw new AppError(
        "ACCOUNT_UID_MISMATCH",
        "光鸭登录 UID 与绑定账号不一致，请恢复原本人账号。",
      );
    return identity.uid;
  }
  async createShare(account: Account, files: RemoteFile[], title: string) {
    const uid = await this.owner(account);
    const result = await this.request(
      account,
      "/userres/v1/share_file",
      {
        fileIds: files.map((f) => f.id),
        title,
        validateDuration: 0,
        autoFillCode: true,
      },
      true,
    );
    try {
      const share = await this.ownInfo(account, result, uid),
        row = (await this.ownRows(account)).find(
          (r) => String(r.shareId ?? r.id) === share.id,
        );
      if (!row || !(await this.verified(account, row, files, uid, share.code)))
        throw new AppError(
          "OWNERSHIP_UNVERIFIED",
          "光鸭新分享未通过本人记录及目标文件核验。",
        );
      return share;
    } catch (e) {
      throw new AppError(
        e instanceof AppError ? e.code : "UNCERTAIN_SHARE_RESULT",
        safeMessage(e),
        true,
      );
    }
  }
  async findOwnShare(account: Account, files: RemoteFile[]) {
    const uid = await this.owner(account),
      rows = await this.ownRows(account);
    for (const row of rows)
      if (await this.verified(account, row, files, uid))
        return this.ownInfo(account, row, uid);
    return null;
  }
  async recoverOwnShare(
    account: Account,
    source: ShareInput,
    files: RemoteFile[],
  ) {
    const uid = await this.owner(account);
    if (source.provider !== this.id)
      throw new AppError("OWNERSHIP_UNVERIFIED", "请填写光鸭本人分享。");
    const row = (await this.ownRows(account)).find(
      (r) => String(r.shareId ?? r.id) === source.shareKey,
    );
    if (row && (await this.verified(account, row, files, uid, source.code)))
      return this.ownInfo(account, row, uid, source.code);
    throw new AppError(
      "OWNERSHIP_UNVERIFIED",
      "未在当前光鸭账号中确认此本人链接及文件。",
    );
  }
  async verifyShare(
    account: Account,
    shareId: string,
    files: RemoteFile[],
    code = "",
  ) {
    const uid = await this.owner(account),
      row = (await this.ownRows(account)).find(
        (r) => String(r.shareId ?? r.id) === shareId,
      );
    return !!row && this.verified(account, row, files, uid, code);
  }
  async shareStatistics(): Promise<never> {
    throw new AppError(
      "STATISTICS_UNSUPPORTED",
      "光鸭暂未确认提供逐分享浏览、转存或下载统计接口；盘序本地转存任务数不等于平台转存次数。",
    );
  }
}

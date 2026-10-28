import { uploadQuark } from "./quark-upload";
import type { UploadAsset } from "./small-upload";
import type {
  Account,
  RemoteFile,
  ShareInput,
  ShareInspection,
} from "../../shared/types";
import { AppError, ProviderHttpError, safeMessage } from "../errors";
import type {
  DriveProvider,
  JsonObject,
  OwnShare,
  ProviderTransport,
} from "./provider";
import { normalizeRemoteFile, normalizedDirectory } from "./provider";
import { parseShare } from "../links";
import { normalizeShareStatistic, numericCount } from "./share-statistics";
import { normalizeCapacity } from "./capacity";

export class QuarkProvider implements DriveProvider {
  constructor(
    private transport: ProviderTransport,
    readonly id: "quark" | "uc" = "quark",
  ) {}
  private get label() {
    return this.id === "uc" ? "UC" : "夸克";
  }
  private url(path: string, query: Record<string, string | number> = {}) {
    const url = new URL(
      `https://${this.id === "uc" ? "pc-api.uc.cn" : "drive-pc.quark.cn"}/1/clouddrive/${path}`,
    );
    Object.entries({
      pr: this.id === "uc" ? "UCBrowser" : "ucpro",
      fr: "pc",
      uc_param_str: "",
      ...query,
    }).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    return url.href;
  }
  private async request(
    account: Account,
    path: string,
    query: Record<string, string | number> = {},
    body?: unknown,
  ): Promise<JsonObject> {
    const result = await this.transport
      .json(
        account.id,
        this.url(path, query),
        body === undefined
          ? undefined
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
      )
      .catch((error: unknown) => {
        if (error instanceof ProviderHttpError && error.remoteCode === "32011")
          throw this.realNameRequired();
        throw error;
      });
    if (Number(result.code) === 32011) throw this.realNameRequired();
    if (
      Number(result.code ?? 0) !== 0 ||
      (result.status != null && Number(result.status) !== 200)
    ) {
      const code = Number(result.code ?? result.status);
      const message = String(result.message ?? `${this.label}请求失败`);
      if (
        [401, 31001, 31002].includes(code) ||
        /登录|login|cookie/i.test(message)
      )
        throw new AppError(
          "AUTH_EXPIRED",
          `${this.label}登录已失效，请在原账号窗口重新登录。`,
        );
      if (/容量|空间|quota|capacity/i.test(message))
        throw new AppError(
          "QUOTA_EXCEEDED",
          `${this.label}可用空间不足，请处理后重试。`,
        );
      if (/验证码|验证|频繁|风控|captcha|risk/i.test(message))
        throw new AppError(
          "USER_ACTION_REQUIRED",
          `${this.label}要求人工验证，请在登录窗口处理后重试。`,
        );
      if (/提取码|passcode/i.test(message))
        throw new AppError("BAD_CODE", `${this.label}分享提取码不正确。`);
      throw new AppError(
        "REMOTE_ERROR",
        `${this.label}请求失败（${code}）：${message.slice(0, 160)}`,
      );
    }
    return result;
  }
  private realNameRequired() {
    return new AppError(
      "USER_ACTION_REQUIRED",
      `${this.label}要求当前账号完成实名认证后才能创建分享（32011）。请在${this.label}官方客户端或官网处理，再使用“恢复本人分享”。已保存文件无需重复转存。`,
    );
  }
  async identity(account: Account) {
    const result = await this.transport.json(
      account.id,
      `https://${this.id === "uc" ? "drive.uc.cn" : "pan.quark.cn"}/account/info?fr=pc&platform=pc`,
    );
    const data = result.data;
    if (
      !data ||
      typeof data !== "object" ||
      Object.keys(data).length === 0 ||
      result.success === false ||
      !["0", "OK"].includes(String(result.code ?? "0"))
    )
      throw new AppError(
        "AUTH_EXPIRED",
        `${this.label}官方账号接口尚未确认登录，请在原账号窗口完成登录。`,
      );
    const uid =
      data.user_id ??
      data.uid ??
      data.qid ??
      data.quark_id ??
      data.uc_id ??
      (await this.transport.principalId?.(account.id, this.id));
    if (uid == null || String(uid) === "")
      throw new AppError(
        "UID_UNAVAILABLE",
        `${this.label}已确认登录，但尚未取得稳定账号ID。请重新打开官方登录窗口后再次核验。`,
      );
    return {
      uid: String(uid),
      nickname: String(data.nickname ?? data.nick_name ?? ""),
    };
  }
  async capacity(account: Account) {
    const result = await this.request(account, "member", {
      fetch_subscribe: "false",
      _ch: "home",
      fetch_identity: "false",
    });
    return normalizeCapacity(
      result.data?.total_capacity,
      result.data?.use_capacity,
    );
  }
  private async sharedRows(
    account: Account,
    source: ShareInput,
    parentId = "0",
    page = 1,
  ) {
    const token = await this.request(
      account,
      this.id === "uc" ? "share/sharepage/v2/detail" : "share/sharepage/token",
      {},
      { pwd_id: source.shareKey, passcode: source.code },
    );
    const stoken =
      this.id === "uc" ? token.data?.token_info?.stoken : token.data?.stoken;
    if (!stoken)
      throw new AppError(
        "SHARE_EXPIRED",
        `${this.label}分享已失效或提取码错误。`,
      );
    const result = await this.request(account, "share/sharepage/detail", {
      pwd_id: source.shareKey,
      stoken,
      pdir_fid: parentId,
      _page: page,
      _size: 50,
      _fetch_total: 1,
      _sort: "file_type:asc,file_name:asc",
      force: 0,
      _fetch_share: 1,
    });
    if (!Array.isArray(result.data?.list))
      throw new AppError(
        "REMOTE_SCHEMA_CHANGED",
        `${this.label}未返回文件列表，未继续操作。`,
      );
    return {
      rows: result.data.list as JsonObject[],
      stoken: String(stoken),
      total: Number(result.metadata?._total ?? result.data.list.length),
      title: String(result.data.share?.title ?? ""),
    };
  }
  async inspect(
    account: Account,
    source: ShareInput,
    parentId = "0",
    page = 1,
  ): Promise<ShareInspection> {
    const result = await this.sharedRows(account, source, parentId, page);
    return {
      shareKey: source.shareKey,
      title: result.title,
      files: result.rows.map((r) => normalizeRemoteFile(r, this.id, parentId)),
      hasMore: page * 50 < result.total,
      page,
      parentId,
    };
  }
  async list(account: Account, parentId: string) {
    const files: RemoteFile[] = [];
    for (let page = 1; page <= 200; page++) {
      const result = await this.request(account, "file/sort", {
        pdir_fid: parentId,
        _page: page,
        _size: 100,
        _fetch_total: 1,
        _sort: "file_type:asc,file_name:asc",
        fetch_all_file: 1,
      });
      if (!Array.isArray(result.data?.list))
        throw new AppError(
          "REMOTE_SCHEMA_CHANGED",
          `${this.label}目标文件列表格式变化。`,
        );
      files.push(
        ...result.data.list.map((r: JsonObject) =>
          normalizeRemoteFile(r, this.id, parentId),
        ),
      );
      if (
        result.data.list.length < 100 ||
        files.length >= Number(result.metadata?._total ?? Infinity)
      )
        return files;
    }
    throw new AppError("TOO_MANY_FILES", "目录过大，请选择更小的目标目录。");
  }
  async upload(account: Account, parentId: string, asset: UploadAsset) {
    await uploadQuark(this.id, parentId, asset, (path, body) =>
      this.request(account, path, {}, body),
    );
  }
  async manageFile(account: Account, input: import("../../shared/drive-files").ProviderFileMutation) {
    if (input.action === "mkdir") {
      await this.request(account, "file", {}, { pdir_fid: input.parentId, file_name: input.name, dir_path: "", dir_init_lock: false });
    } else if (input.action === "rename") {
      await this.request(account, "file/rename", {}, { fid: input.file!.id, file_name: input.name });
    } else {
      const result = await this.request(account, "file/delete", {}, { action_type: 2, filelist: [input.file!.id], exclude_fids: [] });
      if (result.data?.task_id) {
        for (let attempt = 0; attempt < 20; attempt++) {
          if (await this.poll(account, String(result.data.task_id))) return;
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
        throw new AppError("UNCERTAIN_REMOTE_RESULT", "删除已提交，结果待核对。", true);
      }
    }
  }
  async ensureFolder(account: Account, path: string) {
    let parent = "0";
    for (const name of normalizedDirectory(path).split("/").filter(Boolean)) {
      const matches = (await this.list(account, parent)).filter(
        (f) => f.name === name && f.isDirectory,
      );
      if (matches.length > 1)
        throw new AppError(
          "AMBIGUOUS_FOLDER",
          "发现多个同名目标目录，请先在网盘中整理。",
        );
      if (matches[0]) {
        parent = matches[0].id;
        continue;
      }
      const created = await this.request(
        account,
        "file",
        {},
        {
          pdir_fid: parent,
          file_name: name,
          dir_path: "",
          dir_init_lock: false,
        },
      );
      parent = String(created.data?.fid ?? "");
      if (!parent)
        throw new AppError(
          "REMOTE_SCHEMA_CHANGED",
          `${this.label}创建目录未返回ID，请核对远端目录后重试。`,
          true,
        );
    }
    return parent;
  }
  async transfer(
    account: Account,
    source: ShareInput,
    selected: RemoteFile[],
    folderId: string,
  ) {
    if (!selected.length || selected.length > 100)
      throw new AppError(
        "FILE_SELECTION_LIMIT",
        "单次请选择1–100个顶层文件或目录。目录内文件由网盘转存。",
      );
    const parents = new Set(selected.map((f) => f.parentId));
    if (parents.size !== 1)
      throw new AppError(
        "FILE_SELECTION_LIMIT",
        "请在同一分享目录中选择文件，或选择上级目录整体转存。",
      );
    const parent = selected[0].parentId;
    const tokens = new Map<string, string>();
    let stoken = "";
    for (let page = 1; page <= 100; page++) {
      const result = await this.sharedRows(account, source, parent, page);
      stoken = result.stoken;
      for (const row of result.rows)
        tokens.set(String(row.fid), String(row.share_fid_token ?? ""));
      if (selected.every((f) => tokens.has(f.id)) || page * 50 >= result.total)
        break;
    }
    if (!selected.every((f) => tokens.get(f.id)))
      throw new AppError(
        "SOURCE_CHANGED",
        "部分已选文件不再存在或分享令牌缺失，请重新读取资源。",
      );
    const result = await this.request(
      account,
      "share/sharepage/save",
      { app: "clouddrive" },
      {
        fid_list: selected.map((f) => f.id),
        fid_token_list: selected.map((f) => tokens.get(f.id)),
        to_pdir_fid: folderId,
        pwd_id: source.shareKey,
        stoken,
        pdir_fid: parent,
        scene: "link",
      },
    );
    if (!result.data?.task_id)
      throw new AppError(
        "UNCERTAIN_REMOTE_RESULT",
        `${this.label}未返回转存任务ID，请核对目标目录，不能直接重复转存。`,
        true,
      );
    return { taskId: String(result.data.task_id) };
  }
  async poll(account: Account, taskId: string) {
    const result = await this.request(account, "task", {
      task_id: taskId,
      retry_index: 0,
    });
    if (Number(result.data?.status) === 2) return true;
    if ([3, 4].includes(Number(result.data?.status)))
      throw new AppError(
        "REMOTE_TASK_FAILED",
        `${this.label}远端任务未完成，请核对文件结果。`,
        true,
      );
    return false;
  }
  async shareStatistics(account: Account, page: number) {
    const result = await this.request(account, "share/mypage/detail", {
      _page: page,
      _size: 100,
      _order_field: "created_at",
      _order_type: "desc",
      _fetch_total: 1,
    });
    const rows = result.data?.list;
    if (!Array.isArray(rows))
      throw new AppError(
        "REMOTE_SCHEMA_CHANGED",
        `${this.label}本人分享统计列表结构已变化。`,
      );
    const total = numericCount(
      result.metadata?._total ?? result.metadata?.total,
    );
    return {
      items: rows.map((row) => normalizeShareStatistic(row, this.id)),
      hasMore: total == null ? rows.length === 100 : page * 100 < total,
      total,
    };
  }
  private async ownRows(account: Account) {
    const rows: JsonObject[] = [];
    for (let page = 1; page <= 30; page++) {
      const result = await this.request(account, "share/mypage/detail", {
        _page: page,
        _size: 100,
        _order_field: "created_at",
        _order_type: "desc",
        _fetch_total: 1,
      });
      const data = result.data?.list;
      if (!Array.isArray(data))
        throw new AppError(
          "REMOTE_SCHEMA_CHANGED",
          "未能读取本人分享记录，不能核验分享归属。",
        );
      rows.push(...data);
      if (data.length < 100) break;
    }
    return rows;
  }
  private matches(row: JsonObject, files: RemoteFile[]) {
    if (
      files.length === 1 &&
      Number(row.file_num) === 1 &&
      row.first_fid != null
    )
      return String(row.first_fid) === files[0].id;
    const fids =
      row.fid_list ?? row.fids ?? row.file_list?.map((f: JsonObject) => f.fid);
    return (
      Array.isArray(fids) &&
      fids.length === files.length &&
      files.every((f) => fids.map(String).includes(f.id))
    );
  }
  private async shareInfo(
    account: Account,
    shareId: string,
  ): Promise<OwnShare> {
    const result = await this.request(
      account,
      "share/password",
      {},
      { share_id: shareId },
    );
    const identity = await this.identity(account);
    const parsed = parseShare(
      String(result.data?.share_url ?? result.data?.url ?? ""),
    );
    if (parsed.provider !== this.id)
      throw new AppError("INVALID_OWN_SHARE", "返回的本人分享链接类型不正确。");
    return {
      id: shareId,
      url: parsed.url,
      code: String(
        result.data?.passcode ?? result.data?.pass_code ?? parsed.code ?? "",
      ),
      ownerUid: identity.uid,
    };
  }
  async createShare(account: Account, files: RemoteFile[], title: string) {
    const result = await this.request(
      account,
      "share",
      {},
      { fid_list: files.map((f) => f.id), title, url_type: 1, expired_type: 1 },
    );
    try {
      let shareId = result.data?.share_id;
      if (!shareId && result.data?.task_id) {
        for (let attempt = 0; attempt < 30; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const task = await this.request(account, "task", {
            task_id: result.data.task_id,
            retry_index: attempt,
          });
          shareId = task.data?.share_id ?? task.data?.share?.share_id;
          if (shareId) break;
        }
      }
      if (!shareId)
        throw new AppError(
          "UNCERTAIN_SHARE_RESULT",
          `${this.label}分享未返回ID，请先核对本人分享记录。`,
          true,
        );
      const share = await this.shareInfo(account, String(shareId));
      if (!(await this.verifyShare(account, share.id, files)))
        throw new AppError(
          "OWNERSHIP_UNVERIFIED",
          "未在本人分享记录中确认目标文件，暂不允许分发。",
        );
      return share;
    } catch (error) {
      throw new AppError(
        error instanceof AppError ? error.code : "UNCERTAIN_SHARE_RESULT",
        safeMessage(error),
        true,
      );
    }
  }
  private async containsFiles(
    account: Account,
    row: JsonObject,
    files: RemoteFile[],
  ) {
    if (row.status != null && Number(row.status) !== 1) return false;
    if (
      files.length === 1 &&
      Number(row.file_num) === 1 &&
      row.first_fid != null &&
      String(row.first_fid) !== files[0].id
    )
      return false;
    const expiration = Number(row.expired_at ?? 0);
    if (
      expiration > 0 &&
      (expiration < 1e12 ? expiration * 1000 : expiration) < Date.now()
    )
      return false;
    const knownIds =
      row.fid_list ?? row.fids ?? row.file_list?.map((f: JsonObject) => f.fid);
    if (Array.isArray(knownIds) && !this.matches(row, files)) return false;
    if (row.file_num != null && Number(row.file_num) !== files.length)
      return false;
    // The authenticated record proves ownership. Verify its public manifest too,
    // because some web versions omit file IDs from the record list.
    const share = await this.shareInfo(account, String(row.share_id));
    const source = parseShare(share.url, share.code),
      actual: RemoteFile[] = [];
    for (let page = 1; page <= 3; page++) {
      let inspection: ShareInspection;
      try {
        inspection = await this.inspect(account, source, "0", page);
      } catch (error) {
        if (
          error instanceof AppError &&
          (error.code === "SHARE_EXPIRED" || /41019/.test(error.message))
        )
          return false;
        throw error;
      }
      actual.push(...inspection.files);
      if (!inspection.hasMore) break;
    }
    return (
      actual.length === files.length &&
      files.every((f) =>
        actual.some(
          (a) =>
            a.id === f.id &&
            a.name === f.name &&
            a.isDirectory === f.isDirectory,
        ),
      )
    );
  }
  async findOwnShare(account: Account, files: RemoteFile[]) {
    const candidates = (await this.ownRows(account))
      .filter(
        (r) =>
          r.share_id &&
          (r.file_num == null || Number(r.file_num) === files.length),
      )
      .slice(0, 30);
    for (const row of candidates)
      if (await this.containsFiles(account, row, files))
        return this.shareInfo(account, String(row.share_id));
    return null;
  }
  async verifyShare(account: Account, shareId: string, files: RemoteFile[]) {
    const row = (await this.ownRows(account)).find(
      (r) => String(r.share_id) === shareId,
    );
    return !!row && this.containsFiles(account, row, files);
  }
  async recoverOwnShare(
    account: Account,
    source: ShareInput,
    files: RemoteFile[],
  ): Promise<OwnShare> {
    const candidates = (await this.ownRows(account))
      .filter(
        (r) =>
          r.share_id &&
          (r.file_num == null || Number(r.file_num) === files.length),
      )
      .slice(0, 30);
    for (const row of candidates) {
      const share = await this.shareInfo(account, String(row.share_id));
      if (
        share.url === source.url &&
        (await this.containsFiles(account, row, files))
      )
        return share;
    }
    throw new AppError(
      "OWNERSHIP_UNVERIFIED",
      "此链接未出现在当前账号的对应文件分享记录中。",
    );
  }
}

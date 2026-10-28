import { digest, type UploadAsset } from "./small-upload";
import { randomBytes } from "node:crypto";
import type {
  Account,
  RemoteFile,
  ShareInput,
  ShareInspection,
} from "../../shared/types";
import { AppError } from "../errors";
import { parseShare } from "../links";
import type {
  DriveProvider,
  JsonObject,
  OwnShare,
  ProviderTransport,
} from "./provider";
import { normalizeRemoteFile, normalizedDirectory } from "./provider";
import { normalizeShareStatistic, numericCount } from "./share-statistics";
import { normalizeCapacity } from "./capacity";

// Parse only data literals. Remote HTML is never evaluated as JavaScript.
export function extractBaiduShareData(html: string): JsonObject {
  const marker = html.indexOf("loginstate");
  if (marker < 0)
    throw new AppError(
      "SHARE_PAGE_CHANGED",
      "百度分享页面未提供可识别的数据，请在账号窗口检查登录及提取码。",
    );
  for (let start = marker; start >= Math.max(0, marker - 3000); start--) {
    if (html[start] !== "{") continue;
    let depth = 0,
      quoted = false,
      escaped = false;
    for (
      let end = start;
      end < Math.min(html.length, start + 2_000_000);
      end++
    ) {
      const char = html[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try {
          const parsed = JSON.parse(html.slice(start, end + 1));
          if (
            "loginstate" in parsed &&
            ("shareid" in parsed || "share_uk" in parsed)
          )
            return parsed;
        } catch {
          /* try the next outer literal */
        }
        break;
      }
    }
  }
  throw new AppError(
    "SHARE_PAGE_CHANGED",
    "百度分享页结构已变化，未执行转存，请人工检查分享页。",
  );
}
export class BaiduProvider implements DriveProvider {
  readonly id = "baidu" as const;
  constructor(private transport: ProviderTransport) {}
  private url(path: string, query: Record<string, string | number> = {}) {
    const url = new URL(`https://pan.baidu.com${path}`);
    Object.entries({
      channel: "chunlei",
      clienttype: "0",
      web: "1",
      ...query,
    }).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    return url.href;
  }
  private async request(
    account: Account,
    path: string,
    query: Record<string, string | number> = {},
    body?: Record<string, string>,
  ): Promise<JsonObject> {
    const result = await this.transport.json(
      account.id,
      this.url(path, query),
      body
        ? {
            method: "POST",
            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded; charset=UTF-8",
            },
            body: new URLSearchParams(body).toString(),
          }
        : undefined,
    );
    const code = Number(result.errno ?? result.error_code ?? 0);
    if (code) {
      if ([-6, -4, 110, 111, 9019].includes(code))
        throw new AppError(
          "AUTH_EXPIRED",
          "百度登录已过期或缺少有效网盘会话，请在原账号窗口重新登录。",
        );
      if ([-9, -12].includes(code) && path.includes("verify"))
        throw new AppError("BAD_CODE", "百度网盘提取码不正确。");
      if ([-7, -10, 31066].includes(code))
        throw new AppError(
          "QUOTA_EXCEEDED",
          "百度网盘空间不足，请处理后重试。",
        );
      if ([4, 8001, 9013].includes(code))
        throw new AppError(
          "USER_ACTION_REQUIRED",
          "百度要求人工验证或限制了本次操作，请在账号窗口处理。",
        );
      throw new AppError(
        "REMOTE_ERROR",
        `百度网盘返回错误码 ${code}，未确认操作成功。`,
      );
    }
    return result;
  }
  private async sessionData(account: Account) {
    const result = await this.request(account, "/api/gettemplatevariable", {
      fields: '["uk","bdstoken","username"]',
    });
    const data = result.result ?? result.data;
    if (!data?.uk || !data?.bdstoken)
      throw new AppError(
        "AUTH_EXPIRED",
        "无法读取百度账号UID与会话令牌，请重新登录网盘。",
      );
    return {
      uid: String(data.uk),
      token: String(data.bdstoken),
      nickname: String(data.username ?? ""),
    };
  }
  async identity(account: Account) {
    const data = await this.sessionData(account);
    return { uid: data.uid, nickname: data.nickname };
  }
  async capacity(account: Account) {
    const result = await this.request(account, "/api/quota", {
      checkexpire: 1,
      checkfree: 1,
    });
    return normalizeCapacity(result.total, result.used);
  }
  private async shareData(account: Account, source: ShareInput) {
    const short = source.shareKey.startsWith("1")
      ? source.shareKey.slice(1)
      : source.shareKey;
    if (source.code) {
      const result = await this.request(
        account,
        "/share/verify",
        { surl: short, t: Date.now() },
        { pwd: source.code, vcode: "", vcode_str: "" },
      );
      if (result.randsk)
        await this.transport.setCookie?.(
          account.id,
          "https://pan.baidu.com",
          "BDCLND",
          String(result.randsk),
        );
    }
    const html = await this.transport.text(account.id, source.url, {
      headers: { Referer: "https://pan.baidu.com/disk/home" },
    });
    if (/platform-non-found|error-404/.test(html))
      throw new AppError("SHARE_EXPIRED", "百度分享已失效或不存在。");
    const parsed = extractBaiduShareData(html);
    if (!parsed.shareid || !parsed.share_uk)
      throw new AppError(
        "SHARE_PAGE_CHANGED",
        "百度分享元信息不完整，未继续转存。",
      );
    return parsed;
  }
  async inspect(
    account: Account,
    source: ShareInput,
    parentId = "0",
    page = 1,
  ): Promise<ShareInspection> {
    const data = await this.shareData(account, source);
    const query: Record<string, string | number> = {
      uk: String(data.share_uk),
      shareid: String(data.shareid),
      page,
      num: 100,
      order: "name",
      desc: 0,
    };
    if (parentId === "0") query.root = 1;
    else {
      query.root = 0;
      query.dir = parentId;
    }
    const result = await this.request(account, "/share/list", query);
    if (!Array.isArray(result.list))
      throw new AppError("REMOTE_SCHEMA_CHANGED", "百度未返回分享文件列表。");
    return {
      shareKey: source.shareKey,
      title: String(data.share_title ?? ""),
      files: result.list.map((r: JsonObject) =>
        normalizeRemoteFile(r, this.id, parentId),
      ),
      hasMore: result.list.length === 100,
      page,
      parentId,
    };
  }
  async list(account: Account, parentId: string) {
    const files: RemoteFile[] = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.request(account, "/api/list", {
        dir: parentId,
        page,
        num: 100,
        order: "name",
        desc: 0,
        showempty: 0,
      });
      if (!Array.isArray(result.list))
        throw new AppError(
          "REMOTE_SCHEMA_CHANGED",
          "百度未返回本人目录文件列表。",
        );
      files.push(
        ...result.list.map((r: JsonObject) =>
          normalizeRemoteFile(r, this.id, parentId),
        ),
      );
      if (result.list.length < 100) return files;
    }
    throw new AppError("TOO_MANY_FILES", "目标目录过大，请选择更小的目录。");
  }
  async upload(account: Account, parentId: string, asset: UploadAsset) {
    const path =
      normalizedDirectory(parentId).replace(/\/$/, "") + "/" + asset.name;
    const token = (await this.sessionData(account)).token;
    const blocks = [digest("md5", asset.bytes)];
    // rtype=0 rejects a name conflict; never overwrite or silently rename.
    const body = {
      path,
      size: String(asset.bytes.length),
      isdir: "0",
      autoinit: "1",
      rtype: "0",
      block_list: JSON.stringify(blocks),
    };
    const pre = await this.request(
      account,
      "/api/precreate",
      { bdstoken: token },
      body,
    );
    if (!pre.uploadid)
      throw new AppError(
        "UNCERTAIN_REMOTE_RESULT",
        "百度未返回预上传任务。",
        true,
      );
    if (Number(pre.return_type) !== 2) {
      const url = new URL("https://d.pcs.baidu.com/rest/2.0/pcs/superfile2");
      Object.entries({
        method: "upload",
        app_id: "250528",
        channel: "chunlei",
        clienttype: "0",
        web: "1",
        path,
        uploadid: String(pre.uploadid),
        partseq: "0",
      }).forEach(([k, v]) => url.searchParams.set(k, v));
      const form = new FormData();
      form.set(
        "file",
        new Blob([new Uint8Array(asset.bytes)], { type: asset.mime }),
        asset.name,
      );
      const part = await this.transport.json(account.id, url.href, {
        method: "POST",
        body: form,
      });
      if (part.md5 !== blocks[0])
        throw new AppError(
          "UNCERTAIN_REMOTE_RESULT",
          "百度分块摘要核验失败。",
          true,
        );
    }
    await this.request(
      account,
      "/api/create",
      { a: "commit", bdstoken: token, rtype: "0" },
      { ...body, uploadid: String(pre.uploadid) },
    );
  }
  async ensureFolder(account: Account, path: string) {
    const token = (await this.sessionData(account)).token;
    let current = "";
    for (const name of normalizedDirectory(path).split("/").filter(Boolean)) {
      const parent = current || "/";
      current += "/" + name;
      const found = (await this.list(account, parent)).filter(
        (f) => f.name === name && f.isDirectory,
      );
      if (found.length > 1)
        throw new AppError("AMBIGUOUS_FOLDER", "百度目标目录重名，请先整理。");
      if (!found.length)
        await this.request(
          account,
          "/api/create",
          { a: "commit", bdstoken: token },
          { path: current, isdir: "1", block_list: "[]" },
        );
    }
    return current || "/";
  }
  async manageFile(account: Account, input: import("../../shared/drive-files").ProviderFileMutation) {
    await this.manage(account, input.action, input.action === "mkdir" ? input.path : input.file!.path ?? input.path.replace(/\/$/, "") + "/" + input.file!.name, input.name);
  }
  async manage(account: Account, action: "mkdir" | "rename" | "delete", path: string, name = "") {
    const target = normalizedDirectory(path);
    if (action !== "mkdir" && target === "/") throw new AppError("ROOT_PROTECTED", "不能修改网盘根目录。");
    if (action !== "delete" && (!name.trim() || /[\\/:*?"<>|\x00-\x1f]/.test(name) || [".", ".."].includes(name))) throw new AppError("INVALID_NAME", "名称不能为空或包含路径和特殊字符。");
    const token = (await this.sessionData(account)).token;
    if (action === "mkdir") {
      const created = normalizedDirectory(target.replace(/\/$/, "") + "/" + name);
      await this.request(account, "/api/create", { a: "commit", bdstoken: token }, { path: created, isdir: "1", block_list: "[]" });
      return;
    }
    const result = await this.request(account, "/api/filemanager", { opera: action, async: 2, onnest: "fail", bdstoken: token }, { async: "1", filelist: JSON.stringify(action === "rename" ? [{ path: target, newname: name }] : [target]) });
    if (Array.isArray(result.info) && result.info.some((v: any) => Number(v.errno ?? 0) !== 0)) throw new AppError("FILE_OPERATION_FAILED", "百度未完成文件操作，请核对网盘结果。");
    if (result.taskid) {
      for (let attempt = 0; attempt < 20; attempt++) {
        if (await this.poll(account, String(result.taskid))) return;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new AppError("UNCERTAIN_REMOTE_RESULT", "网盘操作尚未确认完成，请刷新目录核对，避免重复提交。", true);
    }
  }
  async transfer(
    account: Account,
    source: ShareInput,
    selected: RemoteFile[],
    _folderId: string,
    path: string,
  ) {
    if (!selected.length || selected.length > 100)
      throw new AppError(
        "FILE_SELECTION_LIMIT",
        "单次请选择1–100个顶层文件或目录。",
      );
    const data = await this.shareData(account, source);
    const session = await this.sessionData(account);
    const result = await this.request(
      account,
      "/share/transfer",
      {
        shareid: String(data.shareid),
        from: String(data.share_uk),
        bdstoken: session.token,
        async: 1,
      },
      { fsidlist: JSON.stringify(selected.map((f) => f.id)), path },
    );
    if (!result.taskid && !result.extra?.list && !result.info)
      throw new AppError(
        "UNCERTAIN_REMOTE_RESULT",
        "百度未返回明确的转存结果，请先核对远端目录。",
        true,
      );
    return { taskId: result.taskid ? String(result.taskid) : null };
  }
  async poll(account: Account, taskId: string) {
    const result = await this.request(account, "/api/taskquery", {
      taskid: taskId,
    });
    if (result.status === "success" || Number(result.status) === 2) return true;
    if (result.status === "failed")
      throw new AppError(
        "REMOTE_TASK_FAILED",
        "百度远端转存失败，请核对目标目录。",
        true,
      );
    return false;
  }
  async shareStatistics(account: Account, page: number) {
    const result = await this.request(account, "/share/record", {
      page,
      num: 100,
      order: "time",
      desc: 1,
    });
    if (!Array.isArray(result.list))
      throw new AppError(
        "REMOTE_SCHEMA_CHANGED",
        "百度本人分享统计列表结构已变化。",
      );
    const total = numericCount(result.total ?? result.total_count);
    return {
      items: result.list.map((row: JsonObject) =>
        normalizeShareStatistic(row, this.id),
      ),
      hasMore: total == null ? result.list.length === 100 : page * 100 < total,
      total,
    };
  }
  private async ownRows(account: Account) {
    const rows: JsonObject[] = [];
    for (let page = 1; page <= 30; page++) {
      const result = await this.request(account, "/share/record", {
        page,
        num: 100,
        order: "time",
        desc: 1,
      });
      if (!Array.isArray(result.list))
        throw new AppError(
          "REMOTE_SCHEMA_CHANGED",
          "未能读取百度本人分享记录。",
        );
      rows.push(...result.list);
      if (result.list.length < 100) break;
    }
    return rows;
  }
  private matches(row: JsonObject, files: RemoteFile[]) {
    const raw = row.fsIds ?? row.fs_ids ?? row.fid_list;
    const ids =
      typeof raw === "string"
        ? raw.replace(/[\[\]\s]/g, "").split(",")
        : Array.isArray(raw)
          ? raw.map(String)
          : [];
    return (
      ids.length === files.length && files.every((f) => ids.includes(f.id))
    );
  }
  async createShare(
    account: Account,
    files: RemoteFile[],
    _title: string,
  ): Promise<OwnShare> {
    const session = await this.sessionData(account);
    const code = randomBytes(3).toString("hex").slice(0, 4);
    const result = await this.request(
      account,
      "/share/set",
      { bdstoken: session.token },
      {
        fid_list: JSON.stringify(files.map((f) => f.id)),
        schannel: "4",
        channel_list: "[]",
        period: "0",
        pwd: code,
      },
    );
    const shareId = String(result.shareid ?? "");
    if (!shareId || !result.link)
      throw new AppError(
        "UNCERTAIN_SHARE_RESULT",
        "百度未返回分享ID或链接，请先核对本人分享记录。",
        true,
      );
    if (!(await this.verifyShare(account, shareId, files)))
      throw new AppError(
        "OWNERSHIP_UNVERIFIED",
        "百度本人分享记录未确认所选文件，禁止分发。",
      );
    const parsed = parseShare(String(result.link));
    if (parsed.provider !== this.id)
      throw new AppError("INVALID_OWN_SHARE", "百度分享类型不匹配。");
    return { id: shareId, url: parsed.url, code, ownerUid: session.uid };
  }
  async findOwnShare(account: Account, files: RemoteFile[]) {
    const row = (await this.ownRows(account)).find(
      (r) => this.matches(r, files) && Number(r.status ?? 0) === 0,
    );
    if (!row) return null;
    const link = row.shortlink ?? row.link;
    if (!link)
      throw new AppError(
        "RECOVER_SHARE_MANUALLY",
        "找到已有本人分享但未取得完整链接，请在网盘中核对；不会重复创建。",
      );
    const parsed = parseShare(String(link));
    if (row.public !== 1 && !row.passwd && !row.pwd)
      throw new AppError(
        "RECOVER_SHARE_MANUALLY",
        "已找到本人私密分享，但接口未提供提取码。请在网盘中核对后使用“恢复本人分享”录入，避免分发不可访问的链接。",
        true,
      );
    return {
      id: String(row.shareId ?? row.shareid),
      url: parsed.url,
      code: String(row.passwd ?? row.pwd ?? ""),
      ownerUid: (await this.identity(account)).uid,
    };
  }
  async recoverOwnShare(
    account: Account,
    source: ShareInput,
    files: RemoteFile[],
  ): Promise<OwnShare> {
    const row = (await this.ownRows(account)).find((r) => {
      if (!this.matches(r, files) || Number(r.status ?? 0) !== 0) return false;
      try {
        return (
          parseShare(String(r.shortlink ?? r.link ?? "")).url === source.url
        );
      } catch {
        return false;
      }
    });
    if (!row)
      throw new AppError(
        "OWNERSHIP_UNVERIFIED",
        "此链接未出现在当前账号的对应文件分享记录中。",
      );
    const inspection = await this.inspect(account, source);
    if (
      inspection.hasMore ||
      inspection.files.length !== files.length ||
      !files.every((f) => inspection.files.some((a) => a.id === f.id))
    )
      throw new AppError(
        "OWNERSHIP_UNVERIFIED",
        "分享内容或提取码未通过检查。",
      );
    return {
      id: String(row.shareId ?? row.shareid),
      url: source.url,
      code: source.code,
      ownerUid: (await this.identity(account)).uid,
    };
  }
  async verifyShare(account: Account, shareId: string, files: RemoteFile[]) {
    return (await this.ownRows(account)).some(
      (r) =>
        String(r.shareId ?? r.shareid) === shareId &&
        this.matches(r, files) &&
        Number(r.status ?? 0) === 0,
    );
  }
}

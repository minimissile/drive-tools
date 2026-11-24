import { createHash, randomBytes } from "node:crypto";
import type { Account, RemoteFile, ShareInput } from "../../shared/types";
import type { DriveListPage } from "../../shared/drive-sync";
import type { ProviderFileMutation } from "../../shared/drive-files";
import { providerApiAllowed } from "../../shared/providers";
import { AppError } from "../errors";
import { normalizeCapacity } from "./capacity";
import { storageUrl, type UploadAsset } from "./small-upload";
import {
  normalizedDirectory,
  type DriveProvider,
  type JsonObject,
  type ProviderTransport,
} from "./provider";

const userBase = "https://user-njs.yun.139.com/user";
const personalBase = "https://personal-kd-njs.yun.139.com/hcy";
const legacyBase = "https://yun.139.com/orchestration/personalCloud";
const md5 = (value: string) => createHash("md5").update(value).digest("hex");

/** The first-party web client signs the exact JSON sent, using China local time. */
export function cmccSignature(body: string, timestamp: string, nonce: string) {
  const sorted = encodeURIComponent(body).split("").sort().join("");
  return md5(
    md5(Buffer.from(sorted).toString("base64")) + md5(`${timestamp}:${nonce}`),
  ).toUpperCase();
}
function timestamp() {
  return new Date(Date.now() + 8 * 3600_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}
function text(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    /[\x00-\x1f]/.test(value)
  )
    throw new AppError(
      "REMOTE_SCHEMA_CHANGED",
      `移动云盘未返回有效${label}，未继续操作。`,
    );
  return value;
}
function route(value: unknown, fallback: string, service: "personal" | "user") {
  if (value == null || value === "") return fallback;
  const url = new URL(String(value));
  if (
    !providerApiAllowed("cmcc", url.href) ||
    !url.hostname.startsWith(`${service}-`) ||
    url.search ||
    url.hash
  )
    throw new AppError(
      "PROVIDER_URL_BLOCKED",
      "移动云盘返回的路由不属于该服务，已停止请求。",
    );
  return url.href.replace(/\/$/, "");
}
interface Context {
  marker: string;
  uid: string;
  account: string;
  nickname: string;
  personal: string;
  user: string;
  modern: boolean;
}
function modernFile(row: JsonObject, parentId: string): RemoteFile {
  const id = text(row.fileId, "文件 ID"),
    name = text(row.name, "文件名称");
  if (!["folder", "file"].includes(row.type))
    throw new AppError("REMOTE_SCHEMA_CHANGED", "移动云盘返回了未知文件类型。");
  const size = row.type === "folder" ? null : Number(row.size);
  if (
    (row.type === "file" && row.size == null) ||
    (size !== null && (!Number.isSafeInteger(size) || size < 0))
  )
    throw new AppError(
      "REMOTE_SCHEMA_CHANGED",
      "移动云盘文件大小无效，未记为完整目录。",
    );
  return { id, name, isDirectory: row.type === "folder", size, parentId };
}

/** Personal storage only. Family/group/safe-box storage is never silently mixed in. */
export class CmccProvider implements DriveProvider {
  readonly id = "cmcc" as const;
  private contexts = new Map<string, Context>();
  constructor(private transport: ProviderTransport) {}
  private async headers(account: Account) {
    const headers = await this.transport.authHeaders?.(account.id);
    if (
      !headers?.authorization ||
      !/^Basic [A-Za-z0-9+/]+=*$/.test(headers.authorization)
    )
      throw new AppError(
        "AUTH_EXPIRED",
        "请在此移动云盘账号的内置窗口登录，并进入个人云盘后核验。",
      );
    return headers;
  }
  private async request(
    account: Account,
    base: string,
    path: string,
    data: JsonObject,
    write = false,
  ) {
    const url = `${base}${path}`;
    if (!providerApiAllowed("cmcc", url))
      throw new AppError("PROVIDER_URL_BLOCKED", "移动云盘接口地址不受信任。");
    const captured = await this.headers(account),
      body = JSON.stringify(data),
      time = timestamp(),
      nonce = randomBytes(12).toString("hex").slice(0, 16);
    let result: JsonObject;
    try {
      result = await this.transport.json(account.id, url, {
        method: "POST",
        credentials: "omit",
        headers: {
          ...captured,
          "Content-Type": "application/json;charset=UTF-8",
          Origin: "https://yun.139.com",
          Referer: "https://yun.139.com/w/",
          "CMS-DEVICE": "default",
          "mcloud-channel": "1000101",
          "mcloud-client": captured["mcloud-client"] || "10701",
          "mcloud-version": captured["mcloud-version"] || "7.14.0",
          "mcloud-route": "001",
          "mcloud-sign": `${time},${nonce},${cmccSignature(body, time, nonce)}`,
          "x-huawei-channelSrc": "10000034",
          "x-inner-ntwk": "2",
          "x-m4c-caller": "PC",
          "x-m4c-src": "10002",
          "x-SvcType": "1",
          "x-yun-svc-type": "1",
          "x-yun-module-type": "100",
          "x-yun-api-version": "v1",
          "x-yun-app-channel": "10000034",
          "x-yun-channel-source": "10000034",
          "Inner-Hcy-Router-Https": "1",
        },
        body,
      });
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError(
        write ? "UNCERTAIN_REMOTE_RESULT" : "REMOTE_UNAVAILABLE",
        write
          ? "移动云盘请求中断，远端结果待核对，未自动重试。"
          : "移动云盘读取未完成，请检查网络或重新核验登录。",
        write,
      );
    }
    const code = String(result.code ?? result.data?.result?.resultCode ?? "");
    if (result.success !== true || !/^0{1,12}$/.test(code)) {
      const message = String(
        result.message ?? result.data?.result?.resultDesc ?? "",
      );
      if (
        ["401", "200000401", "1010010002"].includes(code) ||
        /token|auth|登录|会话/i.test(message)
      )
        throw new AppError(
          "AUTH_EXPIRED",
          "移动云盘会话未通过核验，请在该账号原窗口重新登录。",
        );
      if (/风控|验证|验证码|频繁|risk|captcha/i.test(message))
        throw new AppError(
          "USER_ACTION_REQUIRED",
          "请在移动云盘官方窗口完成安全验证后重试。",
        );
      throw new AppError(
        "REMOTE_ERROR",
        `移动云盘未确认请求成功（${/^[\w-]{1,30}$/.test(code) ? code : "结构变化"}），请核对官网结果。`,
        write,
      );
    }
    if (result.data == null && write) return {};
    if (
      !result.data ||
      typeof result.data !== "object" ||
      Array.isArray(result.data)
    )
      throw new AppError(
        "REMOTE_SCHEMA_CHANGED",
        "移动云盘返回的数据结构已变化。",
        write,
      );
    return result.data;
  }
  async identity(account: Account) {
    const captured = await this.headers(account);
    const status = await this.request(account, userBase, "/status/query", {});
    const uid = text(status.userDomainId, "账号 UID");
    const phone = Buffer.from(captured.authorization.slice(6), "base64")
      .toString("utf8")
      .match(/^pc:([+\d]{5,20}):/)?.[1];
    if (
      !phone ||
      (typeof status.phoneNumber === "string" &&
        /^[+\d]+$/.test(status.phoneNumber) &&
        status.phoneNumber !== phone)
    )
      throw new AppError(
        "ACCOUNT_UID_MISMATCH",
        "移动云盘登录态与当前账号信息不一致，请重新登录。",
      );
    if (![0, 1, "0", "1"].includes(status.cutoverStatus))
      throw new AppError(
        "REMOTE_SCHEMA_CHANGED",
        "移动云盘未返回个人盘版本，未继续读取。",
      );
    const policies = await this.request(
      account,
      userBase,
      "/route/qryRoutePolicy",
      { userInfo: { userDomainId: uid }, modAddrType: 1 },
    );
    if (!Array.isArray(policies.routePolicyList))
      throw new AppError("REMOTE_SCHEMA_CHANGED", "移动云盘未返回个人盘路由。");
    const endpoint = (name: string) =>
      policies.routePolicyList.find(
        (p: JsonObject) => String(p.modName).toLowerCase() === name,
      )?.httpsUrl;
    const user = route(endpoint("user"), userBase, "user");
    const profile = await this.request(account, user, "/getUser", {
      userDomainId: uid,
    });
    if (profile.userDomainId && String(profile.userDomainId) !== uid)
      throw new AppError(
        "ACCOUNT_UID_MISMATCH",
        "移动云盘返回的身份不一致，请重新登录核验。",
      );
    const nickname = text(
      profile.userProfileInfo?.userName ||
        profile.nickName ||
        `${phone.slice(0, 3)}****${phone.slice(-4)}`,
      "用户名",
    );
    this.contexts.set(account.id, {
      marker: createHash("sha256").update(captured.authorization).digest("hex"),
      uid,
      account: phone,
      nickname,
      user,
      personal: route(endpoint("personal"), personalBase, "personal"),
      modern: Number(status.cutoverStatus) === 1,
    });
    return { uid, nickname };
  }
  private async context(account: Account) {
    const headers = await this.headers(account);
    if (
      this.contexts.get(account.id)?.marker !==
      createHash("sha256").update(headers.authorization).digest("hex")
    )
      await this.identity(account);
    const context = this.contexts.get(account.id)!;
    if (account.uid && account.uid !== context.uid)
      throw new AppError(
        "ACCOUNT_UID_MISMATCH",
        "移动云盘当前登录账号与绑定账号不同，已停止操作。",
      );
    return context;
  }
  async capacity(account: Account) {
    const c = await this.context(account);
    const data = c.modern
      ? await this.request(account, c.user, "/disk/getPersonalDiskInfo", {
          userDomainId: c.uid,
        })
      : await this.request(account, legacyBase, "/user/v1.0/getDiskInfo", {
          commonAccountInfo: { account: c.account, accountType: 1 },
        });
    const value = c.modern ? data : data.diskInfo;
    if (!value || typeof value !== "object")
      throw new AppError(
        "CAPACITY_UNAVAILABLE",
        "移动云盘未返回个人盘容量信息。",
      );
    const total = Number(value.diskSize),
      free = Number(value.freeDiskSize);
    if (
      value.diskSize == null ||
      value.freeDiskSize == null ||
      !Number.isSafeInteger(free) ||
      free < 0 ||
      free > total
    )
      throw new AppError(
        "CAPACITY_UNAVAILABLE",
        "移动云盘未返回有效容量，不把未知容量显示为0。",
      );
    return normalizeCapacity(total, total - free);
  }
  async membership(): Promise<
    import("../../shared/drive-membership").DriveMembership
  > {
    throw new AppError(
      "MEMBERSHIP_UNSUPPORTED",
      "移动云盘会员状态与到期时间暂未接入，请在官网查看。",
    );
  }
  async listPage(
    account: Account,
    parentId: string,
    cursor = "",
  ): Promise<DriveListPage> {
    const c = await this.context(account);
    if (c.modern) {
      const data = await this.request(account, c.personal, "/file/list", {
        parentFileId: parentId === "0" ? "/" : parentId,
        pageInfo: { pageSize: 100, pageCursor: cursor || null },
        orderBy: "name",
        orderDirection: "ASC",
      });
      if (
        !Array.isArray(data.items) ||
        !Object.hasOwn(data, "nextPageCursor") ||
        (data.nextPageCursor != null && typeof data.nextPageCursor !== "string")
      )
        throw new AppError(
          "INCOMPLETE_LIST",
          "移动云盘目录分页结构已变化，未记为同步完成。",
        );
      const next = data.nextPageCursor || null;
      if (next && (next.length > 4096 || next === cursor))
        throw new AppError(
          "INCOMPLETE_LIST",
          "移动云盘目录分页没有前进，已保留索引。",
        );
      return {
        files: data.items
          .filter((f: JsonObject) => f.fileId !== "/sbox")
          .map((f: JsonObject) => modernFile(f, parentId)),
        next,
      };
    }
    if (cursor && !/^\d{1,7}$/.test(cursor))
      throw new AppError("INVALID_CURSOR", "移动云盘分页标记无效。");
    const offset = Number(cursor || 0);
    const data = await this.request(
      account,
      legacyBase,
      "/catalog/v1.0/getDisk",
      {
        catalogID: parentId === "0" ? "root" : parentId,
        startNumber: offset + 1,
        endNumber: offset + 100,
        sortDirection: 1,
        catalogSortType: 0,
        contentSortType: 0,
        filterType: 0,
        commonAccountInfo: { account: c.account, accountType: 1 },
      },
    );
    const disk = data.getDiskResult;
    if (
      !disk ||
      disk.nodeCount == null ||
      !Number.isSafeInteger(Number(disk.nodeCount)) ||
      Number(disk.nodeCount) < 0 ||
      (disk.catalogList != null && !Array.isArray(disk.catalogList)) ||
      (disk.contentList != null && !Array.isArray(disk.contentList))
    )
      throw new AppError(
        "INCOMPLETE_LIST",
        "移动云盘旧版个人盘目录结构不完整。",
      );
    const files = [
      ...(disk.catalogList ?? []).map((f: JsonObject) => ({
        fileId: f.catalogID,
        name: f.catalogName,
        type: "folder",
      })),
      ...(disk.contentList ?? []).map((f: JsonObject) => ({
        fileId: f.contentID,
        name: f.contentName,
        type: "file",
        size: f.contentSize,
      })),
    ].map((f) => modernFile(f, parentId));
    const count = Number(disk.nodeCount);
    if (files.length !== Math.min(100, Math.max(0, count - offset)))
      throw new AppError(
        "INCOMPLETE_LIST",
        "移动云盘未返回完整目录，已保留索引。",
      );
    return {
      files,
      next: offset + 100 >= count ? null : String(offset + 100),
    };
  }
  async list(account: Account, parentId: string) {
    const files: RemoteFile[] = [],
      seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const data = await this.listPage(account, parentId, cursor);
      for (const file of data.files) {
        if (seen.has(file.id))
          throw new AppError(
            "INCOMPLETE_LIST",
            "移动云盘目录在读取期间变化，请重试。",
          );
        seen.add(file.id);
        files.push(file);
      }
      if (!data.next) return files;
      cursor = data.next;
    }
    throw new AppError(
      "INCOMPLETE_LIST",
      "移动云盘目录超过读取保护上限，未视为完整目录。",
    );
  }
  async ensureFolder(account: Account, path: string) {
    const c = await this.context(account);
    let parentId = "0";
    for (const name of normalizedDirectory(path).split("/").filter(Boolean)) {
      const matches = (await this.list(account, parentId)).filter(
        (f) => f.name === name,
      );
      if (matches.length > 1 || matches.some((f) => !f.isDirectory))
        throw new AppError(
          "AMBIGUOUS_FOLDER",
          "移动云盘目录存在同名或文件冲突，请先在官网核对。",
        );
      if (matches.length) {
        parentId = matches[0].id;
        continue;
      }
      if (!c.modern)
        throw new AppError(
          "FILE_MANAGEMENT_UNSUPPORTED",
          "移动云盘旧版个人盘目前支持读取与同步，请在官网新增目录。",
        );
      const created = await this.request(
        account,
        c.personal,
        "/file/create",
        {
          parentFileId: parentId === "0" ? "/" : parentId,
          name,
          description: "",
          type: "folder",
          fileRenameMode: "force_rename",
        },
        true,
      );
      parentId = text(created.fileId, "新目录 ID");
      if (
        (created.name && created.name !== name) ||
        (created.fileName && created.fileName !== name)
      )
        throw new AppError(
          "FILES_CHANGED",
          "移动云盘新目录名称与预期不同，请核对远端结果。",
          true,
        );
    }
    return parentId;
  }
  async manageFile(account: Account, input: ProviderFileMutation) {
    const c = await this.context(account);
    if (!c.modern)
      throw new AppError(
        "FILE_MANAGEMENT_UNSUPPORTED",
        "移动云盘旧版个人盘目前仅支持目录读取和同步。",
      );
    if (input.action === "mkdir") {
      await this.ensureFolder(
        account,
        `${input.path.replace(/\/$/, "")}/${input.name}`,
      );
      return;
    }
    if (!input.file) throw new AppError("INVALID_SELECTION", "请先选择文件。");
    if (input.action === "rename")
      await this.request(
        account,
        c.personal,
        "/file/update",
        { fileId: input.file.id, name: input.name, description: "" },
        true,
      );
    else
      await this.request(
        account,
        c.personal,
        "/file/batchDelete",
        { fileIds: [input.file.id] },
        true,
      );
  }
  async fileCapabilities(account: Account) {
    const { modern } = await this.context(account);
    return { mkdir: modern, rename: modern, delete: modern, upload: modern };
  }
  async upload(account: Account, parentId: string, asset: UploadAsset) {
    const c = await this.context(account);
    if (!c.modern)
      throw new AppError(
        "UPLOAD_UNSUPPORTED",
        "移动云盘旧版个人盘暂不支持素材上传，请在官网操作。",
      );
    if (
      !asset.bytes.length ||
      asset.bytes.length > 20 * 1024 * 1024 ||
      /[\\/\x00-\x1f]/.test(asset.name)
    )
      throw new AppError(
        "INVALID_UPLOAD",
        "移动云盘素材应为20MB以内的非空文件，并使用有效名称。",
      );
    if (!this.transport.storageRequest)
      throw new AppError(
        "UPLOAD_UNSUPPORTED",
        "当前客户端未提供移动云盘上传传输，请应用后端更新。",
      );
    if ((await this.list(account, parentId)).some((f) => f.name === asset.name))
      throw new AppError(
        "UPLOAD_NAME_CONFLICT",
        "目标目录已有同名文件，请先选择替换或调整素材名称。",
      );
    const created = await this.request(
      account,
      c.personal,
      "/file/create",
      {
        parentFileId: parentId === "0" ? "/" : parentId,
        name: asset.name,
        type: "file",
        size: asset.bytes.length,
        fileRenameMode: "auto_rename",
        contentHash: createHash("sha1")
          .update(asset.bytes)
          .digest("hex")
          .toUpperCase(),
        contentHashAlgorithm: "SHA1",
        contentType: asset.mime,
        parallelUpload: false,
        partInfos: [
          {
            parallelHashCtx: { partOffset: 0 },
            partNumber: 1,
            partSize: asset.bytes.length,
          },
        ],
      },
      true,
    );
    const fileId = text(created.fileId, "上传文件 ID");
    if (
      (created.fileName && created.fileName !== asset.name) ||
      (created.name && created.name !== asset.name)
    )
      throw new AppError(
        "FILES_CHANGED",
        "移动云盘上传文件被改名，请核对远端结果。",
        true,
      );
    if (created.rapidUpload === true || created.exist === true) return;
    const uploadId = text(created.uploadId, "上传任务 ID");
    if (
      !Array.isArray(created.partInfos) ||
      created.partInfos.length !== 1 ||
      Number(created.partInfos[0].partNumber) !== 1
    )
      throw new AppError(
        "UPLOAD_SCHEMA",
        "移动云盘未返回有效上传分片，请核对远端结果。",
        true,
      );
    const address = storageUrl(
      "cmcc",
      text(created.partInfos[0].uploadUrl, "上传地址"),
    ).href;
    try {
      const response = await this.transport.storageRequest(
        account.id,
        address,
        {
          method: "PUT",
          credentials: "omit",
          redirect: "error",
          headers: { "Content-Type": asset.mime },
          body: new Uint8Array(asset.bytes),
        },
      );
      if (!response.ok) throw new Error("upload");
      await response.body?.cancel();
      await this.request(
        account,
        c.personal,
        "/file/complete",
        { fileId, uploadId },
        true,
      );
    } catch (cause) {
      if (cause instanceof AppError && cause.uncertain) throw cause;
      throw new AppError(
        "UNCERTAIN_REMOTE_RESULT",
        "移动云盘素材上传未确认完成，请核对远端文件，未自动重试。",
        true,
      );
    }
  }
  private unsupported(): never {
    throw new AppError(
      "CMCC_SHARE_UNSUPPORTED",
      "移动云盘分享与转存接口尚未完成核验，请先使用目录同步与本人文件管理；分享请在官网操作。",
    );
  }
  async inspect(_account: Account, _source: ShareInput) {
    return this.unsupported();
  }
  async transfer() {
    return this.unsupported();
  }
  async poll() {
    return this.unsupported();
  }
  async createShare() {
    return this.unsupported();
  }
  async findOwnShare() {
    return this.unsupported();
  }
  async recoverOwnShare() {
    return this.unsupported();
  }
  async verifyShare() {
    return this.unsupported();
  }
}

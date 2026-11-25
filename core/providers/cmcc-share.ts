import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type {
  Account,
  RemoteFile,
  ShareInput,
  ShareInspection,
} from "../../shared/types";
import type { JsonObject, OwnShare, ShareCreatedHandler } from "./provider";
import { membershipExpiry } from "./membership";
import { AppError } from "../errors";
import { newShareRequest, validateShareOptions } from "./share-options";
import type { ShareCreationOptions } from "../../shared/share-options";

// Public wire codec used by yun.139.com's shareweb client (ff71 module).
const wireKey = Buffer.from("PVGDwmcvfs1uV3d1");
export function encodeCmccShare(value: string, iv = randomBytes(16)) {
  const cipher = createCipheriv("aes-128-cbc", wireKey, iv);
  return Buffer.concat([
    iv,
    cipher.update(value, "utf8"),
    cipher.final(),
  ]).toString("base64");
}
export function decodeCmccShare(value: string): JsonObject {
  if (value.trim().startsWith("{")) return JSON.parse(value);
  const bytes = Buffer.from(value.trim(), "base64");
  if (bytes.length < 32 || (bytes.length - 16) % 16)
    throw new AppError("REMOTE_SCHEMA_CHANGED", "移动云盘分享响应格式变化。");
  const decipher = createDecipheriv(
    "aes-128-cbc",
    wireKey,
    bytes.subarray(0, 16),
  );
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(16)),
      decipher.final(),
    ]).toString("utf8"),
  );
}
type Context = { uid: string; account: string };
type Request = (
  account: Account,
  path: string,
  data: JsonObject,
  write?: boolean,
) => Promise<JsonObject>;
function validText(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    /[\x00-\x1f]/.test(value)
  )
    throw new AppError("REMOTE_SCHEMA_CHANGED", `移动云盘未返回有效${label}。`);
  return value;
}
function expiry(raw: unknown) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const m =
    typeof raw === "string" &&
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw);
  const parsed = m
    ? membershipExpiry(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`)
    : null;
  if (
    !parsed ||
    (m && (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59))
  )
    throw new AppError(
      "REMOTE_SCHEMA_CHANGED",
      "移动云盘分享到期时间格式变化。",
    );
  return parsed;
}
/** Share payloads and task requests are separate from personal-directory APIs. */
export class CmccShares {
  constructor(
    private context: (a: Account) => Promise<Context>,
    private request: Request,
    private history: Request,
  ) {}
  private async general(account: Account, source: ShareInput) {
    const c = await this.context(account);
    const data = await this.request(account, "/IOutLink/getOutLinkGeneral", {
      getOutLinkGeneralReq: { linkID: source.shareKey, isPasswd: 1 },
      commonAccountInfo: { account: c.account, accountType: 1 },
    });
    const rows = data.getOutLinkGeneralResp?.outLinkGeneral;
    if (
      !Array.isArray(rows) ||
      rows.length !== 1 ||
      String(rows[0].linkID) !== source.shareKey
    )
      throw new AppError(
        "SHARE_EXPIRED",
        "移动云盘分享不存在、已失效或未返回完整信息。",
      );
    return { row: rows[0], needPassword: Number(data.isPasswd) === 1 };
  }
  async inspect(
    account: Account,
    source: ShareInput,
    parentId = "0",
    page = 1,
  ): Promise<ShareInspection> {
    if (!Number.isInteger(page) || page < 1 || page > 100)
      throw new AppError("INVALID_PAGE", "分享页码无效。");
    const c = await this.context(account);
    const data = await this.request(account, "/IOutLink/getOutLinkInfoV6", {
      getOutLinkInfoReq: {
        account: c.account,
        linkID: source.shareKey,
        passwd: source.code,
        caSrt: 0,
        coSrt: 0,
        srtDr: 1,
        bNum: (page - 1) * 200 + 1,
        pCaID: parentId === "0" ? "root" : parentId,
        eNum: page * 200,
      },
      commonAccountInfo: { account: c.account, accountType: 1 },
    });
    const rows: RemoteFile[] = [];
    for (const [field, isDirectory] of [
      ["caLst", true],
      ["coLst", false],
    ] as const) {
      if (data[field] != null && !Array.isArray(data[field]))
        throw new AppError(
          "REMOTE_SCHEMA_CHANGED",
          "移动云盘分享文件列表结构变化。",
        );
      for (const row of data[field] ?? []) {
        const id = validText(row.path, "分享文件路径"),
          name = validText(isDirectory ? row.caName : row.coName, "文件名称");
        const size = isDirectory ? null : Number(row.coSize);
        if (
          !isDirectory &&
          (row.coSize == null || !Number.isSafeInteger(size) || size! < 0)
        )
          throw new AppError(
            "REMOTE_SCHEMA_CHANGED",
            "移动云盘分享文件大小无效。",
          );
        rows.push({ id, path: id, name, isDirectory, size, parentId });
      }
    }
    const total = Number(data.nodNum);
    if (
      data.nodNum == null ||
      !Number.isSafeInteger(total) ||
      total < 0 ||
      (total < (page - 1) * 200 + rows.length && rows.length > 0) ||
      new Set(rows.map((f) => f.id)).size !== rows.length ||
      (!rows.length && (page - 1) * 200 < total)
    )
      throw new AppError(
        "INCOMPLETE_LIST",
        "移动云盘分享分页不完整，未继续转存。",
      );
    return {
      shareKey: source.shareKey,
      title: String(data.lkName ?? ""),
      files: rows,
      hasMore: (page - 1) * 200 + rows.length < total,
      parentId,
      page,
    };
  }
  async transfer(
    account: Account,
    source: ShareInput,
    files: RemoteFile[],
    folderId: string,
    folderName = "全部",
  ) {
    const c = await this.context(account),
      g = await this.general(account, source);
    if (!files.length)
      throw new AppError("EMPTY_SELECTION", "请选择需要转存的文件。");
    const data = await this.request(
      account,
      "/IBatchOprTask/createOuterLinkBatchOprTask",
      {
        createOuterLinkBatchOprTaskReq: {
          msisdn: c.account,
          ownerAccount: validText(g.row.ownerUserId, "分享归属"),
          taskType: 1,
          linkID: source.shareKey,
          needPassword: g.needPassword,
          taskInfo: {
            linkID: source.shareKey,
            contentInfoList: files
              .filter((f) => !f.isDirectory)
              .map((f) => f.path ?? f.id),
            catalogInfoList: files
              .filter((f) => f.isDirectory)
              .map((f) => f.path ?? f.id),
            newCatalogID: folderId,
            newCatalogName: folderName,
            needPassword: g.needPassword,
          },
        },
        commonAccountInfo: { account: c.account, accountType: 1 },
      },
      true,
    );
    const taskId =
      data.taskID ?? data.taskId ?? data.createBatchOprTaskRes?.taskID;
    if (!taskId)
      throw new AppError(
        "UNCERTAIN_REMOTE_RESULT",
        "移动云盘未返回转存任务ID，请核对目标目录，未自动重试。",
        true,
      );
    return { taskId: String(taskId) };
  }
  async poll(account: Account, taskId: string) {
    const c = await this.context(account);
    const data = await this.request(
      account,
      "/IBatchOprTask/queryBatchOprTaskDetail",
      {
        queryBatchOprTaskDetailReq: {
          taskID: taskId,
          msisdn: c.account,
          commonAccountInfo: { account: c.account, accountType: 1 },
        },
      },
    );
    const task =
      data.queryBatchOprTaskDetailRes?.batchOprTask ?? data.batchOprTask;
    if (!task || ![0, 1, 2, 3, 4, 5].includes(Number(task.taskStatus)))
      throw new AppError(
        "REMOTE_SCHEMA_CHANGED",
        "移动云盘转存任务状态不明。",
        true,
      );
    if (
      [3, 4].includes(Number(task.taskStatus)) ||
      (Number(task.taskStatus) === 2 &&
        (Number(task.taskResultCode) !== 1 ||
          (task.resultCode != null && Number(task.resultCode) !== 0)))
    )
      throw new AppError(
        "PARTIAL_SUCCESS",
        "移动云盘转存未全部完成，请核对目标文件。",
        true,
      );
    return Number(task.taskStatus) === 2;
  }
  private source(shareId: string, code = ""): ShareInput {
    return {
      provider: "cmcc",
      shareKey: shareId,
      url: `https://yun.139.com/shareweb/#/w/i/${shareId}`,
      code,
    };
  }
  async verify(
    account: Account,
    shareId: string,
    files: RemoteFile[],
    code = "",
  ) {
    const c = await this.context(account),
      source = this.source(shareId, code),
      g = await this.general(account, source);
    if (String(g.row.ownerUserId) !== c.uid) return false;
    const actual: RemoteFile[] = [];
    for (let page = 1; page <= 100; page++) {
      const part = await this.inspect(account, source, "0", page);
      actual.push(...part.files);
      if (!part.hasMore) break;
      if (page === 100)
        throw new AppError("INCOMPLETE_LIST", "本人分享超过验证上限。");
    }
    return (
      actual.length === files.length &&
      files.every((f) =>
        actual.some(
          (a) =>
            a.id.split("/").at(-1) === f.id.split("/").at(-1) &&
            a.name === f.name &&
            a.isDirectory === f.isDirectory &&
            (f.isDirectory || a.size === f.size),
        ),
      )
    );
  }
  async create(
    account: Account,
    files: RemoteFile[],
    title: string,
    options: ShareCreationOptions = { expiresInDays: 0 },
    onCreated?: ShareCreatedHandler,
  ): Promise<OwnShare> {
    const settings = validateShareOptions("cmcc", options),
      c = await this.context(account);
    const data = await newShareRequest(() =>
      this.request(
        account,
        "/IOutLink/getOutLink",
        {
          getOutLinkReq: {
            linkType: 0,
            userDomainId: c.uid,
            subLinkType: 0,
            encrypt: 1,
            coIDLst: {
              item: files.filter((f) => !f.isDirectory).map((f) => f.id),
            },
            caIDLst: {
              item: files.filter((f) => f.isDirectory).map((f) => f.id),
            },
            pubType: 1,
            dedicatedName: title.slice(0, 60),
            periodUnit: 1,
            viewerLst: {},
            extInfo: { isWatermark: 0, shareChannel: "3001" },
            ...(settings.expiresInDays
              ? { period: settings.expiresInDays }
              : {}),
            commonAccountInfo: { account: c.account, accountType: 1 },
          },
        },
        true,
      ),
    );
    const row = (data.getOutLinkResSet ??
      data.getOutLinkRes?.getOutLinkResSet)?.[0];
    const id = validText(row?.linkID, "本人分享ID"),
      code = String(row.passwd ?? "");
    await onCreated?.({ id, url: this.source(id).url, code, ownerUid: c.uid });
    if (!(await this.verify(account, id, files, code)))
      throw new AppError(
        "OWNERSHIP_UNCONFIRMED",
        "移动云盘已响应分享，归属与文件未核验通过，未重复创建。",
        true,
      );
    const g = await this.general(account, this.source(id, code));
    return {
      id,
      url: this.source(id).url,
      code,
      ownerUid: c.uid,
      expiresAt: expiry(g.row.expireTime),
    };
  }
  async find(account: Account, files: RemoteFile[]): Promise<OwnShare | null> {
    const c = await this.context(account);
    for (let page = 0; page < 20; page++) {
      const data = await this.history(account, "", {
        getOutLinkLstReq: {
          needSetAccount: true,
          srt: 1,
          srtDr: 0,
          bNum: page * 100 + 1,
          eNum: (page + 1) * 100,
          qryType: 1,
          commonAccountInfo: { account: c.account, accountType: 1 },
        },
      });
      const list = data.getOutLinkLstRes;
      if (
        !list ||
        list.count == null ||
        !Number.isSafeInteger(Number(list.count)) ||
        Number(list.count) < 0 ||
        (list.outLinks != null && !Array.isArray(list.outLinks))
      )
        throw new AppError(
          "REMOTE_SCHEMA_CHANGED",
          "移动云盘本人分享历史未完整返回。",
        );
      if (list.outLinks == null && Number(list.count) === 0) return null;
      if (!list.outLinks?.length && Number(list.count) > page * 100)
        throw new AppError("INCOMPLETE_LIST", "移动云盘分享历史分页缺失。");
      for (const row of list.outLinks) {
        if (Number(row.isOutLinkInvalid) !== 0) continue;
        const id = validText(row.linkID, "分享ID"),
          code = String(row.passwd ?? "");
        if (await this.verify(account, id, files, code))
          return {
            id,
            url: this.source(id).url,
            code,
            ownerUid: c.uid,
            expiresAt: expiry(row.expireTime),
          };
      }
      if ((page + 1) * 100 >= Number(list.count)) return null;
    }
    throw new AppError(
      "INCOMPLETE_LIST",
      "本人分享历史超过读取上限，未创建重复分享。",
    );
  }
}

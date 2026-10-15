import type {
  Account,
  Provider,
  RemoteFile,
  ShareInput,
  ShareInspection,
} from "../../shared/types";
import { AppError } from "../errors";
export type JsonObject = Record<string, any>;
export interface ProviderTransport {
  principalId?(accountId: string, provider: Provider): Promise<string | null>;
  json(accountId: string, url: string, init?: RequestInit): Promise<JsonObject>;
  text(accountId: string, url: string, init?: RequestInit): Promise<string>;
  setCookie?(
    accountId: string,
    url: string,
    name: string,
    value: string,
  ): Promise<void>;
}
export interface Identity {
  uid: string;
  nickname: string;
}
export interface OwnShare {
  id: string;
  url: string;
  code: string;
  ownerUid: string;
}
export interface TransferResult {
  taskId: string | null;
}
export interface DriveProvider {
  readonly id: Provider;
  identity(account: Account): Promise<Identity>;
  inspect(
    account: Account,
    source: ShareInput,
    parentId?: string,
    page?: number,
  ): Promise<ShareInspection>;
  list(account: Account, parentId: string): Promise<RemoteFile[]>;
  ensureFolder(account: Account, path: string): Promise<string>;
  transfer(
    account: Account,
    source: ShareInput,
    selected: RemoteFile[],
    folderId: string,
    path: string,
  ): Promise<TransferResult>;
  poll(account: Account, taskId: string): Promise<boolean>;
  createShare(
    account: Account,
    files: RemoteFile[],
    title: string,
  ): Promise<OwnShare>;
  findOwnShare(account: Account, files: RemoteFile[]): Promise<OwnShare | null>;
  recoverOwnShare(
    account: Account,
    source: ShareInput,
    files: RemoteFile[],
  ): Promise<OwnShare>;
  verifyShare(
    account: Account,
    shareId: string,
    files: RemoteFile[],
  ): Promise<boolean>;
}
export function normalizeRemoteFile(
  row: JsonObject,
  provider: Provider,
  parentId: string,
): RemoteFile {
  const fileId = String(
    provider === "quark" ? (row.fid ?? "") : (row.fs_id ?? ""),
  );
  const name = String(
    provider === "quark" ? (row.file_name ?? "") : (row.server_filename ?? ""),
  );
  if (!fileId || !name)
    throw new AppError(
      "REMOTE_SCHEMA_CHANGED",
      "网盘返回的文件结构已变化，未继续转存。",
    );
  return {
    id: fileId,
    name,
    isDirectory: [true, 1, "1"].includes(
      provider === "quark" ? row.dir : row.isdir,
    ),
    size: row.size == null ? null : Number(row.size),
    parentId,
    path: typeof row.path === "string" ? row.path : undefined,
  };
}
export function assertManifest(
  expected: RemoteFile[],
  actual: RemoteFile[],
): void {
  if (expected.length !== actual.length)
    throw new AppError(
      "PARTIAL_SUCCESS",
      `目标目录有 ${actual.length} 项，预期 ${expected.length} 项。请核对远端结果。`,
    );
  const used = new Set<string>();
  for (const file of expected) {
    const match = actual.find(
      (a) =>
        !used.has(a.id) &&
        a.name === file.name &&
        a.isDirectory === file.isDirectory &&
        (file.isDirectory || file.size == null || a.size === file.size),
    );
    if (!match)
      throw new AppError(
        "PARTIAL_SUCCESS",
        "目标文件名称、类型或大小不一致，不能确认完整转存。",
      );
    used.add(match.id);
  }
}
export function normalizedDirectory(input: string): string {
  const segments = input.replace(/\\/g, "/").split("/").filter(Boolean);
  if (
    segments.some(
      (s) => s === "." || s === ".." || /[\x00-\x1f:*?"<>|]/.test(s),
    ) ||
    input.length > 500
  )
    throw new AppError("INVALID_DIRECTORY", "网盘目录包含不支持的字符。");
  return "/" + segments.join("/");
}

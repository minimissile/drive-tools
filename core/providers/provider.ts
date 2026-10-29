import type {
  Account,
  Provider,
  RemoteFile,
  ShareInput,
  ShareInspection,
} from "../../shared/types";
import { AppError } from "../errors";
import type { DriveCapacity } from "../../shared/drive-capacity";
import type { ProviderShareStatsPage } from "../../shared/share-statistics";
import type { ShareCreationOptions } from "../../shared/share-options";
export type JsonObject = Record<string, any>;
export interface ProviderTransport {
  ownShareCode?(accountId: string, shareId: string): Promise<string | null>;
  authHeaders?(
    accountId: string,
    refresh?: boolean,
  ): Promise<Record<string, string>>;
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
  /** Present only when the provider returned an actual expiry; null is permanent. */
  expiresAt?: string | null;
}
/** May first report an ID with empty url, then report the complete returned link. */
export type ShareCreatedHandler = (share: OwnShare) => Promise<void>;
export interface TransferResult {
  taskId: string | null;
}
export interface DriveProvider {
  manageFile?(
    account: Account,
    input: import("../../shared/drive-files").ProviderFileMutation,
  ): Promise<void>;
  manage?(
    account: Account,
    action: "mkdir" | "rename" | "delete",
    path: string,
    name?: string,
  ): Promise<void>;
  upload?(
    account: Account,
    parentId: string,
    asset: import("./small-upload").UploadAsset,
  ): Promise<void>;
  readonly id: Provider;
  capacity?(account: Account): Promise<DriveCapacity>;
  shareStatistics?(
    account: Account,
    page: number,
    cursor?: string,
  ): Promise<ProviderShareStatsPage>;
  identity(account: Account): Promise<Identity>;
  inspect(
    account: Account,
    source: ShareInput,
    parentId?: string,
    page?: number,
    cursor?: string,
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
  /** Always creates a new link with these settings; does not reuse an old share. */
  createShareWithOptions?(
    account: Account,
    files: RemoteFile[],
    title: string,
    options: ShareCreationOptions,
    onCreated?: ShareCreatedHandler,
  ): Promise<OwnShare>;
  verifyShareWithOptions?(
    account: Account,
    shareId: string,
    files: RemoteFile[],
    options: ShareCreationOptions,
    code?: string,
  ): Promise<boolean>;
  readCreatedShare?(
    account: Account,
    shareId: string,
    options: ShareCreationOptions,
    code?: string,
  ): Promise<OwnShare | null>;
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
    code?: string,
  ): Promise<boolean>;
}
export function normalizeRemoteFile(
  row: JsonObject,
  provider: Provider,
  parentId: string,
): RemoteFile {
  const cloud = provider === "quark" || provider === "uc";
  const fileId = String(
    cloud
      ? (row.fid ?? "")
      : provider === "xunlei" || provider === "pikpak"
        ? (row.id ?? "")
        : (row.fs_id ?? ""),
  );
  const name = String(
    cloud
      ? (row.file_name ?? "")
      : provider === "xunlei" || provider === "pikpak"
        ? (row.name ?? "")
        : (row.server_filename ?? ""),
  );
  if (!fileId || !name)
    throw new AppError(
      "REMOTE_SCHEMA_CHANGED",
      "网盘返回的文件结构已变化，未继续转存。",
    );
  return {
    id: fileId,
    name,
    isDirectory:
      provider === "xunlei" || provider === "pikpak"
        ? row.kind === "drive#folder"
        : [true, 1, "1"].includes(cloud ? row.dir : row.isdir),
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

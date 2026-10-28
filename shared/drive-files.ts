import type { Provider, RemoteFile } from "./types";

export interface ProviderFileMutation {
  action: "mkdir" | "rename" | "delete";
  parentId: string;
  path: string;
  file?: RemoteFile;
  name?: string;
}
export interface DriveDirectory {
  accountId: string;
  provider: Provider;
  path: string;
  folderId: string;
  files: RemoteFile[];
  readAt: string;
  capabilities: { rename: boolean; delete: boolean; upload: boolean };
  pending: DriveWriteReceipt | null;
}
export interface DriveCopyLocation {
  copyId: string;
  /** The real parent directory containing these exact resource file IDs. */
  directory: DriveDirectory;
  files: RemoteFile[];
}
export interface DriveWriteReceipt {
  id: string;
  action: "mkdir" | "rename" | "delete" | "upload" | "replace";
  state: "pending" | "success" | "uncertain";
  message: string;
  backupName?: string;
}
export interface DriveWriteInput {
  operationId: string;
  accountId: string;
  path: string;
  action: "mkdir" | "rename" | "delete";
  files: RemoteFile[];
  name?: string;
  confirmed: true;
}
export interface DriveMaterialInput {
  operationId: string;
  accountId: string;
  path: string;
  materialId: string;
  replace?: RemoteFile;
  confirmed: true;
}
export interface DriveFilesContract {
  "drive.locateCopy": {
    args: { copyId: string };
    value: DriveCopyLocation;
  };
  "drive.adoptCopy": {
    args: {
      copyId: string;
      accountId: string;
      path: string;
      files: RemoteFile[];
      confirmed: true;
    };
    value: boolean;
  };
  "drive.directory": {
    args: { accountId: string; path: string };
    value: DriveDirectory;
  };
  "drive.write": { args: DriveWriteInput; value: DriveWriteReceipt };
  "drive.material": { args: DriveMaterialInput; value: DriveWriteReceipt };
  "drive.recheck": {
    args: { accountId: string; path: string };
    value: DriveWriteReceipt | null;
  };
  "drive.resolve": {
    args: {
      accountId: string;
      path: string;
      operationId: string;
      confirmed: true;
    };
    value: boolean;
  };
}

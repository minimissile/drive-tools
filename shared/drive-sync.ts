import type { RemoteFile } from "./types";

export interface DriveListPage {
  files: RemoteFile[];
  next: string | null;
}
export type DriveSyncStatus =
  | "running"
  | "pausing"
  | "paused"
  | "interrupted"
  | "partial"
  | "completed"
  | "blocked";
export interface DriveSyncAutoRegister {
  enabled: boolean;
  added: number;
  skipped: number;
  requiresRescan?: true;
}
export interface DriveSyncRun {
  id: string;
  accountId: string;
  ownerUid: string;
  environment: string;
  status: DriveSyncStatus;
  files: number;
  folders: number;
  pending: number;
  failed: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  autoRegister?: DriveSyncAutoRegister;
}
export interface DriveSyncLog {
  id: number;
  at: string;
  level: "info" | "warning" | "error";
  message: string;
}
export type DriveIndexState = "recorded" | "unrecorded" | "review";
export interface DriveIndexEntry extends RemoteFile {
  path: string;
  observedAt: string;
  missing: boolean;
  state: DriveIndexState;
  resources: { id: string; title: string; copyId: string }[];
}
export interface DriveIndexQuery {
  accountId: string;
  parentId?: string;
  search?: string;
  state?: "all" | DriveIndexState;
  page?: number;
  foldersOnly?: boolean;
}
export interface DriveIndexPage {
  items: DriveIndexEntry[];
  total: number;
  page: number;
  pageSize: number;
  ownerUid: string | null;
  run: DriveSyncRun | null;
  lastCompleteAt: string | null;
  breadcrumbs: { id: string; name: string }[];
  autoRegisterSupported?: boolean;
  autoRegisterIncludesFolders?: true;
}
export interface DriveRegistration {
  entries: { fileId: string; title: string }[];
  accountId: string;
}
export interface DriveSyncContract {
  "driveSync.index": { args: DriveIndexQuery; value: DriveIndexPage };
  "driveSync.logs": { args: { accountId: string }; value: DriveSyncLog[] };
  "driveSync.start": {
    args: { accountId: string; restart?: boolean; autoRegister?: boolean };
    value: DriveSyncRun;
  };
  "driveSync.pause": { args: { accountId: string }; value: DriveSyncRun };
  "driveSync.resume": {
    args: { accountId: string; autoRegister?: boolean };
    value: DriveSyncRun;
  };
  "driveSync.register": {
    args: DriveRegistration;
    value: { fileId: string; resourceId?: string; error?: string }[];
  };
}
export const driveSyncActive = (run: DriveSyncRun | null | undefined) =>
  !!run && ["running", "pausing"].includes(run.status);

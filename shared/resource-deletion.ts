import type { DriveWriteReceipt } from "./drive-files";
import type { RemoteFile } from "./types";

export interface ResourceDeleteCopy {
  copyId: string;
  accountId: string;
  accountAlias: string;
  directory: string;
  files: RemoteFile[];
  canDeleteRemote: boolean;
  reason: string;
}

export interface ResourceDeletePreview {
  token: string;
  resourceId: string;
  title: string;
  copies: ResourceDeleteCopy[];
  draftCount: number;
  blockers: string[];
  remoteBlockers: string[];
  pending: ResourceDeleteResult | null;
}

export interface ResourceDeleteResult {
  operationId: string;
  resourceId: string;
  mode: "local" | "remote";
  state: "pending" | "uncertain" | "deleted";
  message: string;
  copies: {
    copyId: string;
    accountAlias: string;
    directory: string;
    state: "waiting" | "uncertain" | "success";
    receipt: DriveWriteReceipt | null;
  }[];
}

type Contract<A, V> = { args: A; value: V };
export interface ResourceDeletionContract {
  "resource.deletePreview": Contract<
    { resourceId: string },
    ResourceDeletePreview
  >;
  "resource.remove": Contract<
    { token: string; mode: "local" | "remote"; confirmed: true },
    ResourceDeleteResult
  >;
  "resource.deleteRecheck": Contract<
    { operationId: string },
    ResourceDeleteResult
  >;
}

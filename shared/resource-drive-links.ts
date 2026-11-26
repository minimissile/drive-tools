import type { Provider, RemoteFile } from "./types";

export interface ResourceDriveLink {
  id: string;
  provider: Provider;
  url: string;
  needsCode: boolean;
  codeAvailable: boolean;
  copyId: string | null;
  status: string | null;
  shareUrl: string | null;
  jobId: string | null;
}

export interface ResourceDriveTransferInput {
  resourceId: string;
  text: string;
  accountId: string;
  directory: string;
  selectedFiles: RemoteFile[];
  replaceId?: string;
}

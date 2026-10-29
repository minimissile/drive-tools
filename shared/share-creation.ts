import type {
  ProviderShareCreationCapabilities,
  ShareCreationOptions,
} from "./share-options";
import type { Provider } from "./types";

export interface ShareCreationReceipt {
  operationId: string;
  copyId: string;
  state: "success" | "uncertain" | "failed";
  url?: string;
  code?: string;
  expiresAt?: string | null;
  expiresInDays: number;
  createdAt: string;
  message: string;
  /** An ID-only response also counts; it cannot be confirmed as not created. */
  hasReturnedShare?: boolean;
  resolution?: "not_created" | "handled";
}

export interface ShareCreationContext {
  copyId: string;
  title: string;
  provider: Provider;
  accountAlias: string;
  capabilities: ProviderShareCreationCapabilities;
  /** Local eligibility only; final identity and files are rechecked on creation. */
  issue: string | null;
  latest: ShareCreationReceipt | null;
}

export interface ShareCreateInput extends ShareCreationOptions {
  operationId: string;
  copyId: string;
}

export interface ShareCreationContract {
  "share.creationOptions": {
    args: { copyId: string };
    value: ShareCreationContext;
  };
  "share.creationResult": {
    args: { operationId: string };
    value: ShareCreationReceipt | null;
  };
  "share.create": { args: ShareCreateInput; value: ShareCreationReceipt };
  "share.recheckCreation": {
    args: { operationId: string };
    value: ShareCreationReceipt;
  };
  "share.resolveCreation": {
    args: { operationId: string; outcome: "not_created" | "handled" };
    value: ShareCreationReceipt;
  };
}

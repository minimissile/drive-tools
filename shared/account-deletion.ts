import type { Provider } from "./types";

export interface AccountDeletePreview {
  token: string;
  accountId: string;
  alias: string;
  provider: Provider;
  copyCount: number;
  draftCount: number;
  resources: {
    id: string;
    title: string;
    removeResource: boolean;
    copyCount: number;
  }[];
  blockers: string[];
}
export interface AccountDeleteResult {
  accountId: string;
  provider: Provider;
  replacementAccountId: string | null;
  resourceCount: number;
  copyCount: number;
  removedResourceIds: string[];
  removedCopyIds: string[];
  message: string;
}
export interface AccountDeletionContract {
  "account.deletePreview": {
    args: { id: string };
    value: AccountDeletePreview;
  };
  "account.remove": { args: { token: string }; value: AccountDeleteResult };
}

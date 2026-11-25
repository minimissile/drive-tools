export interface SavedSharePassphrase {
  /** Exact official command, including the delimiters required by the App. */
  text: string;
  savedAt: string;
}
export interface SharePassphraseTarget {
  copyId: string;
  /** Independent shares must never overwrite the resource's saved share. */
  operationId?: string;
}
export interface SharePassphraseContract {
  "share.passphrase": {
    args: SharePassphraseTarget;
    value: SavedSharePassphrase | null;
  };
  "share.savePassphrase": {
    args: SharePassphraseTarget & { text: string };
    value: SavedSharePassphrase;
  };
  "share.copyPassphrase": {
    args: SharePassphraseTarget;
    value: { text: string };
  };
}

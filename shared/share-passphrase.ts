export interface SavedSharePassphrase {
  /** Exact official command, including the delimiters required by the App. */
  text: string;
  /** Empty text with an issue means the link exists but command acquisition failed. */
  issue?: string;
  savedAt: string;
}
export interface SharePassphraseTarget {
  copyId: string;
  /** Independent shares must never overwrite the resource's saved share. */
  operationId?: string;
}
export interface SharePassphraseContract {
  "share.fetchPassphrase": {
    args: SharePassphraseTarget;
    value: SavedSharePassphrase;
  };
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

import type { Database } from "../database";
import type { EnvironmentStamp } from "../../shared/browser-environments";
import type { TiebaPublishingDraft } from "../../shared/tieba-publishing";
export const tiebaPublishingIndexKey = "tieba-publishing:index:v1";
const key = (id: string) => `tieba-publishing:draft:v1:${id}`;
export interface TiebaPublishingRecord extends TiebaPublishingDraft {
  stamp: EnvironmentStamp;
  payloadHash: string;
  lastMutationAt: string | null;
}
export class TiebaPublishingStore {
  constructor(private db: Database) {}
  drafts() {
    return this.db
      .setting<string[]>(tiebaPublishingIndexKey, [])
      .flatMap((id) => {
        const draft = this.draft(id);
        return draft ? [draft] : [];
      });
  }
  draft(id: string) {
    return this.db.setting<TiebaPublishingRecord | null>(key(id), null);
  }
  save(draft: TiebaPublishingRecord) {
    this.db.setSetting(key(draft.id), draft);
    const ids = this.db.setting<string[]>(tiebaPublishingIndexKey, []);
    if (!ids.includes(draft.id))
      this.db.setSetting(tiebaPublishingIndexKey, [draft.id, ...ids]);
  }
}
/** Called on a backup copy; never grants a stored ready draft renewed consent. */
export function stopTiebaPublishingForBackup(db: Database) {
  const store = new TiebaPublishingStore(db);
  for (const draft of store.drafts()) {
    if (!["ready", "submitting"].includes(draft.status)) continue;
    draft.status = draft.submittedAt ? "uncertain" : "draft";
    draft.version++;
    draft.message = draft.submittedAt
      ? "原发布结果待核对，不会重新提交。"
      : "备份不继承发布确认，请重新保存检查。";
    store.save(draft);
  }
}
/** Shared write gate: other Tieba domains must also respect resource-posting checkpoints. */
export function tiebaPublishingWriteState(
  db: Database,
  uid: string,
  excludeId = "",
) {
  const drafts = new TiebaPublishingStore(db)
    .drafts()
    .filter((draft) => draft.id !== excludeId);
  return {
    uncertain: drafts.some(
      (draft) =>
        draft.uid === uid &&
        ["submitting", "uncertain", "pending_review"].includes(draft.status),
    ),
    lastMutationAt:
      drafts
        .flatMap((draft) => draft.lastMutationAt ?? draft.submittedAt ?? [])
        .sort()
        .at(-1) ?? null,
  };
}

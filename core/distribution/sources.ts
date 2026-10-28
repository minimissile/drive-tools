import type { Database } from "../database";

export interface ShareSource {
  sourceRow: number;
  shareRecordId: string;
  resourceId: string;
  copyId: string;
  splitItemId: string | null;
  title: string;
  provider: string;
  shareUrl: string | null;
  shareVersion: number;
  eligible: number;
}
const copyEligible = `c.status='ready' AND c.verified_at IS NOT NULL AND c.share_verified_at IS NOT NULL
  AND c.share_url IS NOT NULL AND c.share_id IS NOT NULL AND a.enabled=1 AND a.uid IS NOT NULL
  AND c.owner_uid=a.uid AND c.share_owner_uid=a.uid
  AND (r.source_kind='owned' OR c.share_url!=r.source_url)`;
const splitEligible = `s.status='ready' AND s.verified_at IS NOT NULL AND s.share_url IS NOT NULL AND s.share_id IS NOT NULL
  AND c.status='ready' AND c.verified_at IS NOT NULL AND a.enabled=1 AND a.uid IS NOT NULL
  AND c.owner_uid=a.uid AND s.owner_uid=a.uid AND s.share_url!=r.source_url`;
const joins =
  "JOIN resources r ON r.id=c.resource_id JOIN accounts a ON a.id=c.account_id";

/** Indexed rowid keyset, not OFFSET or renderer snapshots. At most 250 rows are held. */
export function shareSourcePage(
  db: Database,
  kind: "copy" | "split",
  after: number,
  ceiling: number,
) {
  return kind === "copy"
    ? db.all<ShareSource>(
        `SELECT c.rowid sourceRow,'copy:'||c.id shareRecordId,c.resource_id resourceId,c.id copyId,
      NULL splitItemId,r.title title,r.provider provider,c.share_url shareUrl,c.share_version shareVersion,
      (${copyEligible}) eligible FROM copies c ${joins} WHERE c.rowid>? AND c.rowid<=? ORDER BY c.rowid LIMIT 250`,
        after,
        ceiling,
      )
    : db.all<ShareSource>(
        `SELECT s.rowid sourceRow,'split:'||s.id shareRecordId,c.resource_id resourceId,c.id copyId,
      s.id splitItemId,COALESCE(json_extract(s.file,'$.name'),r.title) title,r.provider provider,
      s.share_url shareUrl,s.share_version shareVersion,(${splitEligible}) eligible
      FROM split_items s JOIN copies c ON c.id=s.copy_id ${joins} WHERE s.rowid>? AND s.rowid<=? ORDER BY s.rowid LIMIT 250`,
        after,
        ceiling,
      );
}
export function shareSource(
  db: Database,
  recordId: string,
): ShareSource | undefined {
  const kind = recordId.startsWith("split:") ? "split" : "copy",
    record = recordId.slice(recordId.indexOf(":") + 1);
  const row = db.get<{ rowid: number }>(
    `SELECT rowid FROM ${kind === "copy" ? "copies" : "split_items"} WHERE id=?`,
    record,
  );
  return row
    ? shareSourcePage(db, kind, row.rowid - 1, row.rowid)[0]
    : undefined;
}
export function libraryShareCounts(db: Database) {
  const readySql = `SELECT c.resource_id resource_id FROM copies c ${joins} WHERE ${copyEligible}
    UNION ALL SELECT c.resource_id FROM split_items s JOIN copies c ON c.id=s.copy_id ${joins} WHERE ${splitEligible}`;
  return db.get<{
    resources: number;
    readyShares: number;
    unreadyResources: number;
  }>(`WITH ready AS (${readySql})
    SELECT (SELECT COUNT(*) FROM resources) resources,(SELECT COUNT(*) FROM ready) readyShares,
    ((SELECT COUNT(*) FROM resources)-(SELECT COUNT(DISTINCT resource_id) FROM ready)) unreadyResources`)!;
}

import type { DatabaseSync } from "node:sqlite";
import {
  tiebaOldResourceSources,
  type TiebaOldResourceEvidence,
} from "../../shared/tieba-resource-discovery";
import type { Database } from "../database";
import { tiebaBodyDriveLinks } from "../tieba-post-stats/links";
import type { OldTrafficReading } from "./old-traffic";

type Source = (typeof tiebaOldResourceSources)[number];
type Segment = { source: Source; text: string; hrefs?: string[] };
const keywords = [
  "网盘",
  "云盘",
  "资源",
  "链接",
  "百度",
  "夸克",
  "提取码",
  "口令",
  "//pan.",
] as const;
type Store = Pick<Database, "db" | "all">;

export function oldResourceEvidence(
  segments: Segment[],
): TiebaOldResourceEvidence {
  const linkSources = new Set<Source>();
  const matched = new Set<string>();
  for (const { source, text, hrefs } of segments) {
    const normalized = text.normalize("NFKC");
    if (tiebaBodyDriveLinks(normalized, hrefs).length) linkSources.add(source);
    for (const word of keywords) {
      if (normalized.includes(word)) matched.add(word);
    }
  }
  return {
    linkSources: tiebaOldResourceSources.filter((source) =>
      linkSources.has(source),
    ),
    keywords: keywords.filter((word) => matched.has(word)),
  };
}

export function isOldResource(evidence: TiebaOldResourceEvidence) {
  return evidence.linkSources.length > 0 || evidence.keywords.length > 0;
}

export function migrateTiebaOldResourceAdmission(db: DatabaseSync) {
  const columns = db
    .prepare("PRAGMA table_info(tieba_discovery_old_resource)")
    .all();
  if (!columns.some(({ name }) => name === "admitted")) {
    db.exec(
      "ALTER TABLE tieba_discovery_old_resource ADD COLUMN admitted INTEGER NOT NULL DEFAULT 0",
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS tieba_discovery_old_resource_queue (
      thread_id TEXT PRIMARY KEY,
      reading TEXT NOT NULL,
      next_check_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS tieba_discovery_old_resource_queue_due
      ON tieba_discovery_old_resource_queue(next_check_at);
    CREATE TABLE IF NOT EXISTS tieba_discovery_old_resource_deleted (thread_id TEXT PRIMARY KEY);
  `);
  db.exec(
    "UPDATE tieba_discovery_old_resource SET checked_at = NULL, retry_at = NULL WHERE admitted = 0",
  );
}

export function migrateTiebaOldResources(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tieba_discovery_old_resource (
      thread_id TEXT PRIMARY KEY REFERENCES tieba_discovery_old_traffic(thread_id) ON DELETE CASCADE,
      evidence TEXT NOT NULL,
      status TEXT NOT NULL,
      checked_at INTEGER,
      retry_at INTEGER
    );
  `);
  const rows = db.prepare(`
    SELECT thread_id, json_extract(post, '$.title') AS title
    FROM tieba_discovery_old_traffic WHERE last_at IS NOT NULL
  `);
  for (const row of rows.iterate()) {
    if (typeof row.title !== "string") continue;
    const evidence = oldResourceEvidence([{ source: "标题", text: row.title }]);
    if (evidence.linkSources.length || evidence.keywords.length)
      saveOldResource({ db }, String(row.thread_id), evidence);
  }
}

export function saveOldResource(
  { db }: Pick<Store, "db">,
  id: string,
  evidence: TiebaOldResourceEvidence,
  checkedAt?: number,
  replace = false,
) {
  const row = db
    .prepare(
      "SELECT evidence, checked_at FROM tieba_discovery_old_resource WHERE thread_id = ?",
    )
    .get(id);
  if (
    typeof row?.checked_at === "number" &&
    checkedAt !== undefined &&
    row.checked_at > checkedAt
  )
    return;
  const previous =
    !replace && row
      ? (JSON.parse(String(row.evidence)) as TiebaOldResourceEvidence)
      : undefined;
  const combined: TiebaOldResourceEvidence = {
    linkSources: tiebaOldResourceSources.filter(
      (source) =>
        evidence.linkSources.includes(source) ||
        previous?.linkSources.includes(source),
    ),
    keywords: keywords.filter(
      (word) =>
        evidence.keywords.includes(word) || previous?.keywords.includes(word),
    ),
  };
  const status = combined.linkSources.length
    ? "linked"
    : combined.keywords.length
      ? "keywords"
      : checkedAt !== undefined
        ? "none"
        : "pending";
  if (status === "pending") return;
  // v40 title backfill runs before the admission column is added.
  db.prepare(
    `
    INSERT INTO tieba_discovery_old_resource (thread_id, evidence, status, checked_at)
    SELECT thread_id, ?, ?, ? FROM tieba_discovery_old_traffic
    WHERE thread_id = ?
    ON CONFLICT(thread_id) DO UPDATE SET evidence = excluded.evidence,
      status = excluded.status, checked_at = coalesce(excluded.checked_at, checked_at),
      retry_at = CASE WHEN excluded.checked_at IS NULL THEN retry_at ELSE NULL END
  `,
  ).run(JSON.stringify(combined), status, checkedAt ?? null, id);
  return combined;
}

export function admitOldResource(
  { db }: Pick<Store, "db">,
  id: string,
  admitted = true,
) {
  db.prepare(
    "UPDATE tieba_discovery_old_resource SET admitted = ? WHERE thread_id = ?",
  ).run(Number(admitted), id);
}

export function queueOldResource(
  { db }: Pick<Store, "db">,
  reading: OldTrafficReading,
) {
  db.prepare(
    `
    INSERT INTO tieba_discovery_old_resource_queue (thread_id, reading, next_check_at)
    VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET reading = excluded.reading
    WHERE json_extract(excluded.reading, '$.views') IS NOT NULL
      OR json_extract(tieba_discovery_old_resource_queue.reading, '$.views') IS NULL
  `,
  ).run(reading.post.id, JSON.stringify(reading), reading.at);
}

export function nextOldResourceCheck(db: Store, resourceCheckEnabled: boolean) {
  if (!resourceCheckEnabled) {
    return db.all<{ next_at: number | null }>(`
      SELECT min(CASE WHEN json_extract(reading, '$.views') IS NULL THEN next_check_at ELSE 0 END) AS next_at
      FROM tieba_discovery_old_resource_queue
    `)[0].next_at;
  }
  return db.all<{ next_at: number | null }>(`
    SELECT min(next_at) AS next_at FROM (
      SELECT min(next_check_at) AS next_at FROM tieba_discovery_old_resource_queue
      UNION ALL
      SELECT min(coalesce(r.retry_at, 0)) FROM tieba_discovery_old_traffic t
      LEFT JOIN tieba_discovery_old_resource r USING (thread_id)
      WHERE t.last_at IS NOT NULL AND r.checked_at IS NULL AND coalesce(r.admitted, 0) = 0
        AND NOT EXISTS (SELECT 1 FROM tieba_discovery_old_resource_queue q
          WHERE q.thread_id = t.thread_id AND q.next_check_at IS NOT NULL)
    )
  `)[0].next_at;
}

export function pendingOldResourceCount(db: Store) {
  return db.all<{ count: number }>(`
    SELECT count(*) AS count FROM (
      SELECT thread_id FROM tieba_discovery_old_resource_queue WHERE next_check_at IS NOT NULL
      UNION
      SELECT t.thread_id FROM tieba_discovery_old_traffic t
      LEFT JOIN tieba_discovery_old_resource r USING (thread_id)
      WHERE t.last_at IS NOT NULL AND r.checked_at IS NULL AND coalesce(r.admitted, 0) = 0
    )
  `)[0].count;
}

export function dueOldResourceChecks(
  db: Store,
  at: number,
  limit: number,
  resourceCheckEnabled: boolean,
) {
  const due = resourceCheckEnabled
    ? "q.next_check_at"
    : "CASE WHEN json_extract(q.reading, '$.views') IS NULL THEN q.next_check_at ELSE 0 END";
  const legacyRows = resourceCheckEnabled
    ? `
    UNION ALL
    SELECT json_object('post', json(t.post), 'at', t.last_at, 'views', t.last_views,
      'resource', json(r.evidence)), coalesce(r.retry_at, 0), 1
    FROM tieba_discovery_old_traffic t
    LEFT JOIN tieba_discovery_old_resource r USING (thread_id)
    WHERE t.last_at IS NOT NULL AND r.checked_at IS NULL AND coalesce(r.admitted, 0) = 0
      AND NOT EXISTS (SELECT 1 FROM tieba_discovery_old_resource_queue q
        WHERE q.thread_id = t.thread_id AND q.next_check_at IS NOT NULL)
  `
    : "";
  return db
    .all<{ reading: string; legacy: number }>(
      `
    SELECT reading, legacy FROM (
      SELECT q.reading, ${due} AS due, t.last_at IS NOT NULL AS legacy
      FROM tieba_discovery_old_resource_queue q
      LEFT JOIN tieba_discovery_old_traffic t USING (thread_id)
      ${legacyRows}
    ) WHERE due <= ? ORDER BY due LIMIT ?
  `,
      at,
      limit,
    )
    .map(({ reading, legacy }) => ({
      reading: JSON.parse(reading) as OldTrafficReading,
      legacy: legacy === 1,
    }));
}

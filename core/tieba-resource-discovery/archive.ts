import type { DatabaseSync } from "node:sqlite";
import {
  tiebaDiscoveryPageSize,
  type TiebaDiscoveryPotentialPage,
  type TiebaDiscoveryPotentialPost,
  type TiebaDiscoveryRules,
  type TiebaDiscoveryTrafficPage,
  type TiebaDiscoveryTrafficPost,
} from "../../shared/tieba-resource-discovery";
import type { Database } from "../database";
import { oldResourceAdmission } from "./old-resource";
import { awaitsMaturePotentialReading, inRecentGrowthWindow, qualifyingHourlyViews } from "./rules";

export function migrateTiebaDiscoveryArchive(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tieba_discovery_potential (
      thread_id TEXT PRIMARY KEY,
      first_found_at INTEGER NOT NULL,
      first_evidence TEXT NOT NULL,
      latest TEXT NOT NULL,
      confirmed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS tieba_discovery_potential_recent
      ON tieba_discovery_potential(first_found_at DESC, thread_id DESC);
  `);
}

export function migrateTiebaTrafficArchive(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tieba_discovery_traffic (
      thread_id TEXT PRIMARY KEY,
      archived_at INTEGER NOT NULL,
      views INTEGER NOT NULL,
      reading TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tieba_discovery_traffic_recent
      ON tieba_discovery_traffic(archived_at DESC, views DESC, thread_id DESC);
  `);
}

type ArchiveDb = Pick<Database, "get" | "all" | "db">;
type SavedPost = Omit<TiebaDiscoveryPotentialPost, "active" | "awaitingMatureReading">;
export function hasNoAdmittedOldPost(threadId: string, checkResources: boolean) {
  return `NOT EXISTS (
    SELECT 1 FROM tieba_discovery_old_traffic o
    ${checkResources ? `JOIN tieba_discovery_old_resource r ON r.thread_id = o.thread_id AND ${oldResourceAdmission}` : ""}
    WHERE o.thread_id = ${threadId} AND o.last_at IS NOT NULL
  )`;
}
export function visibleHighTraffic(threadId: string, checkResources: boolean) {
  return `${hasNoAdmittedOldPost(threadId, checkResources)} AND ${notDeleted(threadId)}`;
}
function notDeleted(threadId: string) {
  return `NOT EXISTS (
    SELECT 1 FROM tieba_discovery_old_resource_deleted d WHERE d.thread_id = ${threadId}
  )`;
}
function currentPotential(rules: TiebaDiscoveryRules) {
  return `NOT EXISTS (
    SELECT 1 FROM tieba_discovery_traffic t WHERE t.thread_id = p.thread_id
  ) AND ${hasNoAdmittedOldPost("p.thread_id", rules.oldResourceCheckEnabled)} AND ${notDeleted("p.thread_id")}`;
}

function potentialFilter(rules: TiebaDiscoveryRules, grew: boolean) {
  return `${currentPotential(rules)}${grew
    ? " AND (p.confirmed_at IS NOT NULL OR json_type(p.first_evidence, '$.recentGrowth') = 'object')"
    : ""}`;
}

export function potentialCount(db: ArchiveDb, rules: TiebaDiscoveryRules, grew = false) {
  return db.get<{ count: number }>(
    `SELECT count(*) AS count FROM tieba_discovery_potential p WHERE ${potentialFilter(rules, grew)}`,
  )!.count;
}

export function potentialPage(
  db: ArchiveDb,
  requestedPage: number,
  now: number,
  rules: TiebaDiscoveryRules,
  grew = false,
): TiebaDiscoveryPotentialPage {
  const total = potentialCount(db, rules, grew);
  const page = Math.min(
    requestedPage,
    Math.max(1, Math.ceil(total / tiebaDiscoveryPageSize)),
  );
  const items = db
    .all<{
      latest: string;
      first_evidence: string;
      confirmed_at: number | null;
    }>(
      `SELECT latest, first_evidence, confirmed_at FROM tieba_discovery_potential p
       WHERE ${potentialFilter(rules, grew)}
       ORDER BY first_found_at DESC,
         json_extract(first_evidence, '$.hourlyViews') DESC,
         json_extract(first_evidence, '$.views') DESC, thread_id DESC
       LIMIT ? OFFSET ?`,
      tiebaDiscoveryPageSize,
      (page - 1) * tiebaDiscoveryPageSize,
    )
    .map((row): TiebaDiscoveryPotentialPost => {
      const post = JSON.parse(row.latest) as Omit<
        SavedPost,
        "first" | "confirmedAt"
      >;
      const first: TiebaDiscoveryPotentialPost["first"] = JSON.parse(
        row.first_evidence,
      );
      const awaitingMatureReading = awaitsMaturePotentialReading(post, rules);
      return {
        ...post,
        first,
        confirmedAt: row.confirmed_at,
        active: !awaitingMatureReading && (
          qualifyingHourlyViews(post, now, rules) !== null ||
          (!!first.recentGrowth && inRecentGrowthWindow(post, now, rules))
        ),
        awaitingMatureReading,
      };
    });
  return { page, total, items };
}

export function trafficCount(db: ArchiveDb, rules: TiebaDiscoveryRules) {
  return db.get<{ count: number }>(
    `SELECT count(*) AS count FROM tieba_discovery_traffic t WHERE ${visibleHighTraffic("t.thread_id", rules.oldResourceCheckEnabled)}`,
  )!.count;
}

export function trafficPage(
  db: ArchiveDb,
  requestedPage: number,
  rules: TiebaDiscoveryRules,
): TiebaDiscoveryTrafficPage {
  const total = trafficCount(db, rules);
  const page = Math.min(
    requestedPage,
    Math.max(1, Math.ceil(total / tiebaDiscoveryPageSize)),
  );
  const items = db
    .all<{ reading: string; archived_at: number }>(
      `SELECT reading, archived_at FROM tieba_discovery_traffic t WHERE ${visibleHighTraffic("t.thread_id", rules.oldResourceCheckEnabled)}
     ORDER BY archived_at DESC, views DESC, thread_id DESC LIMIT ? OFFSET ?`,
      tiebaDiscoveryPageSize,
      (page - 1) * tiebaDiscoveryPageSize,
    )
    .map((row): TiebaDiscoveryTrafficPost => ({ ...JSON.parse(row.reading), archivedAt: row.archived_at }));
  return { page, total, items };
}

export function trafficMembership(db: ArchiveDb) {
  const lookup = db.db.prepare(
    "SELECT 1 FROM tieba_discovery_traffic WHERE thread_id = ?",
  );
  return (id: string) => !!lookup.get(id);
}

export function saveTrafficPosts(
  db: ArchiveDb,
  posts: ReadonlyMap<string, TiebaDiscoveryTrafficPost>,
  rules: TiebaDiscoveryRules,
) {
  if (!posts.size) return;
  const insert = db.db.prepare(`
    INSERT INTO tieba_discovery_traffic(thread_id, archived_at, views, reading)
    SELECT ?, ?, ?, ? WHERE ${hasNoAdmittedOldPost("?", rules.oldResourceCheckEnabled)}
    ON CONFLICT(thread_id) DO NOTHING
  `);
  for (const post of posts.values())
    insert.run(post.id, post.checkedAt, post.views, JSON.stringify(post), post.id);
}

export function refreshTrafficPost(db: ArchiveDb, id: string, views: number | null, checkedAt: number, resource: TiebaDiscoveryTrafficPost["resource"]) {
  const row = db.get<{ reading: string }>(
    "SELECT reading FROM tieba_discovery_traffic WHERE thread_id = ?", id,
  );
  if (!row) return false;
  const post = JSON.parse(row.reading) as TiebaDiscoveryTrafficPost;
  if (post.checkedAt > checkedAt) return false;
  const updated = { ...post, views: views ?? post.views, checkedAt: views === null ? post.checkedAt : checkedAt, resource };
  db.db.prepare("UPDATE tieba_discovery_traffic SET views = ?, reading = ? WHERE thread_id = ?")
    .run(updated.views, JSON.stringify(updated), id);
  return true;
}

export function refreshPotentialPost(db: ArchiveDb, id: string, views: number | null, checkedAt: number, resource: SavedPost["resource"], rules: TiebaDiscoveryRules) {
  const row = db.get<{ latest: string }>(
    `SELECT latest FROM tieba_discovery_potential p WHERE thread_id = ? AND ${currentPotential(rules)}`, id,
  );
  if (!row) return false;
  const post = JSON.parse(row.latest) as TiebaDiscoveryPotentialPost;
  if (post.checkedAt > checkedAt) return false;
  db.db.prepare("UPDATE tieba_discovery_potential SET latest = ? WHERE thread_id = ?")
    .run(JSON.stringify({ ...post, views: views ?? post.views, checkedAt: views === null ? post.checkedAt : checkedAt, resource }), id);
  return true;
}

export function potentialMembership(db: ArchiveDb, rules: TiebaDiscoveryRules) {
  const lookup = db.db.prepare(`SELECT 1 FROM tieba_discovery_potential p WHERE thread_id = ? AND ${currentPotential(rules)}`);
  return (id: string) => !!lookup.get(id);
}

export function savePotentialPosts(db: ArchiveDb, posts: SavedPost[]) {
  if (!posts.length) return;
  const upsert = db.db.prepare(`
    INSERT INTO tieba_discovery_potential(thread_id, first_found_at, first_evidence, latest, confirmed_at)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      latest = CASE
        WHEN json_type(excluded.latest, '$.confirmedGrowth') = 'object' THEN excluded.latest
        WHEN json_type(tieba_discovery_potential.latest, '$.confirmedGrowth') = 'object'
          THEN json_set(excluded.latest, '$.confirmedGrowth',
            json_extract(tieba_discovery_potential.latest, '$.confirmedGrowth'))
        ELSE excluded.latest
      END,
      confirmed_at = COALESCE(tieba_discovery_potential.confirmed_at, excluded.confirmed_at)
    WHERE CAST(json_extract(excluded.latest, '$.checkedAt') AS INTEGER) >=
      coalesce(CAST(json_extract(tieba_discovery_potential.latest, '$.checkedAt') AS INTEGER), 0)
  `);
  for (const { id, first, confirmedAt, ...post } of posts) {
    upsert.run(
      id,
      first.at,
      JSON.stringify(first),
      JSON.stringify({ id, ...post }),
      confirmedAt,
    );
  }
}

import type { DatabaseSync } from "node:sqlite";
import {
  tiebaDiscoveryPotentialPageSize,
  type TiebaDiscoveryPotentialPage,
  type TiebaDiscoveryPotentialPost,
  type TiebaDiscoveryRules,
  type TiebaDiscoveryTrafficPage,
  type TiebaDiscoveryTrafficPost,
} from "../../shared/tieba-resource-discovery";
import type { Database } from "../database";
import { discoveryInterval } from "./rules";

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
type SavedPost = Omit<TiebaDiscoveryPotentialPost, "active">;
const currentPotential = `NOT EXISTS (
  SELECT 1 FROM tieba_discovery_traffic t WHERE t.thread_id = tieba_discovery_potential.thread_id
)`;

export function potentialCount(db: ArchiveDb) {
  return db.get<{ count: number }>(
    `SELECT count(*) AS count FROM tieba_discovery_potential WHERE ${currentPotential}`,
  )!.count;
}

export function potentialPage(
  db: ArchiveDb,
  requestedPage: number,
  now: number,
  rules: TiebaDiscoveryRules,
): TiebaDiscoveryPotentialPage {
  const total = potentialCount(db);
  const page = Math.min(
    requestedPage,
    Math.max(1, Math.ceil(total / tiebaDiscoveryPotentialPageSize)),
  );
  const items = db
    .all<{
      latest: string;
      first_evidence: string;
      confirmed_at: number | null;
    }>(
      `SELECT latest, first_evidence, confirmed_at FROM tieba_discovery_potential
       WHERE ${currentPotential}
       ORDER BY first_found_at DESC,
         1.0 * json_extract(first_evidence, '$.rank.place') / json_extract(first_evidence, '$.rank.sample'),
         json_extract(first_evidence, '$.views') DESC, thread_id DESC
       LIMIT ? OFFSET ?`,
      tiebaDiscoveryPotentialPageSize,
      (page - 1) * tiebaDiscoveryPotentialPageSize,
    )
    .map((row): TiebaDiscoveryPotentialPost => {
      const post = JSON.parse(row.latest) as Omit<
        SavedPost,
        "first" | "confirmedAt"
      >;
      const age = now - Date.parse(post.publishedAt);
      const first: TiebaDiscoveryPotentialPost["first"] = JSON.parse(
        row.first_evidence,
      );
      const score = post.score ?? first.score;
      return {
        ...post,
        first,
        score,
        confirmedAt: row.confirmed_at,
        active:
          score !== undefined &&
          score >= rules.potentialThreshold &&
          age >= 0 &&
          age <= rules.lookbackHours * discoveryInterval,
      };
    });
  return { page, total, items };
}

export function trafficCount(db: ArchiveDb) {
  return db.get<{ count: number }>(
    "SELECT count(*) AS count FROM tieba_discovery_traffic",
  )!.count;
}

export function trafficPage(
  db: ArchiveDb,
  requestedPage: number,
): TiebaDiscoveryTrafficPage {
  const total = trafficCount(db);
  const page = Math.min(
    requestedPage,
    Math.max(1, Math.ceil(total / tiebaDiscoveryPotentialPageSize)),
  );
  const items = db
    .all<{ reading: string }>(
      `SELECT reading FROM tieba_discovery_traffic
     ORDER BY archived_at DESC, views DESC, thread_id DESC LIMIT ? OFFSET ?`,
      tiebaDiscoveryPotentialPageSize,
      (page - 1) * tiebaDiscoveryPotentialPageSize,
    )
    .map((row): TiebaDiscoveryTrafficPost => JSON.parse(row.reading));
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
) {
  if (!posts.size) return;
  const insert = db.db.prepare(`
    INSERT INTO tieba_discovery_traffic(thread_id, archived_at, views, reading)
    VALUES(?, ?, ?, ?) ON CONFLICT(thread_id) DO NOTHING
  `);
  for (const post of posts.values())
    insert.run(post.id, post.checkedAt, post.views, JSON.stringify(post));
}

export function savePotentialPosts(db: ArchiveDb, posts: SavedPost[]) {
  if (!posts.length) return;
  const upsert = db.db.prepare(`
    INSERT INTO tieba_discovery_potential(thread_id, first_found_at, first_evidence, latest, confirmed_at)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      latest = excluded.latest,
      confirmed_at = COALESCE(tieba_discovery_potential.confirmed_at, excluded.confirmed_at)
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

import type { DatabaseSync } from "node:sqlite";
import {
  tiebaDiscoveryPotentialPageSize,
  type TiebaDiscoveryPotentialPage,
  type TiebaDiscoveryPotentialPost,
} from "../../shared/tieba-resource-discovery";
import type { Database } from "../database";
import { discoveryLookback } from "./rules";

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

type ArchiveDb = Pick<Database, "get" | "all" | "db">;
type SavedPost = Omit<TiebaDiscoveryPotentialPost, "active">;

export function potentialCount(db: ArchiveDb) {
  return db.get<{ count: number }>(
    "SELECT count(*) AS count FROM tieba_discovery_potential",
  )!.count;
}

export function potentialPage(
  db: ArchiveDb,
  requestedPage: number,
  now: number,
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
     ORDER BY first_found_at DESC, thread_id DESC LIMIT ? OFFSET ?`,
      tiebaDiscoveryPotentialPageSize,
      (page - 1) * tiebaDiscoveryPotentialPageSize,
    )
    .map((row): TiebaDiscoveryPotentialPost => {
      const post = JSON.parse(row.latest) as Omit<
        SavedPost,
        "first" | "confirmedAt"
      >;
      const age = now - Date.parse(post.publishedAt);
      return {
        ...post,
        first: JSON.parse(row.first_evidence),
        confirmedAt: row.confirmed_at,
        active: age >= 0 && age <= discoveryLookback,
      };
    });
  return { page, total, items };
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

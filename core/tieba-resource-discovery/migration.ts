import type { DatabaseSync } from "node:sqlite";

export const tiebaDiscoveryStateKey = "tieba.resourceDiscovery.v1";

type LegacyRow = Record<string, unknown> & { path?: unknown };
type LegacySource = LegacyRow & {
  via?: { forum: string; reason: string; author?: string; uid?: string };
};

export function compactTiebaDiscoveryPaths(db: DatabaseSync) {
  const row = db.prepare(
    "SELECT value FROM settings WHERE key = ? AND json_valid(value)",
  ).get(tiebaDiscoveryStateKey);
  if (typeof row?.value === "string") {
    const state = JSON.parse(row.value) as {
      sources?: LegacySource[];
      posts?: LegacyRow[];
    } | null;
    if (state && Array.isArray(state.sources) && Array.isArray(state.posts)) {
      state.sources = state.sources.map(({ path, via, ...source }) => ({
        ...source,
        ...(via ? { via: { forum: via.forum, reason: via.reason } } : {}),
      }));
      state.posts = state.posts.map(({ path, ...post }) => post);
      db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
        JSON.stringify(state),
        tiebaDiscoveryStateKey,
      );
    }
  }
  db.exec(`
    UPDATE tieba_discovery_potential SET latest = json_remove(latest, '$.path')
    WHERE CASE WHEN json_valid(latest) THEN json_type(latest, '$.path') IS NOT NULL ELSE 0 END;
    UPDATE tieba_discovery_traffic SET reading = json_remove(reading, '$.path')
    WHERE CASE WHEN json_valid(reading) THEN json_type(reading, '$.path') IS NOT NULL ELSE 0 END;
  `);
}

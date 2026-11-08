import type { DatabaseSync } from "node:sqlite";

export function migrateTiebaInsights(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tieba_forum_metrics (
      target_id TEXT NOT NULL, account_id TEXT NOT NULL, uid TEXT NOT NULL,
      forum_id TEXT NOT NULL, checked_at TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(uid, forum_id, checked_at)
    );
    CREATE INDEX IF NOT EXISTS tieba_metric_target ON tieba_forum_metrics(target_id,checked_at DESC);
    CREATE TABLE IF NOT EXISTS tieba_visibility_checks (
      publication_id TEXT PRIMARY KEY, data TEXT NOT NULL
    );
  `);
  if (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='tieba_autocare_targets'",
      )
      .get()
  )
    db.exec(`INSERT OR IGNORE INTO tieba_forum_metrics(target_id,account_id,uid,forum_id,checked_at,data)
      SELECT id,account_id,uid,forum_id,json_extract(data,'$.checkedAt'),
        json_object('checkedAt',json_extract(data,'$.checkedAt'),'level',json_extract(data,'$.level'),'experience',json_extract(data,'$.experience'))
      FROM tieba_autocare_targets WHERE json_valid(data) AND json_extract(data,'$.checkedAt') IS NOT NULL;`);
}

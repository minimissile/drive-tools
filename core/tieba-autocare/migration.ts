import type { DatabaseSync } from "node:sqlite";

export function migrateTiebaAutocare(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tieba_autocare_targets (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, uid TEXT NOT NULL,
      forum_id TEXT NOT NULL, data TEXT NOT NULL,
      UNIQUE(account_id, uid, forum_id)
    );
    CREATE INDEX IF NOT EXISTS tieba_autocare_target_account ON tieba_autocare_targets(account_id);
    CREATE TABLE IF NOT EXISTS tieba_autocare_tasks (
      id TEXT PRIMARY KEY, target_id TEXT NOT NULL, uid TEXT NOT NULL,
      forum_id TEXT NOT NULL, day TEXT NOT NULL, action TEXT NOT NULL,
      status TEXT NOT NULL, planned_at TEXT NOT NULL, deadline_at TEXT NOT NULL,
      submitted_at TEXT, data TEXT NOT NULL,
      UNIQUE(uid, forum_id, day, action)
    );
    CREATE INDEX IF NOT EXISTS tieba_autocare_task_due ON tieba_autocare_tasks(status, planned_at);
  `);
}

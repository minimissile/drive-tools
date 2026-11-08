import type { DatabaseSync } from "node:sqlite";

export function migrateTiebaAutomation(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS tieba_automation_tasks (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, day TEXT NOT NULL,
    status TEXT NOT NULL, planned_at TEXT NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tieba_automation_day ON tieba_automation_tasks(day);`);
}

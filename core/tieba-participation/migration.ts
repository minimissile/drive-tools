import type { DatabaseSync } from "node:sqlite";

export function migrateTiebaParticipation(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tieba_thread_candidates (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, uid TEXT NOT NULL,
      thread_id TEXT NOT NULL, data TEXT NOT NULL,
      UNIQUE(uid, thread_id)
    );
    CREATE INDEX IF NOT EXISTS tieba_candidate_account ON tieba_thread_candidates(account_id);
    CREATE TABLE IF NOT EXISTS tieba_reply_drafts (
      id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, uid TEXT NOT NULL,
      thread_id TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
      submitted_at TEXT, data TEXT NOT NULL,
      UNIQUE(uid, thread_id)
    );
    CREATE TABLE IF NOT EXISTS tieba_reply_generations (
      id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tieba_reply_generation_date ON tieba_reply_generations(created_at);
  `);
}

import type { DatabaseSync } from "node:sqlite";
export function migrateTiebaTopics(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tieba_topic_drafts(id TEXT PRIMARY KEY,target_id TEXT NOT NULL,uid TEXT NOT NULL,forum_id TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,submitted_at TEXT,body_hash TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS tieba_topic_submission ON tieba_topic_drafts(uid,submitted_at);
    CREATE TABLE IF NOT EXISTS tieba_topic_generations(id TEXT PRIMARY KEY,draft_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tieba_topic_rules(target_id TEXT PRIMARY KEY,data TEXT NOT NULL);
  `);
}

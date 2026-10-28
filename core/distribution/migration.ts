import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Normalize the early assisted-posting records without dropping their receipts. */
export function migrateDistribution(db: DatabaseSync) {
  db.exec(`
    ALTER TABLE distribution_tasks RENAME TO distribution_tasks_v1;
    DROP INDEX distribution_platform_status;
    CREATE TABLE distribution_tasks(
      id TEXT PRIMARY KEY,platform_id TEXT NOT NULL,share_record_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,copy_id TEXT NOT NULL,split_item_id TEXT,
      title TEXT NOT NULL,provider TEXT NOT NULL,share_key TEXT NOT NULL,share_url TEXT NOT NULL,
      share_version INTEGER NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',
      batch_id TEXT,submitted_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(platform_id,share_key));
    CREATE INDEX distribution_pending ON distribution_tasks(platform_id,status,created_at,id);
    CREATE INDEX distribution_resource ON distribution_tasks(platform_id,resource_id);
    CREATE TABLE distribution_task_sources(platform_id TEXT NOT NULL,share_record_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES distribution_tasks(id),resource_id TEXT NOT NULL,
      copy_id TEXT NOT NULL,split_item_id TEXT,PRIMARY KEY(platform_id,share_record_id));
    CREATE INDEX distribution_source_task ON distribution_task_sources(task_id);
    CREATE TABLE distribution_events(id INTEGER PRIMARY KEY,task_id TEXT NOT NULL REFERENCES distribution_tasks(id),
      status TEXT NOT NULL,note TEXT NOT NULL,receipt TEXT NOT NULL DEFAULT '',url TEXT NOT NULL DEFAULT '',at TEXT NOT NULL);
    CREATE INDEX distribution_task_events ON distribution_events(task_id,id DESC);
    CREATE TABLE distribution_batches(id TEXT PRIMARY KEY,platform_id TEXT NOT NULL,status TEXT NOT NULL,
      item_count INTEGER NOT NULL,message TEXT NOT NULL DEFAULT '',receipt TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,submitted_at TEXT,completed_at TEXT);
    CREATE INDEX distribution_batch_history ON distribution_batches(platform_id,created_at DESC);
    CREATE TABLE distribution_batch_items(batch_id TEXT NOT NULL REFERENCES distribution_batches(id),
      task_id TEXT NOT NULL REFERENCES distribution_tasks(id),PRIMARY KEY(batch_id,task_id));
    CREATE TABLE distribution_attempts(id TEXT PRIMARY KEY,platform_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES distribution_tasks(id),batch_id TEXT,sent_at TEXT NOT NULL);
    CREATE INDEX distribution_daily_attempts ON distribution_attempts(platform_id,sent_at);
    CREATE TABLE distribution_runs(platform_id TEXT PRIMARY KEY,state TEXT NOT NULL DEFAULT 'idle',
      scan_kind TEXT NOT NULL DEFAULT 'copy',scan_cursor INTEGER NOT NULL DEFAULT 0,
      copy_ceiling INTEGER NOT NULL DEFAULT 0,split_ceiling INTEGER NOT NULL DEFAULT 0,
      scanned INTEGER NOT NULL DEFAULT 0,readiness TEXT,message TEXT NOT NULL DEFAULT '',
      started_at TEXT,updated_at TEXT NOT NULL);
  `);
  const insert = db.prepare(
    `INSERT INTO distribution_tasks(id,platform_id,share_record_id,resource_id,copy_id,title,provider,share_key,share_url,share_version,status,message,submitted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const source = db.prepare(
    "INSERT INTO distribution_task_sources VALUES(?,?,?,?,?,NULL)",
  );
  const event = db.prepare(
    "INSERT INTO distribution_events(task_id,status,note,receipt,url,at) VALUES(?,?,?,?,?,?)",
  );
  const attempt = db.prepare(
    "INSERT INTO distribution_attempts(id,platform_id,task_id,sent_at) VALUES(?,?,?,?)",
  );
  for (const row of db
    .prepare("SELECT * FROM distribution_tasks_v1")
    .iterate()) {
    const task = JSON.parse(String(row.data));
    insert.run(
      row.id,
      row.platform_id,
      `copy:${row.copy_id}`,
      row.resource_id,
      row.copy_id,
      task.title,
      task.provider,
      row.share_key,
      task.shareUrl,
      task.shareVersion,
      row.status,
      task.events.at(-1)?.note ?? "",
      row.submitted_at,
      row.created_at,
      row.updated_at,
    );
    source.run(
      row.platform_id,
      `copy:${row.copy_id}`,
      row.id,
      row.resource_id,
      row.copy_id,
    );
    for (const item of task.events) {
      event.run(
        row.id,
        item.status,
        item.note,
        item.receipt ?? "",
        item.url ?? "",
        item.at,
      );
      if (item.submission)
        attempt.run(
          `distribution_${randomUUID()}`,
          row.platform_id,
          row.id,
          item.at,
        );
    }
  }
  db.exec("DROP TABLE distribution_tasks_v1; PRAGMA user_version=24;");
}

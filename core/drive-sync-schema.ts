import type { DatabaseSync } from "node:sqlite";

export function migrateDriveSync(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drive_sync_runs(
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      owner_uid TEXT NOT NULL, environment TEXT NOT NULL, status TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS drive_sync_account ON drive_sync_runs(account_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS drive_sync_folders(
      run_id TEXT NOT NULL REFERENCES drive_sync_runs(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL, request_id TEXT NOT NULL, path TEXT NOT NULL,
      cursor TEXT NOT NULL DEFAULT '', cursors TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending', error TEXT,
      PRIMARY KEY(run_id,file_id)
    );
    CREATE INDEX IF NOT EXISTS drive_sync_queue ON drive_sync_folders(run_id,status);
    CREATE TABLE IF NOT EXISTS drive_index_entries(
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, owner_uid TEXT NOT NULL,
      file_id TEXT NOT NULL, parent_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
      is_directory INTEGER NOT NULL, size REAL, last_seen TEXT NOT NULL, observed_at TEXT NOT NULL,
      missing INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(account_id,owner_uid,file_id)
    );
    CREATE INDEX IF NOT EXISTS drive_index_parent ON drive_index_entries(account_id,owner_uid,parent_id,is_directory DESC,name,file_id);
    CREATE INDEX IF NOT EXISTS drive_index_seen ON drive_index_entries(account_id,owner_uid,last_seen,is_directory);
    CREATE TABLE IF NOT EXISTS drive_resource_entries(
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, owner_uid TEXT NOT NULL,
      file_id TEXT NOT NULL, copy_id TEXT NOT NULL REFERENCES copies(id) ON DELETE CASCADE,
      PRIMARY KEY(account_id,owner_uid,file_id,copy_id)
    );
    CREATE TRIGGER IF NOT EXISTS drive_links_insert AFTER INSERT ON copies BEGIN
      INSERT OR IGNORE INTO drive_resource_entries SELECT NEW.account_id,NEW.owner_uid,json_extract(value,'$.id'),NEW.id FROM json_each(NEW.files)
        WHERE NEW.owner_uid IS NOT NULL AND NEW.verified_at IS NOT NULL AND NEW.status IN ('ready','recorded') AND json_extract(value,'$.id') IS NOT NULL;
      INSERT OR IGNORE INTO drive_resource_entries SELECT NEW.account_id,NEW.owner_uid,NEW.folder_id,NEW.id
        WHERE NEW.owner_uid IS NOT NULL AND NEW.verified_at IS NOT NULL AND NEW.folder_id IS NOT NULL AND NEW.status IN ('ready','recorded');
    END;
    CREATE TRIGGER IF NOT EXISTS drive_links_update AFTER UPDATE OF files,folder_id,owner_uid,verified_at,status,account_id ON copies BEGIN
      DELETE FROM drive_resource_entries WHERE copy_id=OLD.id;
      INSERT OR IGNORE INTO drive_resource_entries SELECT NEW.account_id,NEW.owner_uid,json_extract(value,'$.id'),NEW.id FROM json_each(NEW.files)
        WHERE NEW.owner_uid IS NOT NULL AND NEW.verified_at IS NOT NULL AND NEW.status IN ('ready','recorded') AND json_extract(value,'$.id') IS NOT NULL;
      INSERT OR IGNORE INTO drive_resource_entries SELECT NEW.account_id,NEW.owner_uid,NEW.folder_id,NEW.id
        WHERE NEW.owner_uid IS NOT NULL AND NEW.verified_at IS NOT NULL AND NEW.folder_id IS NOT NULL AND NEW.status IN ('ready','recorded');
    END;
    INSERT OR IGNORE INTO drive_resource_entries SELECT c.account_id,c.owner_uid,json_extract(f.value,'$.id'),c.id FROM copies c,json_each(c.files) f
      WHERE c.owner_uid IS NOT NULL AND c.verified_at IS NOT NULL AND c.status IN ('ready','recorded') AND json_extract(f.value,'$.id') IS NOT NULL;
    INSERT OR IGNORE INTO drive_resource_entries SELECT account_id,owner_uid,folder_id,id FROM copies
      WHERE owner_uid IS NOT NULL AND verified_at IS NOT NULL AND folder_id IS NOT NULL AND status IN ('ready','recorded');
  `);
}

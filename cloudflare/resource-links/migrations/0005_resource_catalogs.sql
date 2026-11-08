CREATE TABLE resource_catalogs (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  title TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  last_operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX resource_catalogs_public ON resource_catalogs(active, updated_at DESC, id);
CREATE TABLE resource_catalog_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  id TEXT NOT NULL,
  slug TEXT NOT NULL,
  active INTEGER NOT NULL,
  version INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  title TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  last_operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- One mutation commits its immutable receipt and discovery notifications atomically.
CREATE TRIGGER catalog_receipt_insert AFTER INSERT ON resource_catalogs BEGIN
  INSERT INTO resource_catalog_operations VALUES(
    NEW.last_operation_id, NEW.id, NEW.slug, NEW.active, NEW.version,
    NEW.source_revision, NEW.snapshot_json, NEW.title, NEW.item_count, NEW.last_operation_id,
    NEW.request_hash, NEW.published_at, NEW.updated_at
  );
  INSERT INTO indexnow_submissions(path) VALUES('/c/' || NEW.slug),('/catalogs'),('/')
    ON CONFLICT(path) DO UPDATE SET revision=revision+1,status='pending',attempts=0,next_attempt_at=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER catalog_receipt_update AFTER UPDATE ON resource_catalogs BEGIN
  INSERT INTO resource_catalog_operations VALUES(
    NEW.last_operation_id, NEW.id, NEW.slug, NEW.active, NEW.version,
    NEW.source_revision, NEW.snapshot_json, NEW.title, NEW.item_count, NEW.last_operation_id,
    NEW.request_hash, NEW.published_at, NEW.updated_at
  );
  INSERT INTO indexnow_submissions(path) VALUES('/c/' || NEW.slug),('/catalogs'),('/')
    ON CONFLICT(path) DO UPDATE SET revision=revision+1,status='pending',attempts=0,next_attempt_at=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;

-- Apply with Wrangler D1 migrations. No resource rows are seeded.
CREATE TABLE resource_links (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 8 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 8 AND 32 AND slug NOT GLOB '*[^A-Za-z0-9_-]*'),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  provider TEXT NOT NULL CHECK (provider IN ('quark', 'baidu', 'uc', 'xunlei', 'guangya', 'pikpak')),
  target_url TEXT,
  code TEXT NOT NULL CHECK (length(code) <= 128),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  last_operation_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json))
);

-- Receipts survive later updates: retrying an old operation returns its original result.
-- The operation ID is globally unique within this service, including across link IDs.
CREATE TABLE resource_link_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  id TEXT NOT NULL REFERENCES resource_links(id),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  provider TEXT NOT NULL,
  target_url TEXT,
  code TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  last_operation_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json))
);

CREATE TRIGGER resource_links_receipt_insert
AFTER INSERT ON resource_links
BEGIN
  INSERT INTO resource_link_operations (
    operation_id, id, slug, title, provider, target_url, code, enabled,
    revision, last_operation_id, updated_at, request_json
  ) VALUES (
    NEW.last_operation_id, NEW.id, NEW.slug, NEW.title, NEW.provider,
    NEW.target_url, NEW.code, NEW.enabled, NEW.revision,
    NEW.last_operation_id, NEW.updated_at, NEW.request_json
  );
END;

CREATE TRIGGER resource_links_receipt_update
AFTER UPDATE ON resource_links
BEGIN
  INSERT INTO resource_link_operations (
    operation_id, id, slug, title, provider, target_url, code, enabled,
    revision, last_operation_id, updated_at, request_json
  ) VALUES (
    NEW.last_operation_id, NEW.id, NEW.slug, NEW.title, NEW.provider,
    NEW.target_url, NEW.code, NEW.enabled, NEW.revision,
    NEW.last_operation_id, NEW.updated_at, NEW.request_json
  );
END;

-- Editorial content is versioned independently from replaceable drive links.
CREATE TABLE resource_pages (
  link_id TEXT PRIMARY KEY NOT NULL REFERENCES resource_links(id),
  document_json TEXT CHECK(document_json IS NULL OR json_valid(document_json)),
  resource_title TEXT NOT NULL,
  category TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  quality_score INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  last_operation_id TEXT NOT NULL,
  published_at TEXT,
  updated_at TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json))
);
CREATE INDEX resource_pages_category ON resource_pages(category,updated_at DESC);
CREATE UNIQUE INDEX resource_pages_distinct_body ON resource_pages(body_hash)
  WHERE document_json IS NOT NULL;
CREATE TABLE resource_page_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  link_id TEXT NOT NULL REFERENCES resource_links(id),
  document_json TEXT,
  version INTEGER NOT NULL,
  last_operation_id TEXT NOT NULL,
  published_at TEXT,
  updated_at TEXT NOT NULL,
  request_json TEXT NOT NULL
);
CREATE TRIGGER resource_pages_receipt_insert AFTER INSERT ON resource_pages BEGIN
  INSERT INTO resource_page_operations VALUES(NEW.last_operation_id,NEW.link_id,NEW.document_json,
    NEW.version,NEW.last_operation_id,NEW.published_at,NEW.updated_at,NEW.request_json);
END;
CREATE TRIGGER resource_pages_receipt_update AFTER UPDATE ON resource_pages BEGIN
  INSERT INTO resource_page_operations VALUES(NEW.last_operation_id,NEW.link_id,NEW.document_json,
    NEW.version,NEW.last_operation_id,NEW.published_at,NEW.updated_at,NEW.request_json);
END;

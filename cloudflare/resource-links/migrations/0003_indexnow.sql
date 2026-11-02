-- Only public page paths are queued; account data and drive URLs never enter notifications.
CREATE TABLE indexnow_submissions (
  path TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  submitted_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER indexnow_page_insert AFTER INSERT ON resource_pages
WHEN NEW.document_json IS NOT NULL BEGIN
  INSERT INTO indexnow_submissions(path) SELECT '/r/' || slug FROM resource_links WHERE id=NEW.link_id
    ON CONFLICT(path) DO UPDATE SET revision=revision+1,status='pending',attempts=0,next_attempt_at=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
  INSERT INTO indexnow_submissions(path) VALUES('/')
    ON CONFLICT(path) DO UPDATE SET revision=revision+1,status='pending',attempts=0,next_attempt_at=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER indexnow_page_update AFTER UPDATE ON resource_pages
WHEN NEW.document_json IS NOT NULL OR OLD.document_json IS NOT NULL BEGIN
  INSERT INTO indexnow_submissions(path) SELECT '/r/' || slug FROM resource_links WHERE id=NEW.link_id
    ON CONFLICT(path) DO UPDATE SET revision=revision+1,status='pending',attempts=0,next_attempt_at=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
  INSERT INTO indexnow_submissions(path) VALUES('/')
    ON CONFLICT(path) DO UPDATE SET revision=revision+1,status='pending',attempts=0,next_attempt_at=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER indexnow_link_update AFTER UPDATE ON resource_links
WHEN EXISTS(SELECT 1 FROM resource_pages WHERE link_id=NEW.id AND document_json IS NOT NULL) BEGIN
  INSERT INTO indexnow_submissions(path) VALUES('/r/' || NEW.slug)
    ON CONFLICT(path) DO UPDATE SET revision=revision+1,status='pending',attempts=0,next_attempt_at=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
  INSERT INTO indexnow_submissions(path) VALUES('/')
    ON CONFLICT(path) DO UPDATE SET revision=revision+1,status='pending',attempts=0,next_attempt_at=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
INSERT INTO indexnow_submissions(path) SELECT '/r/' || l.slug FROM resource_pages p
  JOIN resource_links l ON p.link_id=l.id WHERE p.document_json IS NOT NULL AND l.enabled=1 AND l.target_url IS NOT NULL AND p.quality_score>=85;
INSERT OR IGNORE INTO indexnow_submissions(path) VALUES('/'),('/about');

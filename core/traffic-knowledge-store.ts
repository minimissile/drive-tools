import { gzipSync, gunzipSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import { trafficSourceLabels } from "../shared/traffic-knowledge";

const archivePrefix = "panxu:gzip:v1:";
export const normalizeTrafficWord = (word: string) =>
  word.normalize("NFKC").trim().toLowerCase();
export const metricMonthly = (column: string) => {
  const value = `json_extract(${column},'$.averageMonthPv')`;
  const numericText = `replace(trim(${value}),',','')`;
  return `CASE WHEN json_valid(${column}) THEN CASE
    WHEN json_type(${column},'$.averageMonthPv') IN ('integer','real') AND ${value}>=0 AND ${value}<1e999 THEN ${value}
    WHEN json_type(${column},'$.averageMonthPv')='text' AND json_valid(${numericText}) THEN CASE
      WHEN json_type(${numericText}) IN ('integer','real') AND CAST(${numericText} AS REAL)>=0 AND CAST(${numericText} AS REAL)<1e999
      THEN CAST(${numericText} AS REAL) END END END`;
};
export const metricVolume = (column: string) => {
  const value = `trim(json_extract(${column},'$.averageMonthPv'))`;
  const bound = `trim(substr(${value},2))`;
  const isBound = `CASE WHEN json_valid(${column}) AND substr(${value},1,1)='<' AND json_valid(${bound}) THEN
    json_type(${bound}) IN ('integer','real') AND CAST(${bound} AS REAL)>0 AND CAST(${bound} AS REAL)<1e999 ELSE 0 END`;
  return `CASE WHEN (${metricMonthly(column)}) IS NULL AND NOT (${isBound}) THEN 'unknown'
    WHEN instr(coalesce(json_extract(${column},'$.averageMonthPvSource'),''),'默认')>0 THEN 'default' ELSE 'measured' END`;
};

/** Accept raw response text only. Prefix-shaped raw text is always wrapped,
 * even when larger, so stored text has an unambiguous single decoding step. */
export function packTrafficArchive(rawText: string): string {
  const mustEscape = rawText.startsWith(archivePrefix);
  if (rawText.length < 256 && !mustEscape) return rawText;
  const compressed = archivePrefix + gzipSync(rawText).toString("base64");
  return mustEscape || compressed.length < rawText.length
    ? compressed
    : rawText;
}
export function unpackTrafficArchive(value: string | null): string | null {
  if (value == null || !value.startsWith(archivePrefix)) return value;
  try {
    return gunzipSync(
      Buffer.from(value.slice(archivePrefix.length), "base64"),
    ).toString("utf8");
  } catch {
    // Preserve the stored bytes if a compressed archive is damaged.
    return value;
  }
}

/** Three physical layers: stable entries, small observations, and query archives.
 * The old item interface is a view, so adjacent readers/writers can migrate
 * without copying payloads or changing observation identifiers. */
export function migrateTrafficKnowledge(db: DatabaseSync) {
  if (
    db
      .prepare("SELECT type FROM sqlite_master WHERE name='traffic_items'")
      .get()?.type === "view" &&
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='traffic_entries'",
      )
      .get() &&
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='traffic_observations'",
      )
      .get()
  )
    return;
  db.exec(`
    ALTER TABLE traffic_queries ADD COLUMN item_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE traffic_queries ADD COLUMN legacy_items TEXT;
    ALTER TABLE traffic_items RENAME TO traffic_items_legacy;
    DROP INDEX traffic_items_word;
    DROP INDEX traffic_items_query;
    CREATE TABLE traffic_entries(
      id TEXT PRIMARY KEY,kind TEXT NOT NULL,normalized_word TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT '',source TEXT NOT NULL,word TEXT NOT NULL,
      latest_observation_id TEXT,first_observed_at TEXT,last_observed_at TEXT NOT NULL DEFAULT '',
      observation_count INTEGER NOT NULL DEFAULT 0,monthly_searches REAL,
      volume_kind TEXT NOT NULL DEFAULT 'unknown',
      UNIQUE(kind,normalized_word,platform,source));
    CREATE INDEX traffic_entries_recent ON traffic_entries(last_observed_at DESC,word,id);
    CREATE INDEX traffic_entries_word ON traffic_entries(word,id);
    CREATE INDEX traffic_entries_monthly ON traffic_entries(monthly_searches DESC,word,id);
    CREATE INDEX traffic_entries_source ON traffic_entries(source,kind,platform);
    CREATE INDEX traffic_entries_volume ON traffic_entries(volume_kind,last_observed_at DESC,word,id);
    CREATE TABLE traffic_observations(
      seq INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,
      query_id TEXT NOT NULL REFERENCES traffic_queries(id),
      endpoint TEXT NOT NULL,
      entry_id TEXT NOT NULL REFERENCES traffic_entries(id),word TEXT NOT NULL,
      metrics TEXT NOT NULL,observed_at TEXT,source_updated_at TEXT);
    CREATE INDEX traffic_observations_entry ON traffic_observations(entry_id,coalesce(observed_at,'') DESC,seq DESC);
    CREATE INDEX traffic_observations_source ON traffic_observations(entry_id,endpoint,coalesce(observed_at,'') DESC,seq DESC);
    CREATE INDEX traffic_observations_query ON traffic_observations(query_id,entry_id);
    CREATE INDEX traffic_queries_endpoint ON traffic_queries(endpoint,received_at DESC,id);
    CREATE VIEW traffic_items AS SELECT o.seq rowid,o.id,o.query_id,e.kind,o.word,e.normalized_word,
      nullif(e.platform,'') platform,e.source,o.metrics,'{}' data,o.observed_at,o.source_updated_at,e.id entry_id
      FROM traffic_observations o JOIN traffic_entries e ON e.id=o.entry_id;
    CREATE TRIGGER traffic_items_insert INSTEAD OF INSERT ON traffic_items BEGIN
      INSERT OR IGNORE INTO traffic_entries(id,kind,normalized_word,platform,source,word)
        VALUES('entry_'||new.id,new.kind,new.normalized_word,coalesce(new.platform,''),new.source,new.word);
      INSERT INTO traffic_observations(id,query_id,endpoint,entry_id,word,metrics,observed_at,source_updated_at)
        SELECT new.id,new.query_id,coalesce((SELECT endpoint FROM traffic_queries WHERE id=new.query_id),'unknown'),e.id,new.word,new.metrics,new.observed_at,new.source_updated_at
        FROM traffic_entries e WHERE e.kind=new.kind AND e.normalized_word=new.normalized_word
        AND e.platform=coalesce(new.platform,'') AND e.source=new.source;
    END;
    CREATE TRIGGER traffic_observations_insert AFTER INSERT ON traffic_observations BEGIN
      UPDATE traffic_queries SET item_count=item_count+1 WHERE id=new.query_id;
      UPDATE traffic_entries SET
        observation_count=observation_count+1,
        first_observed_at=CASE WHEN first_observed_at IS NULL THEN new.observed_at
          WHEN new.observed_at IS NULL THEN first_observed_at ELSE min(first_observed_at,new.observed_at) END
        WHERE id=new.entry_id;
      UPDATE traffic_entries SET latest_observation_id=new.id,word=new.word,
        last_observed_at=coalesce(new.observed_at,''),
        monthly_searches=${metricMonthly("new.metrics")},
        volume_kind=${metricVolume("new.metrics")}
        WHERE id=new.entry_id AND (latest_observation_id IS NULL OR last_observed_at<=coalesce(new.observed_at,''));
    END;
    CREATE TRIGGER traffic_items_delete INSTEAD OF DELETE ON traffic_items BEGIN
      DELETE FROM traffic_observations WHERE id=old.id;
    END;
    CREATE TRIGGER traffic_observations_delete AFTER DELETE ON traffic_observations BEGIN
      UPDATE traffic_queries SET item_count=item_count-1 WHERE id=old.query_id;
      UPDATE traffic_entries SET observation_count=observation_count-1 WHERE id=old.entry_id;
      UPDATE traffic_entries SET
        latest_observation_id=(SELECT id FROM traffic_observations WHERE entry_id=old.entry_id ORDER BY coalesce(observed_at,'') DESC,seq DESC LIMIT 1),
        first_observed_at=(SELECT min(observed_at) FROM traffic_observations WHERE entry_id=old.entry_id)
        WHERE id=old.entry_id;
      DELETE FROM traffic_entries WHERE id=old.entry_id AND observation_count=0;
      UPDATE traffic_entries SET
        word=(SELECT word FROM traffic_observations WHERE id=latest_observation_id),
        last_observed_at=coalesce((SELECT observed_at FROM traffic_observations WHERE id=latest_observation_id),''),
        monthly_searches=${metricMonthly("(SELECT metrics FROM traffic_observations WHERE id=latest_observation_id)")},
        volume_kind=${metricVolume("(SELECT metrics FROM traffic_observations WHERE id=latest_observation_id)")}
        WHERE id=old.entry_id;
    END;
    INSERT INTO traffic_items(id,query_id,kind,word,normalized_word,platform,source,metrics,data,observed_at,source_updated_at)
      SELECT id,query_id,kind,word,normalized_word,platform,source,metrics,data,observed_at,source_updated_at
      FROM traffic_items_legacy ORDER BY rowid;
  `);
  // A missing response must not discard the only surviving per-row evidence.
  const legacy = db.prepare(
    "SELECT id,data FROM traffic_items_legacy WHERE query_id=? ORDER BY rowid",
  );
  const keepLegacy = db.prepare(
    "UPDATE traffic_queries SET legacy_items=? WHERE id=?",
  );
  for (const query of db
    .prepare(
      "SELECT id FROM traffic_queries WHERE response IS NULL AND item_count>0",
    )
    .iterate()) {
    const rows = legacy
      .all(query.id)
      .map((row) => ({ observationId: row.id, data: String(row.data) }));
    keepLegacy.run(packTrafficArchive(JSON.stringify(rows)), query.id);
  }
  db.exec("DROP TABLE traffic_items_legacy");
  const update = db.prepare("UPDATE traffic_queries SET response=? WHERE id=?");
  for (const row of db
    .prepare(
      "SELECT id,response FROM traffic_queries WHERE response IS NOT NULL",
    )
    .iterate()) {
    const original = String(row.response);
    const packed = packTrafficArchive(original);
    if (packed !== original) update.run(packed, row.id);
  }
}

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
/** Preserve custom provenance, while canonical feed identity never depends on a label. */
export function trafficSourceKeySql(endpoint: string, source: string) {
  return `CASE ${Object.entries(trafficSourceLabels)
    .map(
      ([key, label]) =>
        `WHEN ${endpoint}=${literal(key)} AND ${source}=${literal(label)} THEN ${literal(key)}`,
    )
    .join(" ")} ELSE ${endpoint}||':source:'||hex(CAST(${source} AS BLOB)) END`;
}

/** v35 reuses current entries as source-specific snapshots, without another current table. */
export function migrateTrafficCurrentEntries(db: DatabaseSync) {
  // Refuse broken legacy references before joins can hide their only surviving facts.
  if (db.prepare("PRAGMA foreign_key_check(traffic_observations)").get())
    throw new Error(
      "FOREIGN KEY constraint failed in traffic observations; original data retained.",
    );
  db.exec(`
    DROP VIEW traffic_items;
    DROP TRIGGER IF EXISTS traffic_observations_insert;
    DROP TRIGGER IF EXISTS traffic_observations_delete;
    DROP TRIGGER IF EXISTS traffic_queries_revision_insert;
    DROP TRIGGER IF EXISTS traffic_queries_revision_update;
    DROP TRIGGER IF EXISTS traffic_queries_revision_delete;
    ALTER TABLE traffic_entries RENAME TO traffic_entries_v34;
    ALTER TABLE traffic_observations RENAME TO traffic_observations_v34;
    DROP INDEX IF EXISTS traffic_entries_recent;
    DROP INDEX IF EXISTS traffic_entries_word;
    DROP INDEX IF EXISTS traffic_entries_monthly;
    DROP INDEX IF EXISTS traffic_entries_source;
    DROP INDEX IF EXISTS traffic_entries_volume;
    DROP INDEX IF EXISTS traffic_observations_entry;
    DROP INDEX IF EXISTS traffic_observations_source;
    DROP INDEX IF EXISTS traffic_observations_query;
    CREATE TABLE traffic_entries(
      seq INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,normalized_word TEXT NOT NULL,platform TEXT NOT NULL DEFAULT '',
      source_key TEXT NOT NULL,endpoint TEXT NOT NULL,source TEXT NOT NULL,word TEXT NOT NULL,
      is_longtail INTEGER NOT NULL DEFAULT 0,
      latest_observation_seq INTEGER,first_observed_at TEXT,last_observed_at TEXT NOT NULL DEFAULT '',
      observation_count INTEGER NOT NULL DEFAULT 0,monthly_searches REAL,volume_kind TEXT NOT NULL DEFAULT 'unknown',
      UNIQUE(kind,normalized_word,platform,source_key));
    CREATE TABLE traffic_observations(
      seq INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,
      query_id TEXT NOT NULL REFERENCES traffic_queries(id),endpoint TEXT NOT NULL,
      entry_id TEXT NOT NULL REFERENCES traffic_entries(id),word TEXT NOT NULL,
      metrics TEXT NOT NULL,observed_at TEXT,source_updated_at TEXT);
    CREATE TEMP TABLE traffic_entry_source_migration AS
      WITH groups AS (
        SELECT e.id old_id,e.rowid old_seq,e.kind,e.normalized_word,e.platform,e.source,
          o.endpoint,${trafficSourceKeySql("o.endpoint", "e.source")} source_key,
          min(o.seq) first_seq,max(CASE WHEN o.id=e.latest_observation_id THEN 1 ELSE 0 END) current_group
        FROM traffic_entries_v34 e JOIN traffic_observations_v34 o ON o.entry_id=e.id
        GROUP BY e.id,o.endpoint
      ) SELECT *,CASE WHEN row_number() OVER(PARTITION BY old_id ORDER BY current_group DESC,first_seq)=1
        THEN old_id ELSE 'entry_'||lower(hex(randomblob(16))) END new_id FROM groups;
    CREATE INDEX temp.traffic_entry_source_old ON traffic_entry_source_migration(old_id,endpoint);
    INSERT INTO traffic_entries(seq,id,kind,normalized_word,platform,source_key,endpoint,source,word,is_longtail)
      SELECT g.old_seq,g.new_id,g.kind,g.normalized_word,g.platform,g.source_key,g.endpoint,g.source,e.word,
        CASE WHEN g.kind='word' AND g.endpoint IN ('baidu-discovery','longtail') THEN 1 ELSE 0 END
      FROM traffic_entry_source_migration g JOIN traffic_entries_v34 e ON e.id=g.old_id WHERE g.new_id=g.old_id;
    INSERT INTO traffic_entries(id,kind,normalized_word,platform,source_key,endpoint,source,word,is_longtail)
      SELECT g.new_id,g.kind,g.normalized_word,g.platform,g.source_key,g.endpoint,g.source,e.word,
        CASE WHEN g.kind='word' AND g.endpoint IN ('baidu-discovery','longtail') THEN 1 ELSE 0 END
      FROM traffic_entry_source_migration g JOIN traffic_entries_v34 e ON e.id=g.old_id WHERE g.new_id<>g.old_id;
    INSERT INTO traffic_observations(seq,id,query_id,endpoint,entry_id,word,metrics,observed_at,source_updated_at)
      SELECT o.seq,o.id,o.query_id,o.endpoint,g.new_id,o.word,o.metrics,o.observed_at,o.source_updated_at
      FROM traffic_observations_v34 o JOIN traffic_entry_source_migration g ON g.old_id=o.entry_id AND g.endpoint=o.endpoint;
    UPDATE traffic_entries AS e SET latest_observation_seq=r.seq,first_observed_at=r.first_at,
      last_observed_at=coalesce(r.observed_at,''),observation_count=r.n,word=r.word,
      monthly_searches=${metricMonthly("r.metrics")},volume_kind=${metricVolume("r.metrics")}
      FROM (SELECT o.*,row_number() OVER(PARTITION BY entry_id ORDER BY coalesce(observed_at,'') DESC,seq DESC) recent,
        count(*) OVER(PARTITION BY entry_id) n,min(observed_at) OVER(PARTITION BY entry_id) first_at
        FROM traffic_observations o) r WHERE r.entry_id=e.id AND r.recent=1;
    DROP TABLE traffic_observations_v34;
    DROP TABLE traffic_entries_v34;
    DROP TABLE temp.traffic_entry_source_migration;
    CREATE INDEX traffic_entries_recent ON traffic_entries(last_observed_at DESC,seq DESC);
    CREATE INDEX traffic_entries_word ON traffic_entries(word,seq);
    CREATE INDEX traffic_entries_monthly ON traffic_entries(monthly_searches DESC,seq DESC);
    CREATE INDEX traffic_entries_source ON traffic_entries(endpoint,last_observed_at DESC,seq DESC);
    CREATE INDEX traffic_entries_identity_source ON traffic_entries(source_key,kind,normalized_word);
    CREATE INDEX traffic_entries_volume ON traffic_entries(volume_kind,last_observed_at DESC,seq DESC);
    CREATE INDEX traffic_entries_longtail_recent ON traffic_entries(is_longtail,last_observed_at DESC,seq DESC);
    CREATE INDEX traffic_entries_longtail_monthly ON traffic_entries(is_longtail,monthly_searches DESC,seq DESC);
    CREATE INDEX traffic_observations_entry ON traffic_observations(entry_id,coalesce(observed_at,'') DESC,seq DESC);
    CREATE INDEX traffic_observations_query ON traffic_observations(query_id,entry_id);
    CREATE TABLE IF NOT EXISTS traffic_knowledge_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO traffic_knowledge_state(id,revision) VALUES(1,1);
    CREATE VIEW traffic_items AS SELECT o.seq rowid,o.id,o.query_id,e.kind,o.word,e.normalized_word,
      nullif(e.platform,'') platform,e.source,o.metrics,'{}' data,o.observed_at,o.source_updated_at,e.id entry_id,e.source_key
      FROM traffic_observations o JOIN traffic_entries e ON e.id=o.entry_id;
    CREATE TRIGGER traffic_items_insert INSTEAD OF INSERT ON traffic_items BEGIN
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM traffic_queries WHERE id=new.query_id)
        THEN RAISE(ABORT,'traffic query missing') END;
      INSERT OR IGNORE INTO traffic_entries(id,kind,normalized_word,platform,source_key,endpoint,source,word,is_longtail)
        SELECT 'entry_'||new.id,new.kind,new.normalized_word,coalesce(new.platform,''),
          coalesce(new.source_key,${trafficSourceKeySql("q.endpoint", "new.source")}),q.endpoint,new.source,new.word,
          CASE WHEN new.kind='word' AND q.endpoint IN ('baidu-discovery','longtail') THEN 1 ELSE 0 END
        FROM traffic_queries q WHERE q.id=new.query_id;
      INSERT INTO traffic_observations(id,query_id,endpoint,entry_id,word,metrics,observed_at,source_updated_at)
        SELECT new.id,new.query_id,q.endpoint,e.id,new.word,new.metrics,new.observed_at,new.source_updated_at
        FROM traffic_entries e JOIN traffic_queries q ON q.id=new.query_id
        WHERE e.kind=new.kind AND e.normalized_word=new.normalized_word AND e.platform=coalesce(new.platform,'')
          AND e.source_key=coalesce(new.source_key,${trafficSourceKeySql("q.endpoint", "new.source")});
      UPDATE traffic_entries SET source=new.source WHERE new.source_key IS NOT NULL AND id=(SELECT entry_id FROM traffic_observations WHERE id=new.id);
    END;
    CREATE TRIGGER traffic_observations_insert AFTER INSERT ON traffic_observations BEGIN
      UPDATE traffic_queries SET item_count=item_count+1 WHERE id=new.query_id;
      UPDATE traffic_entries SET observation_count=observation_count+1,
        first_observed_at=CASE WHEN first_observed_at IS NULL THEN new.observed_at
          WHEN new.observed_at IS NULL THEN first_observed_at ELSE min(first_observed_at,new.observed_at) END
        WHERE id=new.entry_id;
      UPDATE traffic_entries SET latest_observation_seq=new.seq,word=new.word,last_observed_at=coalesce(new.observed_at,''),
        monthly_searches=${metricMonthly("new.metrics")},volume_kind=${metricVolume("new.metrics")}
        WHERE id=new.entry_id AND (latest_observation_seq IS NULL OR last_observed_at<=coalesce(new.observed_at,''));
      UPDATE traffic_knowledge_state SET revision=revision+1 WHERE id=1;
    END;
    CREATE TRIGGER traffic_items_delete INSTEAD OF DELETE ON traffic_items BEGIN
      DELETE FROM traffic_observations WHERE id=old.id;
    END;
    CREATE TRIGGER traffic_observations_delete AFTER DELETE ON traffic_observations BEGIN
      UPDATE traffic_queries SET item_count=item_count-1 WHERE id=old.query_id;
      UPDATE traffic_entries SET observation_count=observation_count-1 WHERE id=old.entry_id;
      UPDATE traffic_entries SET latest_observation_seq=(SELECT seq FROM traffic_observations WHERE entry_id=old.entry_id
        ORDER BY coalesce(observed_at,'') DESC,seq DESC LIMIT 1),
        first_observed_at=(SELECT min(observed_at) FROM traffic_observations WHERE entry_id=old.entry_id) WHERE id=old.entry_id;
      DELETE FROM traffic_entries WHERE id=old.entry_id AND observation_count=0;
      UPDATE traffic_entries SET word=(SELECT word FROM traffic_observations WHERE seq=latest_observation_seq),
        last_observed_at=coalesce((SELECT observed_at FROM traffic_observations WHERE seq=latest_observation_seq),''),
        monthly_searches=${metricMonthly("(SELECT metrics FROM traffic_observations WHERE seq=latest_observation_seq)")},
        volume_kind=${metricVolume("(SELECT metrics FROM traffic_observations WHERE seq=latest_observation_seq)")}
        WHERE id=old.entry_id;
      UPDATE traffic_knowledge_state SET revision=revision+1 WHERE id=1;
    END;
    CREATE TRIGGER traffic_queries_revision_insert AFTER INSERT ON traffic_queries BEGIN
      UPDATE traffic_knowledge_state SET revision=revision+1 WHERE id=1;
    END;
    CREATE TRIGGER traffic_queries_revision_update AFTER UPDATE OF response,seeds,platform,legacy,endpoint,phase ON traffic_queries BEGIN
      UPDATE traffic_knowledge_state SET revision=revision+1 WHERE id=1;
    END;
    CREATE TRIGGER traffic_queries_revision_delete AFTER DELETE ON traffic_queries BEGIN
      UPDATE traffic_knowledge_state SET revision=revision+1 WHERE id=1;
    END;
  `);
}

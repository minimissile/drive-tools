import { defaultContentFormat, type Platform } from "../shared/channels";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { migrateDistribution } from "./distribution/migration";

export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const json = (v: unknown) => JSON.stringify(v);
export const databaseSchemaVersion = 28;
export const parseJson = <T>(value: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};
export class Database {
  readonly db: DatabaseSync;
  constructor(public path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    try {
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  get<T>(sql: string, ...values: (string | number | null)[]): T | undefined {
    return this.db.prepare(sql).get(...values) as T | undefined;
  }
  all<T>(sql: string, ...values: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...values) as T[];
  }
  run(sql: string, ...values: (string | number | null)[]) {
    return this.db.prepare(sql).run(...values);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  setting<T>(key: string, fallback: T): T {
    return parseJson(
      this.get<{ value: string }>("SELECT value FROM settings WHERE key=?", key)
        ?.value,
      fallback,
    );
  }
  setSetting(key: string, value: unknown) {
    this.run(
      "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      json(value),
    );
  }
  close() {
    this.db.close();
  }
  private migrate(backupExisting = true): void {
    const version = Number(
      this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0,
    );
    if (version > databaseSchemaVersion) throw new Error("数据库来自更新版本，请升级盘序后打开。");
    if (version === databaseSchemaVersion) return;
    if (version === 27) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v28-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() => this.db.exec(`
        CREATE TABLE zhidao_answer_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES operation_runs(id) ON DELETE CASCADE,level TEXT NOT NULL,message TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE INDEX zhidao_answer_logs_run ON zhidao_answer_logs(run_id,id DESC);
        PRAGMA user_version=28;
      `));
      return;
    }
    if (version === 26) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v27-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() => this.db.exec(`
        CREATE TABLE resource_links(id TEXT PRIMARY KEY, resource_id TEXT NOT NULL UNIQUE REFERENCES resources(id) ON DELETE CASCADE, slug TEXT NOT NULL, base_url TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(base_url,slug));
        PRAGMA user_version=27;
      `));
      this.migrate(false);
      return;
    }
    if (version === 25) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v26-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() => this.db.exec(`
        ALTER TABLE distribution_task_sources RENAME TO distribution_task_sources_v1;
        CREATE TABLE distribution_task_sources(platform_id TEXT NOT NULL,share_record_id TEXT NOT NULL,
          task_id TEXT NOT NULL REFERENCES distribution_tasks(id),resource_id TEXT NOT NULL,
          copy_id TEXT NOT NULL,split_item_id TEXT,active INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY(task_id,share_record_id));
        INSERT INTO distribution_task_sources SELECT platform_id,share_record_id,task_id,resource_id,copy_id,split_item_id,1 FROM distribution_task_sources_v1;
        DROP TABLE distribution_task_sources_v1;
        CREATE UNIQUE INDEX distribution_current_source ON distribution_task_sources(platform_id,share_record_id) WHERE active=1;
        CREATE INDEX distribution_source_lookup ON distribution_task_sources(task_id,active,share_record_id);
        CREATE INDEX distribution_source_resource ON distribution_task_sources(platform_id,resource_id,split_item_id,task_id);
        UPDATE distribution_tasks SET status='superseded' WHERE status='skipped' AND submitted_at IS NULL AND message='尚未投稿的旧链接已被资源库中的新分享替换。';
        PRAGMA user_version=26;
      `));
      this.migrate(false);
      return;
    }
    if (version === 24) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v25-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() => this.db.exec(`
        ALTER TABLE distribution_tasks ADD COLUMN accepted_at TEXT;
        UPDATE distribution_tasks SET accepted_at=(SELECT MIN(at) FROM distribution_events e WHERE e.task_id=distribution_tasks.id AND e.status IN ('submitted','processing','reviewing','published'));
        CREATE INDEX distribution_delivery_progress ON distribution_tasks(platform_id,accepted_at);
        CREATE INDEX distribution_source_lookup ON distribution_task_sources(task_id,share_record_id);
        PRAGMA user_version=25;
      `));
      this.migrate(false);
      return;
    }
    if (version === 23) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v24-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() => migrateDistribution(this.db));
      this.migrate(false);
      return;
    }
    if (version === 22) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v23-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() => this.db.exec(`
        CREATE TABLE distribution_tasks(id TEXT PRIMARY KEY,platform_id TEXT NOT NULL,resource_id TEXT NOT NULL,copy_id TEXT NOT NULL,share_key TEXT NOT NULL,status TEXT NOT NULL,submitted_at TEXT,data TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(platform_id,resource_id),UNIQUE(platform_id,share_key));
        CREATE INDEX distribution_platform_status ON distribution_tasks(platform_id,status,updated_at);
        PRAGMA user_version=23;
      `));
      this.migrate(false);
      return;
    }
    if (version === 21) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v22-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() => this.db.exec(`
        CREATE TABLE content_source_responses(id TEXT PRIMARY KEY,provider TEXT NOT NULL,query_key TEXT NOT NULL,cursor TEXT NOT NULL,page INTEGER NOT NULL,generation TEXT NOT NULL,request TEXT NOT NULL,status TEXT NOT NULL,http_status INTEGER,response TEXT,parsed TEXT,message TEXT NOT NULL DEFAULT '',fetched_at TEXT NOT NULL);
        CREATE INDEX content_responses_query ON content_source_responses(provider,query_key,generation,page);
        CREATE TABLE content_knowledge_items(provider TEXT NOT NULL,source_id TEXT NOT NULL,text TEXT NOT NULL,author TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,raw TEXT NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,PRIMARY KEY(provider,source_id));
        CREATE TABLE content_knowledge_hits(response_id TEXT NOT NULL REFERENCES content_source_responses(id),provider TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(response_id,source_id));
        CREATE INDEX content_knowledge_source ON content_knowledge_hits(provider,source_id);
        PRAGMA user_version=22;
      `));
      this.migrate(false);
      return;
    }
    if (version === 20) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v21-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() => {
        this.db.exec("CREATE TABLE content_source_exports(id TEXT PRIMARY KEY,provider TEXT NOT NULL,source_id TEXT NOT NULL,channel TEXT NOT NULL,account_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(provider,source_id,channel,account_id));");
        for (const row of this.all<{id:string; data:string}>("SELECT id,data FROM pipix_sources")) {
          const source = JSON.parse(row.data), contentId = source.contentId;
          delete source.contentId;
          for (const image of source.images ?? [])
            if (image.asset && !image.asset.storage) image.asset.storage = "zhihu-assets";
          if (contentId) {
            const content = this.get<{data:string}>("SELECT data FROM zhihu_contents WHERE id=?", contentId);
            const delivery = { id: id("sourceexport"), provider: "pipix", sourceId: row.id, channel: "zhihu", accountId: "", targetId: contentId, title: content ? JSON.parse(content.data).title : source.text?.slice(0,100) || "已有知乎素材", createdAt: source.collectedAt };
            this.run("INSERT INTO content_source_exports VALUES(?,?,?,?,?,?)", delivery.id, "pipix", row.id, "zhihu", "", JSON.stringify(delivery));
          }
          this.run("UPDATE pipix_sources SET data=? WHERE id=?", JSON.stringify(source), row.id);
        }
        this.db.exec("PRAGMA user_version=21");
      });
      this.migrate(false);
      return;
    }
    if (version === 19) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v20-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() => this.db.exec(`
        CREATE TABLE pipix_sources(id TEXT PRIMARY KEY,data TEXT NOT NULL);
        PRAGMA user_version=20;
      `));
      this.migrate(false);
      return;
    }
    if (version === 18) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v19-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() => this.db.exec(`
        CREATE TABLE zhihu_contents(id TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE zhihu_tasks(id TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE zhihu_plans(id TEXT PRIMARY KEY,data TEXT NOT NULL);
        PRAGMA user_version=19;
      `));
      this.migrate(false);
      return;
    }
    if (version === 17) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v18-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() => this.db.exec(`
        ALTER TABLE browser_environment_accounts RENAME TO browser_environment_accounts_v17;
        CREATE TABLE browser_environment_accounts(kind TEXT NOT NULL,account_id TEXT NOT NULL,environment_id TEXT NOT NULL REFERENCES browser_environments(id),identity_id TEXT NOT NULL REFERENCES browser_environment_identities(id),realm TEXT NOT NULL,platform TEXT NOT NULL,uid TEXT,verified_revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,account_id));
        INSERT INTO browser_environment_accounts SELECT * FROM browser_environment_accounts_v17;
        DROP TABLE browser_environment_accounts_v17;
        CREATE INDEX environment_account_identity ON browser_environment_accounts(identity_id);
        CREATE TABLE browser_environment_jobs(id TEXT PRIMARY KEY,status TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE INDEX environment_jobs_history ON browser_environment_jobs(created_at DESC);
        PRAGMA user_version=18;
      `));
      this.migrate(false);
      return;
    }
    if (version === 16) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v17-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() => this.db.exec(`
        CREATE TABLE browser_environments(id TEXT PRIMARY KEY,engine TEXT NOT NULL,profile_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(engine,profile_id));
        CREATE TABLE browser_environment_identities(id TEXT PRIMARY KEY,environment_id TEXT NOT NULL REFERENCES browser_environments(id),realm TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,UNIQUE(environment_id,realm));
        CREATE TABLE browser_environment_accounts(kind TEXT NOT NULL,account_id TEXT NOT NULL,environment_id TEXT NOT NULL REFERENCES browser_environments(id),identity_id TEXT NOT NULL REFERENCES browser_environment_identities(id),realm TEXT NOT NULL,platform TEXT NOT NULL,uid TEXT,verified_revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,account_id));
        CREATE INDEX environment_account_identity ON browser_environment_accounts(identity_id);
        PRAGMA user_version=17;
      `));
      this.migrate(false);
      return;
    }
    if (version === 15) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v16-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() => this.db.exec(`
        ALTER TABLE website_accounts ADD COLUMN nickname TEXT;
        ALTER TABLE website_accounts ADD COLUMN checked_at TEXT;
        ALTER TABLE browser_bindings ADD COLUMN website_account_id TEXT;
        CREATE UNIQUE INDEX binding_website_account ON browser_bindings(website_account_id) WHERE website_account_id IS NOT NULL;
        PRAGMA user_version=16;
      `));
      this.migrate(false);
      return;
    }
    if (version === 14) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v15-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() => this.db.exec(`
        CREATE TABLE website_accounts(id TEXT PRIMARY KEY,provider TEXT NOT NULL,alias TEXT NOT NULL,uid TEXT,status TEXT NOT NULL DEFAULT 'disconnected',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        PRAGMA user_version=15;
      `));
      this.migrate(false);
      return;
    }
    if (version === 13) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v14-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() =>
        this.db.exec(`
        CREATE TABLE zhidao_accounts(id TEXT PRIMARY KEY,data TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE operation_runs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,config TEXT NOT NULL,total INTEGER NOT NULL,done INTEGER NOT NULL DEFAULT 0,message TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE INDEX operation_runs_history ON operation_runs(kind,created_at DESC);
        CREATE TABLE operation_items(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES operation_runs(id) ON DELETE CASCADE,item_key TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(run_id,item_key));
        CREATE INDEX operation_items_run ON operation_items(run_id,status);
        CREATE TABLE mining_history(category TEXT NOT NULL,word TEXT NOT NULL,seen_at TEXT NOT NULL,PRIMARY KEY(category,word));
        CREATE TABLE drive_share_intents(account_id TEXT NOT NULL,file_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(account_id,file_id));
        ALTER TABLE resources ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'share';
        PRAGMA user_version=14;
      `),
      );
      this.migrate(false);
      return;
    }
    if (version === 12) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v13-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() =>
        this.db.exec(`
        CREATE TABLE insertion_materials(id TEXT PRIMARY KEY,data TEXT NOT NULL,content TEXT NOT NULL);
        CREATE TABLE insertion_runs(id TEXT PRIMARY KEY,data TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE INDEX insertion_runs_history ON insertion_runs(created_at DESC);
        PRAGMA user_version=13;
      `),
      );
      this.migrate(false);
      return;
    }
    if (version === 11) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v12-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() =>
        this.db.exec(`
        CREATE TABLE publication_targets(publication_id TEXT PRIMARY KEY REFERENCES publications(id),data TEXT NOT NULL);
        PRAGMA user_version=12;
      `),
      );
      return this.migrate(false);
    }
    if (version === 10) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v11-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() =>
        this.db.exec(`
        CREATE TABLE publication_delivery_checks(id TEXT PRIMARY KEY,publication_id TEXT NOT NULL REFERENCES publications(id),data TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE INDEX publication_delivery_checks_history ON publication_delivery_checks(publication_id,created_at DESC);
        PRAGMA user_version=11;
      `),
      );
      this.migrate(false);
      return;
    }
    if (version === 9) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v10-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() => {
        this.db
          .exec(`ALTER TABLE drafts ADD COLUMN content_format TEXT NOT NULL DEFAULT '';
          ALTER TABLE browser_bindings ADD COLUMN capabilities TEXT NOT NULL DEFAULT '{"formats":[],"linkPositions":[]}';`);
        for (const row of this.all<{ id: string; platform: Platform }>(
          "SELECT id,platform FROM drafts",
        )) {
          this.run(
            "UPDATE drafts SET content_format=? WHERE id=?",
            defaultContentFormat(row.platform),
            row.id,
          );
        }
        for (const row of this.all<{
          id: string;
          platform: Platform;
          link_permission: string;
        }>("SELECT id,platform,link_permission FROM browser_bindings")) {
          this.run(
            "UPDATE browser_bindings SET capabilities=? WHERE id=?",
            json({
              formats: [defaultContentFormat(row.platform)],
              linkPositions: row.link_permission === "allowed" ? ["body"] : [],
            }),
            row.id,
          );
        }
        this.db.exec("PRAGMA user_version=10;");
      });
      this.migrate(false);
      return;
    }
    if (version === 8) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v9-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() =>
        this.db.exec(`
        CREATE TABLE studio_packages(draft_id TEXT PRIMARY KEY REFERENCES drafts(id),data TEXT NOT NULL);
        CREATE TABLE studio_jobs(id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES drafts(id),data TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE INDEX studio_jobs_draft ON studio_jobs(draft_id,created_at);
        CREATE TABLE studio_templates(id TEXT PRIMARY KEY,data TEXT NOT NULL);
        PRAGMA user_version=9;
      `),
      );
      this.migrate(false);
      return;
    }
    if (version === 7) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v8-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() =>
        this.db.exec(`
        CREATE TABLE traffic_knowledge_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE traffic_queries(id TEXT PRIMARY KEY,origin TEXT UNIQUE,call_id TEXT,endpoint TEXT NOT NULL,phase TEXT NOT NULL,request TEXT NOT NULL,seeds TEXT NOT NULL,platform TEXT,status TEXT NOT NULL,started_at TEXT,received_at TEXT,http_status INTEGER,response TEXT,message TEXT NOT NULL DEFAULT '',legacy INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX traffic_queries_time ON traffic_queries(received_at DESC,started_at DESC);
        CREATE TABLE traffic_items(id TEXT PRIMARY KEY,query_id TEXT NOT NULL REFERENCES traffic_queries(id),kind TEXT NOT NULL,word TEXT NOT NULL,normalized_word TEXT NOT NULL,platform TEXT,source TEXT NOT NULL,metrics TEXT NOT NULL,data TEXT NOT NULL,observed_at TEXT,source_updated_at TEXT);
        CREATE INDEX traffic_items_word ON traffic_items(normalized_word,platform,observed_at DESC);
        CREATE INDEX traffic_items_query ON traffic_items(query_id);
        PRAGMA user_version=8;
      `),
      );
      this.migrate(false);
      return;
    }
    if (version === 6) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v7-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() =>
        this.db.exec(`
        CREATE TABLE share_statistics(account_id TEXT NOT NULL REFERENCES accounts(id),share_id TEXT NOT NULL,owner_uid TEXT NOT NULL,data TEXT NOT NULL,synced_at TEXT NOT NULL,present INTEGER NOT NULL DEFAULT 1,previous_metrics TEXT,previous_at TEXT,PRIMARY KEY(account_id,share_id));
        CREATE TABLE share_statistics_syncs(account_id TEXT PRIMARY KEY REFERENCES accounts(id),status TEXT NOT NULL,attempted_at TEXT,succeeded_at TEXT,share_count INTEGER NOT NULL DEFAULT 0,error TEXT);
        PRAGMA user_version=7;
      `),
      );
      this.migrate(false);
      return;
    }
    if (version === 5) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v6-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() =>
        this.db.exec(`
        CREATE TABLE search_topics(id TEXT PRIMARY KEY,keyword TEXT NOT NULL,normalized_keyword TEXT NOT NULL,intent TEXT NOT NULL DEFAULT '',platform TEXT NOT NULL,pool_id TEXT REFERENCES pools(id),keyword_id TEXT,copy_id TEXT REFERENCES copies(id),split_item_id TEXT REFERENCES split_items(id),software_version TEXT NOT NULL DEFAULT '',operating_system TEXT NOT NULL DEFAULT '',evidence TEXT NOT NULL DEFAULT '',archived INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE UNIQUE INDEX search_topics_keyword ON search_topics(normalized_keyword,platform) WHERE archived=0;
        ALTER TABLE drafts ADD COLUMN topic_id TEXT REFERENCES search_topics(id);
        ALTER TABLE drafts ADD COLUMN split_item_id TEXT REFERENCES split_items(id);
        ALTER TABLE drafts ADD COLUMN split_share_version INTEGER;
        CREATE INDEX drafts_topic ON drafts(topic_id,updated_at DESC);
        CREATE TABLE effect_records(id TEXT PRIMARY KEY,topic_id TEXT REFERENCES search_topics(id),publication_id TEXT NOT NULL REFERENCES publications(id),binding_id TEXT NOT NULL REFERENCES browser_bindings(id),scope TEXT NOT NULL CHECK(scope IN ('article','account')),period_start TEXT NOT NULL,period_end TEXT NOT NULL,views INTEGER,saves INTEGER,new_users INTEGER,revenue_cents INTEGER,source TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE UNIQUE INDEX effect_article_period ON effect_records(publication_id,period_start,period_end,source) WHERE scope='article';
        CREATE UNIQUE INDEX effect_account_period ON effect_records(binding_id,period_start,period_end,source) WHERE scope='account';
        PRAGMA user_version=6;
      `),
      );
      this.migrate(false);
      return;
    }
    if (version === 4) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v5-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() =>
        this.db.exec(`
        ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'transfer';
        ALTER TABLE jobs ADD COLUMN target_id TEXT;
        ALTER TABLE jobs ADD COLUMN batch_id TEXT;
        CREATE TABLE transfer_batches(id TEXT PRIMARY KEY,created_at TEXT NOT NULL);
        CREATE TABLE transfer_batch_items(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES transfer_batches(id),copy_id TEXT NOT NULL REFERENCES copies(id),state TEXT NOT NULL DEFAULT 'pending',files TEXT NOT NULL DEFAULT '[]',selected_ids TEXT NOT NULL DEFAULT '[]',owner_uid TEXT,error TEXT,inspect_job_id TEXT NOT NULL REFERENCES jobs(id),transfer_job_id TEXT REFERENCES jobs(id),UNIQUE(batch_id,copy_id));
        CREATE TABLE split_runs(id TEXT PRIMARY KEY,copy_id TEXT NOT NULL REFERENCES copies(id),depth INTEGER NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',error TEXT,job_id TEXT NOT NULL REFERENCES jobs(id),created_at TEXT NOT NULL);
        CREATE TABLE split_items(id TEXT PRIMARY KEY,copy_id TEXT NOT NULL REFERENCES copies(id),file_id TEXT NOT NULL,file TEXT NOT NULL,ancestors TEXT NOT NULL,path TEXT NOT NULL,depth INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'draft',share_id TEXT,share_url TEXT,owner_uid TEXT,verified_at TEXT,share_version INTEGER NOT NULL DEFAULT 0,error TEXT,job_id TEXT REFERENCES jobs(id),UNIQUE(copy_id,file_id));
        CREATE TABLE split_run_items(run_id TEXT NOT NULL REFERENCES split_runs(id),item_id TEXT NOT NULL REFERENCES split_items(id),PRIMARY KEY(run_id,item_id));
        CREATE INDEX jobs_kind_target ON jobs(kind,target_id);
        PRAGMA user_version=5;
      `),
      );
      this.migrate(false);
      return;
    }
    if (version === 3) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v4-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() =>
        this.db.exec(
          "CREATE TABLE share_checks(copy_id TEXT PRIMARY KEY REFERENCES copies(id),status TEXT NOT NULL,checked_at TEXT NOT NULL,message TEXT NOT NULL); PRAGMA user_version=4;",
        ),
      );
      this.migrate(false);
      return;
    }
    if (version === 2) {
      if (backupExisting && this.path !== ":memory:") {
        const backup = `${this.path}.before-v3-${randomUUID()}.bak`;
        this.db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
      }
      this.transaction(() =>
        this.db.exec(`
        CREATE TABLE suggestion_queries(id TEXT PRIMARY KEY,seed TEXT NOT NULL,platform TEXT NOT NULL,key_revision TEXT NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',result TEXT,created_at TEXT NOT NULL,last_requested_at TEXT NOT NULL,UNIQUE(seed,platform,key_revision));
        ALTER TABLE browser_bindings ADD COLUMN last_checked_at TEXT;
        ALTER TABLE browser_bindings ADD COLUMN last_opened_at TEXT;
        ALTER TABLE browser_bindings ADD COLUMN open_error TEXT;
        PRAGMA user_version=3;
      `),
      );
      this.migrate(false);
      return;
    }
    if (version === 1) {
      this.transaction(() =>
        this.db.exec(
          "ALTER TABLE async_queries ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'; ALTER TABLE async_queries ADD COLUMN result TEXT; PRAGMA user_version=2;",
        ),
      );
      this.migrate(backupExisting);
      return;
    }
    this.transaction(() =>
      this.db.exec(`
      CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE secrets(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE accounts(id TEXT PRIMARY KEY,provider TEXT NOT NULL,alias TEXT NOT NULL,uid TEXT,status TEXT NOT NULL DEFAULT 'disconnected',enabled INTEGER NOT NULL DEFAULT 1,is_default INTEGER NOT NULL DEFAULT 0,default_directory TEXT NOT NULL DEFAULT '/盘序资源',verified_at TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(provider,uid));
      CREATE TABLE resources(id TEXT PRIMARY KEY,title TEXT NOT NULL,source_url TEXT NOT NULL UNIQUE,source_key TEXT NOT NULL,provider TEXT NOT NULL,category TEXT NOT NULL,tags TEXT NOT NULL,summary TEXT NOT NULL,cover_id TEXT,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE resource_search USING fts5(title,summary,tags,content='resources',content_rowid='rowid',tokenize='trigram');
      CREATE TRIGGER resource_ai AFTER INSERT ON resources BEGIN INSERT INTO resource_search(rowid,title,summary,tags) VALUES(new.rowid,new.title,new.summary,new.tags); END;
      CREATE TRIGGER resource_ad AFTER DELETE ON resources BEGIN INSERT INTO resource_search(resource_search,rowid,title,summary,tags) VALUES('delete',old.rowid,old.title,old.summary,old.tags); END;
      CREATE TRIGGER resource_au AFTER UPDATE ON resources BEGIN INSERT INTO resource_search(resource_search,rowid,title,summary,tags) VALUES('delete',old.rowid,old.title,old.summary,old.tags); INSERT INTO resource_search(rowid,title,summary,tags) VALUES(new.rowid,new.title,new.summary,new.tags); END;
      CREATE TABLE copies(id TEXT PRIMARY KEY,resource_id TEXT NOT NULL REFERENCES resources(id),account_id TEXT NOT NULL REFERENCES accounts(id),directory TEXT NOT NULL,folder_id TEXT,files TEXT NOT NULL DEFAULT '[]',selected_files TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL DEFAULT 'draft',owner_uid TEXT,verified_at TEXT,share_id TEXT,share_url TEXT,share_owner_uid TEXT,share_version INTEGER NOT NULL DEFAULT 0,share_verified_at TEXT,note_status TEXT NOT NULL DEFAULT 'not_configured',error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(resource_id,account_id,directory));
      CREATE TABLE jobs(id TEXT PRIMARY KEY,copy_id TEXT NOT NULL REFERENCES copies(id),stage TEXT NOT NULL,checkpoint TEXT NOT NULL DEFAULT 'new',metadata TEXT NOT NULL DEFAULT '{}',attempts INTEGER NOT NULL DEFAULT 0,error TEXT,logs TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX jobs_account_stage ON jobs(stage,copy_id);
      CREATE TABLE pools(id TEXT PRIMARY KEY,name TEXT NOT NULL,resource_id TEXT REFERENCES resources(id),keywords TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE drafts(id TEXT PRIMARY KEY,resource_id TEXT NOT NULL REFERENCES resources(id),copy_id TEXT NOT NULL REFERENCES copies(id),platform TEXT NOT NULL,pool_id TEXT REFERENCES pools(id),title TEXT NOT NULL,body TEXT NOT NULL,tags TEXT NOT NULL,cover_text TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,resource_revision INTEGER NOT NULL,share_version INTEGER NOT NULL,model TEXT NOT NULL,reviewed INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE browser_bindings(id TEXT PRIMARY KEY,platform TEXT NOT NULL,alias TEXT NOT NULL,window_id TEXT NOT NULL,editor_url TEXT NOT NULL,link_permission TEXT NOT NULL DEFAULT 'none',rule_note TEXT NOT NULL DEFAULT '',verified_at TEXT);
      CREATE TABLE publications(id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES drafts(id),draft_version INTEGER NOT NULL,binding_id TEXT NOT NULL REFERENCES browser_bindings(id),status TEXT NOT NULL,url TEXT,created_at TEXT NOT NULL);
      CREATE TABLE api_plans(endpoint TEXT PRIMARY KEY,unit_price_micros INTEGER,daily_units INTEGER NOT NULL DEFAULT 100,daily_budget_micros INTEGER,enabled INTEGER NOT NULL DEFAULT 0);
      INSERT INTO api_plans(endpoint) VALUES('longtail'),('suggest'),('metrics'),('radar');
      CREATE TABLE api_calls(id TEXT PRIMARY KEY,endpoint TEXT NOT NULL,phase TEXT NOT NULL,units INTEGER NOT NULL,request_count INTEGER NOT NULL DEFAULT 1,estimated_micros INTEGER,reserved_micros INTEGER,confirmed_micros INTEGER,status TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
      CREATE INDEX api_calls_daily ON api_calls(endpoint,created_at);
      CREATE TABLE api_cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at TEXT NOT NULL);
      CREATE TABLE async_queries(task_id TEXT PRIMARY KEY,endpoint TEXT NOT NULL,seeds TEXT NOT NULL,last_polled_at TEXT,created_at TEXT NOT NULL);
      CREATE TABLE outbox(id TEXT PRIMARY KEY,copy_id TEXT NOT NULL REFERENCES copies(id),kind TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',error TEXT,created_at TEXT NOT NULL);
      CREATE TABLE note_exports(copy_id TEXT PRIMARY KEY REFERENCES copies(id),path TEXT NOT NULL,managed_hash TEXT NOT NULL,revision INTEGER NOT NULL,exported_at TEXT NOT NULL);
      PRAGMA user_version=1;
    `),
    );
    this.migrate(false);
  }
}

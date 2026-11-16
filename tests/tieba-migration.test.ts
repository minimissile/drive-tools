import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, databaseSchemaVersion } from "../core/database";

// These fixtures start with an empty current database. Remove the tables that
// cannot be present when the legacy migrations run.
function removeLaterSchema(db: Database, version: number) {
  db.db.exec(`
    DROP TABLE tieba_forum_cache_posts;
    DROP TABLE tieba_forum_cache;
    DROP TABLE tieba_discovery_old_resource_queue;
    DROP TABLE tieba_discovery_old_resource_deleted;
    DROP TABLE tieba_discovery_old_resource;
    DROP TABLE tieba_discovery_old_traffic;
  `);
  if (version >= 33) return;
  db.db.exec(`
    DROP VIEW traffic_items;
    DROP TRIGGER traffic_queries_revision_insert;
    DROP TRIGGER traffic_queries_revision_update;
    DROP TRIGGER traffic_queries_revision_delete;
    DROP TABLE traffic_observations;
    DROP TABLE traffic_entries;
    DROP TABLE traffic_knowledge_state;
    DROP INDEX traffic_queries_endpoint;
    ALTER TABLE traffic_queries DROP COLUMN item_count;
    ALTER TABLE traffic_queries DROP COLUMN legacy_items;
    CREATE TABLE traffic_items(id TEXT PRIMARY KEY,query_id TEXT NOT NULL REFERENCES traffic_queries(id),kind TEXT NOT NULL,word TEXT NOT NULL,normalized_word TEXT NOT NULL,platform TEXT,source TEXT NOT NULL,metrics TEXT NOT NULL,data TEXT NOT NULL,observed_at TEXT,source_updated_at TEXT);
    CREATE INDEX traffic_items_word ON traffic_items(normalized_word,platform,observed_at DESC);
    CREATE INDEX traffic_items_query ON traffic_items(query_id);
    DROP TABLE tieba_discovery_traffic;
    DROP TABLE tieba_discovery_potential;
  `);
}

test("贴吧v33迁移保留观察与回复数据，新增批次/主题/复盘表且备份仅一次", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panxu-tieba-v33-")),
    path = join(dir, "panxu.db");
  try {
    const old = new Database(path);
    old.setSetting("v33-sentinel", { keep: true });
    old.run(
      "INSERT INTO tieba_autocare_targets(id,account_id,uid,forum_id,data) VALUES(?,?,?,?,?)",
      "tiebatarget_migration",
      "web_old",
      "111",
      "101",
      JSON.stringify({
        id: "tiebatarget_migration",
        accountId: "web_old",
        uid: "111",
        forumId: "101",
        name: "资料",
        source: "observed",
        level: 2,
        experience: 10,
        checkedAt: "2026-11-07T02:00:00Z",
      }),
    );
    removeLaterSchema(old, 32);
    old.db.exec(
      "DROP TABLE tieba_automation_tasks; DROP TABLE tieba_topic_drafts; DROP TABLE tieba_topic_generations; DROP TABLE tieba_topic_rules; DROP TABLE tieba_visibility_checks; DROP TABLE tieba_forum_metrics; PRAGMA user_version=32;",
    );
    old.close();
    const upgraded = new Database(path);
    assert.deepEqual(upgraded.setting("v33-sentinel", null), { keep: true });
    for (const table of [
      "tieba_automation_tasks",
      "tieba_topic_drafts",
      "tieba_topic_generations",
      "tieba_topic_rules",
      "tieba_visibility_checks",
      "tieba_forum_metrics",
      "tieba_reply_drafts",
    ])
      assert.ok(
        upgraded.get("SELECT name FROM sqlite_master WHERE name=?", table),
      );
    assert.equal(
      upgraded.get<{ count: number }>(
        "SELECT COUNT(*) count FROM tieba_forum_metrics",
      )?.count,
      1,
    );
    assert.equal(
      JSON.parse(
        upgraded.get<{ data: string }>(
          "SELECT data FROM tieba_autocare_targets",
        )!.data,
      ).source,
      "observed",
    );
    assert.equal(
      upgraded.get<{ user_version: number }>("PRAGMA user_version")
        ?.user_version,
      databaseSchemaVersion,
    );
    upgraded.close();
    new Database(path).close();
    const backups = (await readdir(dir)).filter((name) =>
      name.includes("before-v33-"),
    );
    assert.equal(backups.length, 1);
    assert.equal((await stat(join(dir, backups[0]))).mode & 0o777, 0o600);
    const backup = new DatabaseSync(join(dir, backups[0]), { readOnly: true });
    try {
      assert.equal(
        backup.prepare("PRAGMA user_version").get()?.user_version,
        32,
      );
      assert.equal(
        backup.prepare("PRAGMA integrity_check").get()?.integrity_check,
        "ok",
      );
    } finally {
      backup.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("帖子与回复v32迁移保留原设置和签到表，重开不重复备份", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "panxu-tieba-participation-migration-"),
  );
  const path = join(dir, "panxu.db");
  try {
    const old = new Database(path);
    old.setSetting("participation-migration-sentinel", { keep: true });
    removeLaterSchema(old, 31);
    old.db.exec(
      "DROP TABLE tieba_reply_generations; DROP TABLE tieba_reply_drafts; DROP TABLE tieba_thread_candidates; PRAGMA user_version=31;",
    );
    old.close();
    const upgraded = new Database(path);
    assert.deepEqual(
      upgraded.setting("participation-migration-sentinel", null),
      { keep: true },
    );
    for (const table of [
      "tieba_autocare_targets",
      "tieba_autocare_tasks",
      "tieba_thread_candidates",
      "tieba_reply_drafts",
      "tieba_reply_generations",
    ])
      assert.ok(
        upgraded.get("SELECT name FROM sqlite_master WHERE name=?", table),
      );
    assert.equal(
      upgraded.get<{ user_version: number }>("PRAGMA user_version")
        ?.user_version,
      databaseSchemaVersion,
    );
    upgraded.close();
    new Database(path).close();
    const backups = (await readdir(dir)).filter((name) =>
      name.includes("before-v32-"),
    );
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(dir, backups[0]), { readOnly: true });
    try {
      assert.equal(
        backup.prepare("PRAGMA user_version").get()?.user_version,
        31,
      );
    } finally {
      backup.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("贴吧迁移保留v30数据并创建一次一致性备份，重开不重复迁移", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panxu-tieba-migration-"));
  const path = join(dir, "panxu.db");
  try {
    const initial = new Database(path);
    initial.setSetting("migration-sentinel", { keep: true });
    removeLaterSchema(initial, 30);
    initial.db.exec(
      "DROP TABLE tieba_autocare_tasks; DROP TABLE tieba_autocare_targets; PRAGMA user_version=30;",
    );
    initial.close();
    const upgraded = new Database(path);
    assert.equal(
      upgraded.get<{ user_version: number }>("PRAGMA user_version")
        ?.user_version,
      databaseSchemaVersion,
    );
    assert.deepEqual(upgraded.setting("migration-sentinel", null), {
      keep: true,
    });
    assert.ok(
      upgraded.get(
        "SELECT name FROM sqlite_master WHERE name='tieba_autocare_tasks'",
      ),
    );
    assert.ok(
      upgraded.get(
        "SELECT name FROM sqlite_master WHERE name='tieba_autocare_targets'",
      ),
    );
    upgraded.close();
    new Database(path).close();
    const backups = (await readdir(dir)).filter((name) =>
      name.includes("before-v31-"),
    );
    assert.equal(backups.length, 1);
    assert.equal((await stat(join(dir, backups[0]))).mode & 0o777, 0o600);
    const backup = new DatabaseSync(join(dir, backups[0]), { readOnly: true });
    try {
      assert.equal(
        backup.prepare("PRAGMA user_version").get()?.user_version,
        30,
      );
      assert.equal(
        backup.prepare("PRAGMA integrity_check").get()?.integrity_check,
        "ok",
      );
      assert.equal(
        backup
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='tieba_autocare_tasks'",
          )
          .get(),
        undefined,
      );
    } finally {
      backup.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("贴吧v38精简扩散来源和入库记录中的完整路径", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panxu-tieba-v38-"));
  const path = join(dir, "panxu.db");
  const key = "tieba.resourceDiscovery.v1";
  const chain = ["网盘资源", "作者甲", "影视资源", "作者乙", "泰国腐剧"];
  const source = {
    name: "泰国腐剧",
    status: "watch",
    addedAt: 1700,
    via: { forum: "影视资源", reason: "posted" },
  };
  const post = { id: "123", forum: source.name, views: 100 };
  const firstEvidence = JSON.stringify({ at: 1600, views: 30 });
  try {
    const old = new Database(path);
    old.setSetting(key, {
      seeds: ["网盘资源"],
      sources: [{ ...source, path: chain, via: { ...source.via, author: "作者乙", uid: "567" } }],
      posts: [{ ...post, path: chain, pendingSince: 1600 }],
      authors: { "567": 1600 },
      rounds: 15,
    });
    old.run(
      "INSERT INTO tieba_discovery_potential (thread_id,first_found_at,first_evidence,latest) VALUES(?,?,?,?)",
      post.id, 1600, firstEvidence, JSON.stringify({ ...post, path: chain }),
    );
    old.run(
      "INSERT INTO tieba_discovery_traffic (thread_id,archived_at,views,reading) VALUES(?,?,?,?)",
      post.id, 1700, 100, JSON.stringify({ ...post, path: chain }),
    );
    removeLaterSchema(old, 37);
    old.db.exec("PRAGMA user_version=37");
    old.close();

    const upgraded = new Database(path);
    try {
      assert.deepEqual(upgraded.setting(key, null), {
        seeds: ["网盘资源"],
        sources: [source],
        posts: [{ ...post, pendingSince: 1600 }],
        authors: { "567": 1600 },
        rounds: 15,
      });
      const potential = upgraded.get<{ latest: string; first_evidence: string }>(
        "SELECT latest,first_evidence FROM tieba_discovery_potential WHERE thread_id=?", post.id,
      );
      const traffic = upgraded.get<{ reading: string }>(
        "SELECT reading FROM tieba_discovery_traffic WHERE thread_id=?", post.id,
      );
      assert.deepEqual(JSON.parse(potential!.latest), post);
      assert.deepEqual(JSON.parse(traffic!.reading), post);
      assert.equal(potential!.first_evidence, firstEvidence);
      assert.equal(upgraded.get<{ user_version: number }>("PRAGMA user_version")?.user_version, databaseSchemaVersion);
    } finally {
      upgraded.close();
    }
    const backups = (await readdir(dir)).filter((name) => name.includes(".before-v38-"));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(dir, backups[0]), { readOnly: true });
    try {
      const entry = backup.prepare("SELECT value FROM settings WHERE key=?").get(key);
      assert.deepEqual(JSON.parse(String(entry?.value)).sources[0].path, chain);
    } finally {
      backup.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("贴吧v39保留通过初筛的老帖读数，独立保存并保留原发现设置", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panxu-tieba-v39-"));
  const path = join(dir, "panxu.db");
  const key = "tieba.resourceDiscovery.v1";
  const rulesKey = "tieba.resourceDiscovery.rules";
  const day = 86_400_000;
  const at = Date.parse("2026-11-12T03:00:00Z");
  const post = {
    id: "100",
    title: "历史网盘资料",
    url: "https://tieba.baidu.com/p/100",
    forum: "网盘资源",
    publishedAt: new Date(at - 60 * day).toISOString(),
  };
  const state = { seeds: [post.forum], posts: [{ id: "200", pendingSince: at }] };
  const rules = { lookbackHours: 72, minHourlyViews: 8, trafficThreshold: 500, oldTrafficMinViews: 20 };
  try {
    const old = new Database(path);
    old.setSetting(key, {
      ...state,
      oldTraffic: [
        { post, readings: [{ at: at - day, views: 2490 }, { at, views: 2500 }] },
        { post: { ...post, id: "101" }, readings: [{ at, views: 499 }] },
      ],
    });
    old.setSetting(rulesKey, rules);
    removeLaterSchema(old, 38);
    old.db.exec("PRAGMA user_version=38;");
    old.close();

    const upgraded = new Database(path);
    try {
      assert.deepEqual(upgraded.setting(key, null), state);
      assert.deepEqual(upgraded.setting(rulesKey, null), rules);
      const resource = upgraded.get<{ evidence: string; checked_at: number | null }>(
        "SELECT evidence, checked_at FROM tieba_discovery_old_resource WHERE thread_id = ?", post.id,
      );
      assert.deepEqual(JSON.parse(resource!.evidence), { linkSources: [], keywords: ["网盘"] });
      assert.equal(resource!.checked_at, null);
      assert.deepEqual(
        upgraded.all<Record<string, string | number | null>>(
          "SELECT thread_id, last_at, last_views, next_check_at, daily_added FROM tieba_discovery_old_traffic",
        )
          .map((row) => ({ ...row })),
        [{ thread_id: post.id, last_at: at, last_views: 2500, next_check_at: at + 3 * day, daily_added: null }],
      );
    } finally {
      upgraded.close();
    }
    assert.equal((await readdir(dir)).filter((name) => name.includes(".before-v39-")).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

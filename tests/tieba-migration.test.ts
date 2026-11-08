import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, databaseSchemaVersion } from "../core/database";

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

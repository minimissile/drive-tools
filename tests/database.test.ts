import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../core/database";
import { removeV5, currentSchemaVersion } from "./helpers";

test("v2数据库升级前创建一致性备份，保留资料与加密值，重开不重复迁移", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panxu-migration-"));
  const path = join(dir, "panxu.db");
  try {
    const initial = new Database(path);
    initial.close();
    const old = new DatabaseSync(path);
    old.exec(
      removeV5 +
        "DROP TABLE share_checks; DROP TABLE suggestion_queries; ALTER TABLE browser_bindings DROP COLUMN last_checked_at; ALTER TABLE browser_bindings DROP COLUMN last_opened_at; ALTER TABLE browser_bindings DROP COLUMN open_error; PRAGMA user_version=2;",
    );
    old
      .prepare("INSERT INTO settings VALUES(?,?)")
      .run("model", '"test/model"');
    old
      .prepare("INSERT INTO secrets VALUES(?,?)")
      .run("openrouter", "opaque-encrypted-value");
    old
      .prepare(
        "INSERT INTO browser_bindings(id,platform,alias,window_id,editor_url,rule_note) VALUES(?,?,?,?,?,?)",
      )
      .run(
        "binding",
        "xiaohongshu",
        "已有账号",
        "window",
        "https://creator.xiaohongshu.com/",
        "保留原记录",
      );
    old.close();
    const upgraded = new Database(path);
    assert.equal(
      upgraded.get<{ user_version: number }>("PRAGMA user_version")!
        .user_version,
      currentSchemaVersion,
    );
    assert.equal(upgraded.setting("model", ""), "test/model");
    assert.equal(
      upgraded.get<{ value: string }>(
        "SELECT value FROM secrets WHERE key='openrouter'",
      )!.value,
      "opaque-encrypted-value",
    );
    assert.equal(
      upgraded.get<{ alias: string }>("SELECT alias FROM browser_bindings")!
        .alias,
      "已有账号",
    );
    assert.equal(
      upgraded.get<{ open_error: string | null }>(
        "SELECT open_error FROM browser_bindings",
      )!.open_error,
      null,
    );
    upgraded.close();
    const backups = (await readdir(dir)).filter((name) =>
      name.includes("before-v3-"),
    );
    assert.equal(backups.length, 1);
    assert.equal((await stat(join(dir, backups[0]))).mode & 0o777, 0o600);
    const backup = new DatabaseSync(join(dir, backups[0]), { readOnly: true });
    assert.equal(backup.prepare("PRAGMA user_version").get()!.user_version, 2);
    assert.equal(
      backup.prepare("PRAGMA integrity_check").get()!.integrity_check,
      "ok",
    );
    assert.equal(
      backup.prepare("SELECT alias FROM browser_bindings").get()!.alias,
      "已有账号",
    );
    backup.close();
    new Database(path).close();
    assert.equal(
      (await readdir(dir)).filter((name) => name.includes("before-v3-")).length,
      1,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

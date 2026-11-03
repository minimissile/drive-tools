import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database, databaseSchemaVersion } from "../core/database";
import { RuntimeLog } from "../core/runtime-log";

test("运行日志：数据库与JSONL持久化、按账号和等级分页，凭据脱敏", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panxu-runtime-log-")),
    db = new Database(join(dir, "panxu.db"));
  try {
    const log = new RuntimeLog(db, dir, "zhihu");
    for (let n = 0; n < 55; n++)
      log.record({
        level: n === 0 ? "error" : "info",
        event: "test",
        message: n === 0 ? "Authorization: Bearer qa-secret-value" : "模拟状态",
        accountId: "account-a",
        details: { api_key: "raw-secret", count: n },
      });
    log.record({
      level: "warning",
      event: "test",
      message: "另一账号",
      accountId: "account-b",
    });
    assert.equal(log.read({ accountId: "account-a" }).total, 55);
    assert.equal(log.read({ accountId: "account-a", page: 2 }).items.length, 5);
    assert.equal(log.read({ level: "error" }).total, 1);
    assert.equal(log.read({ accountId: "account-a", page: 99 }).page, 2);
    const files = await readdir(log.folder),
      raw = await readFile(join(log.folder, files[0]), "utf8");
    assert.equal(raw.trim().split("\n").length, 56);
    assert.ok(!raw.includes("qa-secret-value"));
    assert.ok(!raw.includes("raw-secret"));
    assert.ok(!JSON.stringify(log.read()).includes("raw-secret"));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("运行日志：v29迁移保留既有数据并生成备份", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panxu-log-migration-")),
    path = join(dir, "panxu.db");
  let db = new Database(path);
  try {
    db.setSetting("keep", { value: 123 });
    db.db.exec("DROP TABLE runtime_logs; PRAGMA user_version=29;");
    db.close();
    db = new Database(path);
    assert.equal(
      db.get<{ user_version: number }>("PRAGMA user_version")!.user_version,
      databaseSchemaVersion,
    );
    assert.deepEqual(db.setting("keep", null), { value: 123 });
    assert.ok((await readdir(dir)).some((n) => n.includes("before-v30")));
    new RuntimeLog(db, dir, "zhihu").record({
      level: "info",
      event: "migrated",
      message: "迁移完成",
    });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

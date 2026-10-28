import type { IpcMethod, IpcValue } from "../shared/ipc";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "../core/database";
import { inspectBackup, stageRestore } from "../core/backups";
import {
  baiduIdentityFromUrl,
  isAbortedNavigation,
  websiteLoginSpecs,
  websiteNavigationAllowed,
  websitePostLoginUrl,
} from "../desktop/website-session-policy";
import { fixture, removeV15, currentSchemaVersion } from "./helpers";

test("Website accounts own login lifecycle without a caller supplied platform UID", async () => {
  const f = await fixture();
  const invoke = <M extends IpcMethod>(method: M, args?: unknown) =>
    f.app.invoke(method, args) as Promise<IpcValue<M>>;
  const log: string[] = [];
  f.ports.websiteSessions = {
    isOpen: () => false,
    login: async (a) => {
      assert.equal(a.uid, null);
      log.push(a.id);
    },
    clear: async (a) => {
      log.push(`clear:${a.id}`);
    },
    invalidate: async () => {},
    status: async () => ({
      hasSession: false,
      uid: null,
      windowOpen: false,
      error: null,
    }),
  };
  try {
    const a = await invoke("websiteAccounts.add", {
      provider: "baidu-marketing",
    });
    const b = await invoke("websiteAccounts.add", {
      provider: "baidu-marketing",
    });
    assert.notEqual(a.id, b.id);
    assert.equal(a.uid, null);
    assert.equal(a.alias, "百度营销 1");
    await invoke("websiteAccounts.login", { id: a.id });
    assert.deepEqual(log, [a.id]);
    assert.equal((await invoke("websiteAccounts.list")).length, 2);
    await invoke("websiteAccounts.rename", {
      id: a.id,
      alias: "  工作账号  ",
    });
    assert.equal(f.app.websiteAccounts.get(a.id).alias, "工作账号");
    await assert.rejects(
      invoke("websiteAccounts.add", { provider: "unknown" }),
    );
    await assert.rejects(
      invoke("websiteAccounts.rename", { id: a.id, alias: " " }),
    );
    await assert.rejects(
      invoke("websiteAccounts.remove", { id: a.id, confirmed: false }),
    );
    f.ports.websiteSessions.status = async () => ({
      hasSession: true,
      uid: "94200132",
      windowOpen: true,
      error: null,
    });
    const live = await invoke("websiteAccounts.check", { id: a.id });
    assert.equal(live.uid, "94200132");
    assert.equal(live.status, "connected");
    await invoke("websiteAccounts.remove", { id: a.id, confirmed: true });
    assert.ok(!log.includes(`clear:${a.id}`), "移除账号保留共享环境的登录数据");
    await assert.rejects(invoke("websiteAccounts.check", { id: a.id }), {
      code: "WEBSITE_ACCOUNT_NOT_FOUND",
    });
  } finally {
    await f.cleanup();
  }
});
test("Official login starts without user ID, limits navigation and ignores only aborted redirects", () => {
  assert.equal(new URL(websiteLoginSpecs["baidu-marketing"].home).search, "");
  assert.match(
    websitePostLoginUrl(
      "baidu-marketing",
      "https://qingge.baidu.com/ad/overview",
    )!,
    /\/ad\/toolsCenter\/kr\?/,
  );
  assert.equal(
    websitePostLoginUrl("baidu-marketing", "https://attacker.test/ad/overview"),
    null,
  );
  assert.ok(
    websiteNavigationAllowed(
      "baidu-marketing",
      "https://passport.baidu.com/v2/?login",
    ),
  );
  for (const value of [
    "http://qingge.baidu.com/login",
    "https://qingge.baidu.com.attacker.test/",
    "https://user:pass@qingge.baidu.com/",
    "javascript:alert(1)",
  ])
    assert.equal(websiteNavigationAllowed("baidu-marketing", value), false);
  assert.equal(
    baiduIdentityFromUrl(
      "https://qingge.baidu.com/ad/toolsCenter/kr?userId=94200132",
    ),
    "94200132",
  );
  assert.equal(
    baiduIdentityFromUrl(
      "https://fengchao.baidu.com/fc/toolscenter/orientation/kr/user/94200132?in=iframe",
    ),
    "94200132",
  );
  assert.equal(
    baiduIdentityFromUrl("https://attacker.test/?userId=94200132"),
    null,
  );
  assert.equal(
    baiduIdentityFromUrl("https://qingge.baidu.com/?userId=abc"),
    null,
  );
  assert.ok(isAbortedNavigation({ code: "ERR_ABORTED" }));
  assert.ok(isAbortedNavigation({ errno: -3 }));
  assert.equal(isAbortedNavigation({ code: "ERR_NAME_NOT_RESOLVED" }), false);
});
test("Website account backups preserve account records but revoke login state on export and restore", async () => {
  const f = await fixture();
  try {
    const account = f.app.websiteAccounts.add("baidu-marketing", "工作账号");
    f.app.db.run(
      "UPDATE website_accounts SET status='connected',uid='123456' WHERE id=?",
      account.id,
    );
    f.ports.chooseDirectory = async () => f.dir;
    const folder = (await f.app.backup())!;
    const info = await inspectBackup(folder);
    const copy = new DatabaseSync(join(folder, "panxu.db"), { readOnly: true });
    assert.equal(
      copy.prepare("SELECT status FROM website_accounts").get()?.status,
      "disconnected",
    );
    copy.close();
    const staged = await stageRestore(folder, f.dir, info.databaseSha256);
    const restored = new Database(join(staged.dataPath, "panxu.db"));
    try {
      const row = restored.get<{ alias: string; status: string }>(
        "SELECT alias,status FROM website_accounts WHERE id=?",
        account.id,
      )!;
      assert.equal(row.alias, "工作账号");
      assert.equal(row.status, "disconnected");
    } finally {
      restored.close();
    }
    assert.equal(f.app.websiteAccounts.get(account.id).status, "connected");
  } finally {
    await f.cleanup();
  }
});
test("v14 migration backs up existing accounts and preserves them through v15 reopen", async () => {
  const f = await fixture();
  const invoke = <M extends IpcMethod>(method: M, args?: unknown) =>
    f.app.invoke(method, args) as Promise<IpcValue<M>>;
  const path = f.app.db.path;
  f.app.close();
  try {
    const old = new DatabaseSync(path);
    old.exec(removeV15 + "PRAGMA user_version=14;");
    old.close();
    const upgraded = new Database(path);
    assert.equal(
      upgraded.get<{ user_version: number }>("PRAGMA user_version")
        ?.user_version,
      currentSchemaVersion,
    );
    assert.equal(
      upgraded.get<{ id: string }>("SELECT id FROM accounts")?.id,
      f.account.id,
    );
    assert.deepEqual(upgraded.all("SELECT * FROM website_accounts"), []);
    upgraded.close();
    const backups = (await readdir(f.dir)).filter((n) =>
      n.includes("before-v15-"),
    );
    assert.equal(backups.length, 1);
    assert.equal((await stat(join(f.dir, backups[0]))).mode & 0o777, 0o600);
    const backup = new DatabaseSync(join(f.dir, backups[0]), {
      readOnly: true,
    });
    assert.equal(backup.prepare("PRAGMA user_version").get()?.user_version, 14);
    backup.close();
    new Database(path).close();
    assert.equal(
      (await readdir(f.dir)).filter((n) => n.includes("before-v15-")).length,
      1,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

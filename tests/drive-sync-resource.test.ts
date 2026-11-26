import test from "node:test";
import assert from "node:assert/strict";
import { fixture, file } from "./helpers";
import { id, now } from "../core/database";
import {
  ownedFileSource,
  isIndexedOwnSource,
} from "../shared/owned-file-source";
import { indexedOwnSource } from "../core/drive-sync-resource";
import type { DriveSyncLog } from "../shared/drive-sync";
import type { ResourceInput } from "../shared/types";

test("UC、迅雷、光鸭原生账号通过原分区同步，不注册为指纹浏览器账号", async () => {
  const f = await fixture();
  Object.assign(f.provider, {
    listPage: async () => ({ files: [file], next: null }),
  });
  try {
    for (const provider of ["uc", "xunlei", "guangya"] as const) {
      const a = (await f.app.invoke("account.add", {
        provider,
        alias: provider,
      })) as { id: string };
      await f.app.invoke("account.check", { id: a.id });
      await f.app.invoke("driveSync.start", { accountId: a.id });
      await f.app.driveSync.settled(a.id);
      const view = f.app.driveSync.index({ accountId: a.id });
      assert.equal(view.run?.status, "completed");
      assert.equal(view.items[0].id, file.id);
      assert.equal(
        f.app.db.get(
          "SELECT 1 FROM browser_environment_accounts WHERE kind='drive' AND account_id=?",
          a.id,
        ),
        undefined,
      );
      assert.match(view.run!.environment, new RegExp(`persist:panxu-${a.id}`));
    }
  } finally {
    await f.cleanup();
  }
});

test("真实应用 IPC 读取同步日志，删除账号时清除日志和自动录入状态", async () => {
  const f = await fixture();
  const folder = {
    ...file,
    id: "folder",
    name: "资料",
    isDirectory: true,
    size: null,
  };
  Object.assign(f.provider, {
    listPage: async (_: unknown, id: string) => ({
      files: id === "0" ? [folder] : [file],
      next: null,
    }),
  });
  try {
    const account = (await f.app.invoke("account.add", {
      provider: "uc",
      alias: "本人 UC",
    })) as { id: string };
    await f.app.invoke("account.check", { id: account.id });
    await f.app.invoke("driveSync.start", {
      accountId: account.id,
      autoRegister: true,
    });
    await f.app.driveSync.settled(account.id);
    assert.deepEqual(f.app.driveSync.current(account.id)?.autoRegister, {
      enabled: true,
      added: 2,
      skipped: 0,
    });
    const logs = (await f.app.invoke("driveSync.logs", {
      accountId: account.id,
    })) as DriveSyncLog[];
    assert.match(logs[0].message, /^同步完成/);
    assert.match(logs[0].message, /自动录入新增 2 项/);
    assert.match(logs.at(-1)!.message, /^开始同步/);
    assert.equal(
      f.app.driveSync.index({ accountId: account.id }).items[0].state,
      "recorded",
    );
    assert.equal(
      f.app.driveSync.index({ accountId: account.id, parentId: folder.id })
        .items[0].state,
      "recorded",
    );
    const preview = (await f.app.invoke("account.deletePreview", {
      id: account.id,
    })) as { token: string; blockers: string[] };
    assert.deepEqual(preview.blockers, []);
    await f.app.invoke("account.remove", { token: preview.token });
    assert.equal(
      f.app.db.get(
        "SELECT 1 FROM runtime_logs WHERE domain='drive-sync' AND account_id=?",
        account.id,
      ),
      undefined,
    );
    assert.equal(
      f.app.db.setting(`drive-sync:auto-register:${account.id}`, null),
      null,
    );
  } finally {
    await f.cleanup();
  }
});

test("目录登记资源可以编辑资料，保留目标清单、归属与分享状态，不解析成外部分享", async () => {
  const f = await fixture();
  try {
    const resourceId = id("resource"),
      copyId = id("copy"),
      time = now();
    const account = f.app.repo.getAccount(f.account.id),
      source = ownedFileSource("quark", account.id, account.uid!, file.id);
    f.app.db.run(
      "INSERT INTO resources(id,title,source_url,source_key,provider,category,tags,summary,source_kind,created_at,updated_at) VALUES(?,?,?,?,'quark','未分类','[]','','owned',?,?)",
      resourceId,
      "练习资料",
      source,
      file.id,
      time,
      time,
    );
    f.app.db.run(
      "INSERT INTO copies(id,resource_id,account_id,directory,files,status,owner_uid,verified_at,created_at,updated_at) VALUES(?,?,?,'/',?,'recorded',?,?,?,?)",
      copyId,
      resourceId,
      account.id,
      JSON.stringify([{ ...file, path: "/" + file.name }]),
      account.uid,
      time,
      time,
      time,
    );
    const input = {
      id: resourceId,
      copyId,
      accountId: account.id,
      title: "资料整理完成",
      sourceText: source,
      directory: "/",
      category: "效率办公",
      tags: ["学习"],
      summary: "整理说明",
      isOwnResource: true,
      enqueue: false,
    } as ResourceInput;
    await f.app.invoke("resource.save", input);
    const copy = f.app.repo.getCopy(copyId);
    assert.equal(copy.status, "recorded");
    assert.equal(copy.shareUrl, null);
    assert.equal(copy.ownerUid, account.uid);
    assert.equal(copy.files[0].id, file.id);
    assert.equal(f.app.repo.getResource(resourceId).title, "资料整理完成");
    assert.equal(f.provider.shares, 0);
    assert.equal(f.provider.transfers, 0);
    assert.throws(
      () =>
        indexedOwnSource(f.app.db, {
          ...input,
          sourceText: source + "changed",
        }),
      /原账号与来源/,
    );
    assert.throws(
      () => indexedOwnSource(f.app.db, { ...input, accountId: "another" }),
      /原账号与来源/,
    );
    assert.throws(
      () => indexedOwnSource(f.app.db, { ...input, enqueue: true }),
      /原账号与来源/,
    );
    f.app.db.run(
      "UPDATE copies SET status='ready',share_url='https://pan.quark.cn/s/real',share_id='real',share_owner_uid=?,share_verified_at=? WHERE id=?",
      account.uid,
      time,
      copyId,
    );
    await f.app.invoke("resource.save", { ...input, title: "资料再次整理" });
    assert.equal(f.app.repo.getCopy(copyId).status, "ready");
    assert.equal(
      f.app.repo.getCopy(copyId).shareUrl,
      "https://pan.quark.cn/s/real",
    );
  } finally {
    await f.cleanup();
  }
});

test("内部来源标识严格限定官方来源，不能把外部 URL 当作本人文件", () => {
  assert.equal(
    isIndexedOwnSource(ownedFileSource("quark", "a", "u", "f")),
    true,
  );
  for (const text of [
    "https://example.com/#panxu-owned=abc",
    "https://pan.quark.cn/s/abc#panxu-owned=a",
    "https://pan.quark.cn/#panxu-owned=",
    "https://user@pan.quark.cn/#panxu-owned=a",
    "invalid",
  ])
    assert.equal(isIndexedOwnSource(text), false);
});

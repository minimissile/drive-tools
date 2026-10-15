import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers";
import { Database } from "../core/database";
test("明确请求重新建链时先复用有效本人分享，不重复转存或重复建链", async () => {
  const f = await fixture();
  try {
    f.provider.failShare = true;
    const saved = await f.add();
    await f.app.queue.execute(saved.jobId);
    f.provider.failShare = false;
    await f.app.invoke("copy.createShare", { copyId: saved.copyId });
    assert.equal(f.app.repo.getCopy(saved.copyId).status, "ready");
    assert.equal(f.provider.transfers, 1);
    assert.equal(f.provider.shares, 1);
    const version = f.app.repo.getCopy(saved.copyId).shareVersion;
    await f.app.invoke("copy.createShare", { copyId: saved.copyId });
    assert.equal(f.provider.shares, 1);
    assert.equal(f.app.repo.getCopy(saved.copyId).shareVersion, version);
  } finally {
    await f.cleanup();
  }
});

test("转存 → 本人分享 → 草稿审阅 → 归属复核；重复执行不会重复写远端", async () => {
  const f = await fixture();
  try {
    const saved = await f.add();
    await f.app.queue.execute(saved.jobId);
    const copy = f.app.repo.getCopy(saved.copyId);
    assert.equal(copy.status, "ready");
    assert.equal(copy.ownerUid, f.account.uid ?? f.provider.uid);
    assert.equal(copy.shareUrl, f.provider.ownUrl);
    assert.equal(f.app.repo.getJob(saved.jobId).stage, "completed");
    await f.app.queue.execute(saved.jobId);
    assert.equal(f.provider.transfers, 1);
    assert.equal(f.provider.shares, 1);
    let draft: any = await f.app.invoke("draft.manual", {
      copyId: copy.id,
      platform: "x",
    });
    await assert.rejects(f.app.contentPackage(draft.id, null, false), {
      code: "REVIEW_REQUIRED",
    });
    draft = await f.app.invoke("draft.save", {
      id: draft.id,
      title: "练习办公技能",
      body: "从一份清单开始练习会议纪要。",
      tags: ["#办公"],
      coverText: "",
    });
    await f.app.invoke("draft.review", { id: draft.id, reviewed: true });
    const binding: any = await f.app.invoke("binding.save", {
      platform: "x",
      alias: "本人X账号",
      windowId: "window1",
      editorUrl: "https://x.com/compose/post",
      linkPermission: "allowed",
      ruleNote: "已核对本人账号的相关资源链接发布场景。",
    });
    const content = await f.app.contentPackage(draft.id, binding.id, true);
    assert.match(content.text, /own123/);
    assert.doesNotMatch(content.text, /source123/);
    assert.match(content.text, /提取码：test/);
    f.provider.ownValid = false;
    await assert.rejects(f.app.contentPackage(draft.id, binding.id, true), {
      code: "SHARE_INVALID",
    });
    assert.equal(f.app.repo.getCopy(copy.id).shareVerifiedAt, null);
  } finally {
    await f.cleanup();
  }
});

test("转存响应丢失后按目标清单恢复，不重复转存", async () => {
  const f = await fixture();
  try {
    f.provider.failTransfer = true;
    const saved = await f.add();
    await f.app.queue.execute(saved.jobId);
    assert.equal(
      f.app.repo.getJob(saved.jobId).checkpoint,
      "transfer_requested",
    );
    assert.equal(f.app.repo.getJob(saved.jobId).stage, "needs_review");
    f.provider.failTransfer = false;
    await f.app.queue.execute(saved.jobId);
    assert.equal(f.app.repo.getCopy(saved.copyId).status, "ready");
    assert.equal(f.provider.transfers, 1);
  } finally {
    await f.cleanup();
  }
});

test("创建分享响应丢失后查本人记录，绝不重复建链", async () => {
  const f = await fixture();
  try {
    f.provider.failShare = true;
    const saved = await f.add();
    await f.app.queue.execute(saved.jobId);
    assert.equal(f.app.repo.getJob(saved.jobId).checkpoint, "share_requested");
    assert.equal(f.app.repo.getJob(saved.jobId).stage, "needs_review");
    await f.app.queue.execute(saved.jobId);
    assert.equal(f.app.repo.getCopy(saved.copyId).status, "ready");
    assert.equal(f.provider.shares, 1);
  } finally {
    await f.cleanup();
  }
});

test("账号UID变化、文件不足、来源链接冒充本人链接均阻止分发", async () => {
  for (const scenario of ["uid", "partial", "foreign"]) {
    const f = await fixture();
    try {
      const saved = await f.add();
      if (scenario === "uid") f.provider.uid = "another-user";
      if (scenario === "partial")
        f.provider.poll = async () => {
          f.provider.actual = [];
          return true;
        };
      if (scenario === "foreign")
        f.provider.ownUrl = "https://pan.quark.cn/s/source123";
      await f.app.queue.execute(saved.jobId);
      assert.notEqual(f.app.repo.getCopy(saved.copyId).status, "ready");
      assert.equal(f.app.repo.getCopy(saved.copyId).shareUrl, null);
      if (scenario === "uid") assert.equal(f.provider.transfers, 0);
    } finally {
      await f.cleanup();
    }
  }
});

test("同资源多账号副本、编辑不会改绑；SQLite中文检索与事务回滚", async () => {
  const f = await fixture();
  try {
    const first = await f.add(false);
    const secondAccount: any = await f.app.invoke("account.add", {
      provider: "quark",
      alias: "夸克二号",
    });
    const second = await f.add(false, { accountId: secondAccount.id });
    assert.equal(first.resourceId, second.resourceId);
    assert.notEqual(first.copyId, second.copyId);
    assert.equal(f.app.repo.resources("办公练习")[0].copies.length, 2);
    assert.equal(f.app.repo.resources("办公").length, 1);
    await assert.rejects(
      f.add(false, {
        id: first.resourceId,
        copyId: first.copyId,
        accountId: secondAccount.id,
      }),
      { code: "COPY_MISMATCH" },
    );
    assert.throws(() =>
      f.app.db.transaction(() => {
        f.app.db.setSetting("rollback", true);
        throw new Error("rollback");
      }),
    );
    assert.equal(f.app.db.setting("rollback", false), false);
    await f.app.secrets.set("openrouter", "sk-private-key");
    assert.doesNotMatch(JSON.stringify(f.app.snapshot()), /sk-private-key/);
    assert.notEqual(
      f.app.db.get<any>("SELECT value FROM secrets WHERE key=?", "openrouter")
        .value,
      "sk-private-key",
    );
  } finally {
    await f.cleanup();
  }
});

test("Obsidian保留手写区、更新生成区、外部冲突不会覆盖", async () => {
  const f = await fixture();
  try {
    const saved = await f.add();
    await f.app.queue.execute(saved.jobId);
    f.app.db.setSetting("vaultPath", join(f.dir, "vault"));
    await f.app.notes.export(saved.copyId);
    const row = f.app.db.get<any>(
      "SELECT path FROM note_exports WHERE copy_id=?",
      saved.copyId,
    );
    let note = await readFile(row.path, "utf8");
    assert.doesNotMatch(note, /提取码：test/);
    await writeFile(row.path, note + "我的手写说明。");
    await f.add(false, {
      id: saved.resourceId,
      copyId: saved.copyId,
      title: "更新后的标题",
      summary: "修改资料后自动同步知识笔记。",
    });
    note = await readFile(row.path, "utf8");
    assert.match(note, /更新后的标题/);
    assert.match(note, /修改资料后自动同步知识笔记/);
    assert.match(note, /我的手写说明/);
    assert.equal(f.app.repo.getCopy(saved.copyId).noteStatus, "synced");
    assert.equal(f.provider.transfers, 1);
    assert.equal(f.provider.shares, 1);
    const changed = note.replace("# 更新后的标题", "# 我手动改了生成区");
    await writeFile(row.path, changed);
    await assert.rejects(f.app.notes.export(saved.copyId), {
      code: "NOTE_CONFLICT",
    });
    await f.add(false, {
      id: saved.resourceId,
      copyId: saved.copyId,
      title: "资料已保存但笔记有冲突",
    });
    assert.equal(
      f.app.repo.getResource(saved.resourceId).title,
      "资料已保存但笔记有冲突",
    );
    assert.equal(f.app.repo.getCopy(saved.copyId).noteStatus, "conflict");
    assert.equal(await readFile(row.path, "utf8"), changed);
  } finally {
    await f.cleanup();
  }
});

test("一致性备份能重开，排除Key与登录态，包含资源和封面目录", async () => {
  const f = await fixture();
  try {
    const saved = await f.add(false);
    await f.app.secrets.set("openrouter", "private-key");
    f.ports.chooseDirectory = async () => f.dir;
    const folder = await f.app.backup();
    assert.ok(folder);
    const backup = new Database(join(folder, "panxu.db"));
    try {
      assert.equal(backup.get<any>("SELECT COUNT(*) n FROM secrets").n, 0);
      assert.equal(
        backup.get<any>("SELECT status FROM accounts").status,
        "disconnected",
      );
      assert.equal(
        backup.get<any>("SELECT id FROM resources").id,
        saved.resourceId,
      );
      assert.equal(
        JSON.parse(await readFile(join(folder, "manifest.json"), "utf8"))
          .credentialsIncluded,
        false,
      );
    } finally {
      backup.close();
    }
  } finally {
    await f.cleanup();
  }
});

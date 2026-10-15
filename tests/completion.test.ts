import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture, removeV5 } from "./helpers";
import { parseCsv } from "../core/bulk";
import { inspectBackup, stageRestore, fileHash } from "../core/backups";
import { Database } from "../core/database";
import { platformSpecs } from "../shared/platforms";
import type {
  ImportPreview,
  ResourcePage,
  Draft,
  ShareCheck,
  Pool,
} from "../shared/types";

test("CSV支持BOM、引号、逗号与多行文本，拒绝破损或超量输入", () => {
  assert.deepEqual(
    parseCsv(
      '\uFEFF标题,链接,分类\r\n"含逗号,标题",abc,"换行\n说明"\r\n"双""引号",def,分类',
    ),
    [
      ["标题", "链接", "分类"],
      ["含逗号,标题", "abc", "换行\n说明"],
      ['双"引号', "def", "分类"],
    ],
  );
  for (const text of ['a,"b', 'a,b"c', '"a"x,b'])
    assert.throws(() => parseCsv(text), { code: "INVALID_CSV" });
  assert.throws(() => parseCsv("a\n".repeat(503)), {
    code: "IMPORT_TOO_LARGE",
  });
});

test("批量预检识别重复、错盘账号与无效链接，只导入本地草稿且提交令牌不可重放", async () => {
  const f = await fixture();
  try {
    await f.add(false);
    const csv =
      "标题,链接,分类,标签,说明,账号,提取码\n已有,https://pan.quark.cn/s/source123,测试,,,,\n新增,https://pan.quark.cn/s/bulk123,测试,办公；清单,资料说明,,aB12\n重复,https://pan.quark.cn/s/bulk123,测试,,,,\n错盘,https://pan.baidu.com/s/1bulk,测试,,,夸克本人,\n无效,https://example.com,测试,,,,";
    const preview = (await f.app.invoke("resource.importPreview", {
      text: csv,
    })) as ImportPreview;
    assert.deepEqual(
      preview.rows.map((r) => r.status),
      ["skip", "new", "skip", "invalid", "invalid"],
    );
    assert.equal(f.app.repo.resourceTotals().resources, 1);
    const result = (await f.app.invoke("resource.importCommit", {
      token: preview.token,
      rows: [3],
    })) as any;
    assert.equal(result.created, 1);
    assert.equal(f.app.repo.jobs().length, 0);
    assert.equal(f.provider.transfers, 0);
    assert.equal(f.provider.shares, 0);
    const resource = f.app.repo.resources("新增")[0];
    assert.deepEqual(resource.tags, ["办公", "清单"]);
    assert.equal(resource.copies[0].status, "draft");
    assert.equal(await f.app.secrets.get(`source:${resource.id}`), "aB12");
    await assert.rejects(
      f.app.invoke("resource.importCommit", {
        token: preview.token,
        rows: [3],
      }),
      { code: "IMPORT_EXPIRED" },
    );
  } finally {
    await f.cleanup();
  }
});

test("批量新账号副本保留原资源信息，提交时重查账号状态及并发重复", async () => {
  const f = await fixture();
  try {
    const first = await f.add(false);
    const second = (await f.app.invoke("account.add", {
      provider: "quark",
      alias: "夸克备用",
    })) as any;
    const csv =
      "标题,链接,分类\n不覆盖原标题,https://pan.quark.cn/s/source123,不覆盖原分类";
    let preview = (await f.app.invoke("resource.importPreview", {
      text: csv,
      targets: { quark: second.id },
    })) as ImportPreview;
    assert.equal(preview.rows[0].status, "copy");
    let result = (await f.app.invoke("resource.importCommit", {
      token: preview.token,
      rows: [2],
    })) as any;
    assert.equal(result.created, 1);
    assert.equal(
      f.app.repo.getResource(first.resourceId).title,
      "AI办公练习清单",
    );
    assert.equal(f.app.repo.getResource(first.resourceId).copies.length, 2);
    preview = (await f.app.invoke("resource.importPreview", {
      text: "标题,链接,分类\n新,https://pan.quark.cn/s/changed123,测试",
      targets: { quark: second.id },
    })) as ImportPreview;
    f.app.db.run("UPDATE accounts SET enabled=0 WHERE id=?", second.id);
    result = (await f.app.invoke("resource.importCommit", {
      token: preview.token,
      rows: [2],
    })) as any;
    assert.equal(result.failed, 1);
    assert.equal(f.app.repo.resourceTotals().resources, 1);
    preview = (await f.app.invoke("resource.importPreview", {
      text: "标题,链接,分类\n新,https://pan.quark.cn/s/concurrent123,测试",
    })) as ImportPreview;
    await f.add(false, { sourceText: "https://pan.quark.cn/s/concurrent123" });
    result = (await f.app.invoke("resource.importCommit", {
      token: preview.token,
      rows: [2],
    })) as any;
    assert.equal(result.skipped, 1);
    assert.equal(result.created, 0);
  } finally {
    await f.cleanup();
  }
});

test("全库分页、短中文和FTS检索覆盖500份之外的资源，页码与分类统计准确", async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 525; n++)
      await f.add(false, {
        title: `资料${n}`,
        sourceText: `https://pan.quark.cn/s/page${n}`,
        category: n === 0 ? "旧档分类" : "新档分类",
        summary: n === 0 ? "隐存资料旧记录" : "普通资料",
      });
    const page = (await f.app.invoke("resource.page", {
      page: 21,
      pageSize: 25,
    })) as ResourcePage;
    assert.equal(page.total, 525);
    assert.equal(page.items.length, 25);
    assert.equal(page.page, 21);
    const searched = (await f.app.invoke("resource.page", {
      query: "隐存资料",
      category: "旧档分类",
      accountId: f.account.id,
    })) as ResourcePage;
    assert.equal(searched.total, 1);
    assert.equal(searched.items[0].title, "资料0");
    assert.equal(
      ((await f.app.invoke("resource.page", { query: "隐存" })) as ResourcePage)
        .total,
      1,
    );
    assert.equal(
      ((await f.app.invoke("resource.page", { page: 999 })) as ResourcePage)
        .page,
      21,
    );
    assert.equal(
      ((await f.app.invoke("resource.page", { query: '%_"' })) as ResourcePage)
        .total,
      0,
    );
    assert.deepEqual(
      f.app.repo.resourceTotals().categories.sort(),
      ["旧档分类", "新档分类"].sort(),
    );
    assert.equal(
      (
        (await f.app.invoke("resource.get", {
          id: searched.items[0].id,
        })) as any
      ).title,
      "资料0",
    );
  } finally {
    await f.cleanup();
  }
});

test("本人分享巡检区分有效、失效与网络失败；不转存、不重建分享且跨UID禁止核验", async () => {
  const f = await fixture();
  try {
    const saved = await f.add();
    await f.app.queue.execute(saved.jobId);
    const check = async () =>
      (await f.app.invoke("copies.check", {
        copyIds: [saved.copyId, saved.copyId],
      })) as ShareCheck[];
    assert.equal((await check()).length, 1);
    assert.equal((await check())[0].status, "valid");
    const verify = f.provider.verifyShare.bind(f.provider);
    f.provider.verifyShare = async () => {
      throw new Error("网络中断");
    };
    assert.equal((await check())[0].status, "unavailable");
    assert.ok(f.app.repo.getCopy(saved.copyId).shareVerifiedAt);
    f.provider.verifyShare = verify;
    f.provider.ownValid = false;
    assert.equal((await check())[0].status, "invalid");
    assert.equal(f.app.repo.getCopy(saved.copyId).shareVerifiedAt, null);
    f.provider.ownValid = true;
    f.provider.uid = "other-owner";
    assert.equal((await check())[0].status, "unavailable");
    assert.equal(f.app.repo.getCopy(saved.copyId).shareVerifiedAt, null);
    assert.equal(f.provider.transfers, 1);
    assert.equal(f.provider.shares, 1);
    assert.equal(f.app.snapshot().shareChecks.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("十个平台本地模板不调用AI、不携带来源链接，手工词池去重且不伪造指标", async () => {
  const f = await fixture();
  try {
    const saved = await f.add(false, {
      summary: "资料说明 https://pan.quark.cn/s/private123 提取码：abcd",
    });
    const bodies = new Set<string>();
    for (const platform of platformSpecs) {
      const d = (await f.app.invoke("draft.manual", {
        copyId: saved.copyId,
        platform: platform.id,
        template: true,
      })) as Draft;
      assert.equal(d.model, "local-template");
      assert.equal(d.reviewed, false);
      assert.match(d.body, /请填写经核实/);
      assert.doesNotMatch(d.body, /https?:|abcd/);
      bodies.add(d.body);
    }
    assert.equal(bodies.size, 10);
    assert.equal(f.app.snapshot().apiCalls.length, 0);
    const pool = (await f.app.invoke("pool.manual", {
      name: "本地词池",
      resourceId: saved.resourceId,
      words: "办公，清单\n办公",
    })) as Pool;
    assert.deepEqual(
      pool.keywords.map((k) => k.word),
      ["办公", "清单"],
    );
    assert.ok(
      pool.keywords.every(
        (k) =>
          k.source === "手工录入" &&
          Object.keys(k.metrics).length === 0 &&
          k.sourceUpdatedAt === null,
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("内容包导出执行人工审阅、本人分享和渠道检查，导出不视为发布且不泄漏来源", async () => {
  const f = await fixture();
  try {
    const saved = await f.add();
    await f.app.queue.execute(saved.jobId);
    let draft = (await f.app.invoke("draft.manual", {
      copyId: saved.copyId,
      platform: "x",
      template: true,
    })) as Draft;
    const args = { draftId: draft.id, bindingId: null, includeLink: false };
    await assert.rejects(f.app.invoke("publication.export", args), {
      code: "REVIEW_REQUIRED",
    });
    draft = (await f.app.invoke("draft.save", {
      id: draft.id,
      title: "独立练习",
      body: "已核实的资料说明",
      tags: [],
      coverText: "",
    })) as Draft;
    await f.app.invoke("draft.review", { id: draft.id, reviewed: true });
    args.draftId = draft.id;
    await assert.rejects(
      f.app.invoke("publication.export", { ...args, includeLink: true }),
      { code: "CHANNEL_LINK_BLOCKED" },
    );
    assert.equal(await f.app.invoke("publication.export", args), null);
    f.ports.chooseDirectory = async () => f.dir;
    const result = (await f.app.invoke("publication.export", args)) as {
      folder: string;
    };
    const text = await readFile(join(result.folder, "发布文案.txt"), "utf8");
    assert.match(text, /已核实/);
    assert.doesNotMatch(text, /source123|own123|提取码/);
    assert.equal(
      JSON.parse(await readFile(join(result.folder, "内容信息.json"), "utf8"))
        .published,
      false,
    );
    assert.equal(f.app.snapshot().publications.length, 0);
    f.provider.ownValid = false;
    await assert.rejects(f.app.invoke("publication.export", args), {
      code: "SHARE_INVALID",
    });
  } finally {
    await f.cleanup();
  }
});

test("备份预检与恢复建立新空间，保留原件，排除凭据并暂停任务、撤销审阅与分发权限", async () => {
  const f = await fixture();
  try {
    const saved = await f.add();
    await f.app.queue.execute(saved.jobId);
    const pending = await f.add(true, {
      sourceText: "https://pan.quark.cn/s/pending123",
    });
    const draft = (await f.app.invoke("draft.manual", {
      copyId: saved.copyId,
      platform: "x",
      template: true,
    })) as Draft;
    await f.app.invoke("draft.review", { id: draft.id, reviewed: true });
    await f.app.invoke("binding.save", {
      platform: "x",
      alias: "测试",
      windowId: "window",
      editorUrl: "https://x.com/compose/post",
      linkPermission: "allowed",
      ruleNote: "已核对相关资源发布场景及账号权限",
    });
    await f.app.secrets.set("openrouter", "test-private-backup-key");
    const opaque = f.app.db.get<any>(
      "SELECT value FROM secrets WHERE key='openrouter'",
    ).value;
    f.ports.chooseDirectory = async () => f.dir;
    const folder = (await f.app.backup())!;
    assert.equal((await inspectBackup(folder)).resources, 2);
    assert.ok(
      !(await readFile(join(folder, "panxu.db"))).includes(Buffer.from(opaque)),
    );
    const hash = await fileHash(join(folder, "panxu.db"));
    const restored = await stageRestore(folder, f.dir, hash);
    assert.notEqual(restored.dataPath, f.dir);
    assert.equal(await fileHash(join(folder, "panxu.db")), hash);
    assert.equal(f.app.repo.getJob(pending.jobId).stage, "queued");
    assert.equal(f.app.repo.draft(draft.id).reviewed, true);
    const copy = new Database(join(restored.dataPath, "panxu.db"));
    try {
      assert.equal(copy.get<any>("SELECT count(*) n FROM secrets").n, 0);
      assert.equal(
        copy.get<any>("SELECT stage FROM jobs WHERE id=?", pending.jobId).stage,
        "needs_review",
      );
      assert.equal(
        copy.get<any>("SELECT status FROM copies WHERE id=?", pending.copyId)
          .status,
        "needs_review",
      );
      assert.equal(
        copy.get<any>(
          "SELECT share_verified_at FROM copies WHERE id=?",
          saved.copyId,
        ).share_verified_at,
        null,
      );
      assert.equal(copy.get<any>("SELECT reviewed FROM drafts").reviewed, 0);
      assert.equal(
        copy.get<any>("SELECT link_permission FROM browser_bindings")
          .link_permission,
        "none",
      );
      assert.equal(copy.setting("dailyAiBudgetMicros", -1), 0);
      assert.equal(copy.setting("restorePreviousDataPath", ""), f.dir);
    } finally {
      copy.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("恢复拒绝被篡改、含凭据、侧写日志、缺失封面和符号链接的备份", async () => {
  for (const scenario of [
    "database",
    "secrets",
    "wal",
    "missing-cover",
    "cover",
    "symlink",
  ]) {
    const f = await fixture();
    try {
      const saved = await f.add(false);
      if (scenario === "missing-cover")
        f.app.db.run(
          "UPDATE resources SET cover_id=? WHERE id=?",
          "a".repeat(64),
          saved.resourceId,
        );
      f.ports.chooseDirectory = async () => f.dir;
      const folder = (await f.app.backup())!;
      const path = join(folder, "panxu.db");
      if (scenario === "database") await writeFile(path, "tampered");
      if (scenario === "wal") await writeFile(path + "-wal", "");
      if (scenario === "secrets") {
        const db = new DatabaseSync(path);
        db.prepare("INSERT INTO secrets VALUES(?,?)").run("bad", "opaque");
        db.close();
        const m = JSON.parse(
          await readFile(join(folder, "manifest.json"), "utf8"),
        );
        m.databaseSha256 = await fileHash(path);
        await writeFile(join(folder, "manifest.json"), JSON.stringify(m));
      }
      if (scenario === "cover")
        await writeFile(
          join(folder, "covers", `${"b".repeat(64)}.png`),
          "tampered",
        );
      if (scenario === "symlink") {
        await rm(path);
        await symlink(join(f.dir, "panxu.db"), path);
      }
      await assert.rejects(inspectBackup(folder));
    } finally {
      await f.cleanup();
    }
  }
});

test("恢复必须使用有效预检令牌、显式确认并先处理活动任务", async () => {
  const f = await fixture();
  try {
    const saved = await f.add();
    f.ports.chooseDirectory = async () => f.dir;
    const folder = (await f.app.backup())!;
    f.ports.chooseDirectory = async () => folder;
    const preview = (await f.app.invoke("system.backupPreview")) as any;
    await assert.rejects(
      f.app.invoke("system.restore", { token: "wrong", confirmed: true }),
      { code: "RESTORE_PREVIEW_REQUIRED" },
    );
    await assert.rejects(
      f.app.invoke("system.restore", {
        token: preview.token,
        confirmed: false,
      }),
    );
    await assert.rejects(
      f.app.invoke("system.restore", { token: preview.token, confirmed: true }),
      { code: "JOBS_RUNNING" },
    );
    f.app.db.run("UPDATE jobs SET stage='cancelled' WHERE id=?", saved.jobId);
    let activated = "";
    f.ports.activateDataPath = async (path) => {
      activated = path;
    };
    await f.app.invoke("system.restore", {
      token: preview.token,
      confirmed: true,
    });
    assert.ok(activated.includes("restored-workspaces"));
    await assert.rejects(f.app.invoke("resource.importFile"), {
      code: "WORKSPACE_SWITCHING",
    });
  } finally {
    await f.cleanup();
  }
});

test("超过一批的笔记待办全部处理，旧任务读取不受最近300条列表限制", async () => {
  const f = await fixture();
  try {
    const first = await f.add(false);
    for (let n = 0; n < 325; n++)
      f.app.db.run(
        "INSERT INTO jobs(id,copy_id,stage,created_at,updated_at) VALUES(?,?,?,?,?)",
        `job${n}`,
        first.copyId,
        "completed",
        String(n).padStart(5, "0"),
        String(n),
      );
    assert.equal(f.app.repo.getJob("job0").id, "job0");
    f.app.db.run("UPDATE jobs SET stage='queued' WHERE id='job0'");
    assert.equal(f.app.repo.jobs(true).length, 1);
    for (let n = 0; n < 25; n++) {
      const saved = await f.add(false, {
        sourceText: `https://pan.quark.cn/s/note${n}`,
      });
      f.app.notes.enqueue(saved.copyId);
    }
    await f.app.notes.flush();
    assert.equal(
      f.app.db.get<any>("SELECT count(*) n FROM outbox WHERE status='pending'")
        .n,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("按所选资源读取全部历史稿，单稿操作不受全局最近500条限制", async () => {
  const f = await fixture();
  try {
    const first = await f.add(false);
    const second = await f.add(false, {
      sourceText: "https://pan.quark.cn/s/otherdrafts",
    });
    const draft = (await f.app.invoke("draft.manual", {
      copyId: first.copyId,
      platform: "x",
      template: true,
    })) as Draft;
    f.app.db.run(
      "UPDATE drafts SET updated_at='2020-01-01' WHERE id=?",
      draft.id,
    );
    for (let i = 0; i < 501; i++)
      await f.app.invoke("draft.manual", {
        copyId: second.copyId,
        platform: "x",
        template: true,
      });
    assert.equal(f.app.repo.drafts().length, 500);
    assert.equal(f.app.repo.draft(draft.id).id, draft.id);
    const scoped = (await f.app.invoke("snapshot", {
      resourceId: first.resourceId,
    })) as any;
    assert.equal(scoped.drafts.length, 1);
    assert.equal(scoped.drafts[0].id, draft.id);
    await f.app.invoke("draft.review", { id: draft.id, reviewed: true });
    assert.equal(f.app.repo.draft(draft.id).reviewed, true);
  } finally {
    await f.cleanup();
  }
});

test("v3升级v4前备份并只执行一次迁移", async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, "migration-v3.db");
    new Database(path).close();
    const old = new DatabaseSync(path);
    old.exec(removeV5 + "DROP TABLE share_checks; PRAGMA user_version=3");
    old.close();
    const db = new Database(path);
    assert.equal(db.get<any>("PRAGMA user_version").user_version, 5);
    db.close();
    const backups = (await readdir(f.dir)).filter((p) =>
      p.includes("migration-v3.db.before-v4-"),
    );
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(f.dir, backups[0]), {
      readOnly: true,
    });
    assert.equal(backup.prepare("PRAGMA user_version").get()!.user_version, 3);
    backup.close();
    new Database(path).close();
    assert.equal(
      (await readdir(f.dir)).filter((p) =>
        p.includes("migration-v3.db.before-v4-"),
      ).length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

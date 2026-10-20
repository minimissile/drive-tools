import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture, removeV6, currentSchemaVersion } from "./helpers";
import { Database, id, now } from "../core/database";
import type { DriveProvider } from "../core/providers/provider";
import type { Draft, Pool } from "../shared/types";
import type { SearchTopic, SearchPage, SearchDetail } from "../shared/search";
import { inspectBackup, stageRestore } from "../core/backups";

async function ready() {
  const f = await fixture();
  const saved = await f.add();
  await f.app.queue.execute(saved.jobId);
  return { ...f, ...saved };
}
function split(f: Awaited<ReturnType<typeof ready>>) {
  const itemId = id("split"),
    file = f.provider.actual[0];
  f.app.db.run(
    "INSERT INTO split_items(id,copy_id,file_id,file,ancestors,path,depth,status,share_id,share_url,owner_uid,verified_at,share_version) VALUES(?,?,?,?,?, ?,1,'ready','child-share','https://pan.quark.cn/s/child123',?,?,1)",
    itemId,
    f.copyId,
    file.id,
    JSON.stringify(file),
    "[]",
    file.name,
    f.app.repo.getAccount(f.account.id).uid,
    now(),
  );
  return itemId;
}
async function topic(
  f: Awaited<ReturnType<typeof ready>>,
  splitItemId: string | null = null,
) {
  return f.app.invoke("search.create", {
    keyword: "Obsidian Windows 安装",
    intent: "安装与配置",
    platform: "csdn",
    copyId: f.copyId,
    splitItemId,
  }) as Promise<SearchTopic>;
}
function publication(f: Awaited<ReturnType<typeof ready>>, draft: Draft) {
  const binding = "test-binding",
    pub = id("pub");
  f.app.db.run(
    "INSERT OR IGNORE INTO browser_bindings(id,platform,alias,window_id,editor_url) VALUES(?,'csdn','本人技术账号','window','https://editor.csdn.net/')",
    binding,
  );
  f.app.db.run(
    "INSERT INTO publications(id,draft_id,draft_version,binding_id,status,url,created_at) VALUES(?,?,?,?,'published','https://blog.csdn.net/author/article/details/123',?)",
    pub,
    draft.id,
    draft.version,
    binding,
    now(),
  );
  return pub;
}
test("搜索选题：词池来源可追溯、关键词规范化去重、分页不受最近列表限制", async () => {
  const f = await fixture();
  try {
    const pool = (await f.app.invoke("pool.manual", {
      name: "教程词池",
      resourceId: null,
      words: "Obsidian 安装\nPython 配置",
    })) as Pool;
    const imported = (await f.app.invoke("search.importPool", {
      poolId: pool.id,
      keywordIds: pool.keywords.map((k) => k.id),
      platform: "csdn",
    })) as any;
    assert.equal(imported.created, 2);
    assert.equal(
      (
        (await f.app.invoke("search.importPool", {
          poolId: pool.id,
          keywordIds: pool.keywords.map((k) => k.id),
          platform: "csdn",
        })) as any
      ).skipped,
      2,
    );
    await assert.rejects(
      f.app.invoke("search.create", {
        keyword: "Ｏｂｓｉｄｉａｎ  安装",
        platform: "csdn",
      }),
      { code: "DUPLICATE_TOPIC" },
    );
    await assert.rejects(
      f.app.invoke("search.create", {
        keyword: "冒充词池",
        poolId: pool.id,
        keywordId: pool.keywords[0].id,
      }),
      { code: "KEYWORD_MISMATCH" },
    );
    for (let n = 0; n < 125; n++)
      await f.app.invoke("search.create", { keyword: `教程选题 ${n}` });
    const page = (await f.app.invoke("search.list", {
      page: 3,
      pageSize: 60,
    })) as SearchPage;
    assert.equal(page.total, 127);
    assert.equal(page.items.length, 7);
    assert.equal(page.counts.unbound, 127);
    assert.equal(
      ((await f.app.invoke("search.list", { query: "Python" })) as SearchPage)
        .items[0].poolId,
      pool.id,
    );
    assert.equal(f.app.repo.calls().length, 0);
    assert.equal(f.provider.transfers, 0);
    assert.equal(f.provider.shares, 0);
  } finally {
    await f.cleanup();
  }
});
test("本人拆分链接用于创作：跨副本与未知归属被拒绝，保存新版本保留选题和子链接", async () => {
  const f = await ready();
  try {
    const item = split(f),
      t = await topic(f, item),
      draft = (await f.app.invoke("search.write", { id: t.id })) as Draft;
    assert.equal(draft.topicId, t.id);
    assert.equal(draft.splitItemId, item);
    assert.equal(draft.splitShareVersion, 1);
    assert.equal(draft.reviewed, false);
    assert.match(draft.body, /软件版本：待核对/);
    assert.doesNotMatch(draft.body, /https:\/\//);
    assert.equal(
      ((await f.app.invoke("search.write", { id: t.id })) as Draft).id,
      draft.id,
    );
    const saved = (await f.app.invoke("draft.save", {
      id: draft.id,
      title: "经过核对的教程",
      body: "完整操作步骤。",
      tags: [],
      coverText: "",
    })) as Draft;
    assert.equal(saved.topicId, t.id);
    assert.equal(saved.splitItemId, item);
    assert.equal(saved.version, 2);
    const other = await f.add(false, {
      sourceText: "https://pan.quark.cn/s/another",
    });
    await assert.rejects(
      f.app.invoke("search.bind", {
        id: t.id,
        copyId: other.copyId,
        splitItemId: item,
      }),
      { code: "OWNERSHIP_UNVERIFIED" },
    );
    f.app.db.run("UPDATE split_items SET owner_uid='other' WHERE id=?", item);
    await assert.rejects(f.app.invoke("search.generate", { id: t.id }), {
      code: "OWNERSHIP_UNVERIFIED",
    });
  } finally {
    await f.cleanup();
  }
});
test("发布准备使用配套子链接和子提取码，过期版本、文件变更、失效分享均阻断", async () => {
  const f = await ready();
  try {
    const item = split(f);
    await f.app.secrets.set(`split:${item}`, "abcd");
    const t = await topic(f, item),
      draft = (await f.app.invoke("search.write", { id: t.id })) as Draft;
    const edited = (await f.app.invoke("draft.save", {
      id: draft.id,
      title: "教程",
      body: "本人核对的具体步骤。",
      tags: [],
      coverText: "",
    })) as Draft;
    await f.app.invoke("draft.review", { id: edited.id, reviewed: true });
    const binding = (await f.app.invoke("binding.save", {
      platform: "csdn",
      alias: "技术账号",
      windowId: "test",
      editorUrl: "https://editor.csdn.net/",
      linkPermission: "allowed",
      ruleNote: "本人已核对当前账号允许配套资料链接的实际场景",
    })) as any;
    const checked: string[] = [];
    (f.provider as DriveProvider).verifyShare = async (_a, shareId) => {
      checked.push(shareId);
      return f.provider.ownValid;
    };
    const pack = await f.app.contentPackage(edited.id, binding.id, true);
    assert.match(pack.text, /child123/);
    assert.match(pack.text, /提取码：abcd/);
    assert.doesNotMatch(pack.text, /own123|source123/);
    assert.deepEqual(checked, ["child-share"]);
    f.app.db.run("UPDATE split_items SET share_version=2 WHERE id=?", item);
    await assert.rejects(f.app.contentPackage(edited.id, binding.id, true), {
      code: "STALE_DRAFT",
    });
    await f.app.invoke("draft.review", { id: edited.id, reviewed: true });
    f.provider.actual = [];
    await assert.rejects(f.app.contentPackage(edited.id, binding.id, false));
    f.provider.actual = f.app.repo.getCopy(f.copyId).files;
    f.provider.ownValid = false;
    await assert.rejects(f.app.contentPackage(edited.id, binding.id, false), {
      code: "SHARE_INVALID",
    });
    assert.equal(f.app.operations.splitItem(item).verifiedAt, null);
    assert.equal(
      ((await f.app.invoke("search.get", { id: t.id })) as SearchDetail).topic
        .attention.length > 0,
      true,
    );
  } finally {
    await f.cleanup();
  }
});
test("搜索效果：单篇与账号隔离，零与未知保留，重复周期拒绝，未发布草稿不可记收益", async () => {
  const f = await ready();
  try {
    const t = await topic(f),
      draft = (await f.app.invoke("search.write", { id: t.id })) as Draft,
      pub = publication(f, draft);
    const input = {
      publicationId: pub,
      scope: "article",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-15",
      views: 0,
      saves: null,
      newUsers: 2,
      revenueCents: 800,
      source: "本人后台报表",
    };
    await f.app.invoke("search.effect", input);
    await f.app.invoke("search.effect", {
      ...input,
      scope: "account",
      views: 2000,
    });
    await assert.rejects(f.app.invoke("search.effect", input), {
      code: "DUPLICATE_EFFECT",
    });
    await assert.rejects(
      f.app.invoke("search.effect", { ...input, publicationId: "missing" }),
      { code: "PUBLICATION_REQUIRED" },
    );
    await assert.rejects(
      f.app.invoke("search.effect", {
        ...input,
        source: "其他",
        periodEnd: "2026-09-30",
      }),
    );
    await assert.rejects(
      f.app.invoke("search.effect", {
        ...input,
        source: "其他",
        periodStart: "2026-02-30",
      }),
    );
    await assert.rejects(
      f.app.invoke("search.effect", { ...input, source: "其他", views: -1 }),
    );
    const detail = (await f.app.invoke("search.get", {
      id: t.id,
    })) as SearchDetail;
    assert.equal(detail.topic.stage, "published");
    assert.equal(detail.effects.length, 2);
    assert.equal(
      detail.effects.find((e) => e.scope === "account")!.topicId,
      null,
    );
    assert.equal(detail.effects.find((e) => e.scope === "article")!.views, 0);
    assert.equal(
      detail.effects.find((e) => e.scope === "article")!.saves,
      null,
    );
    let exported = "";
    f.ports.saveFile = async (_name, bytes) => {
      exported = bytes.toString();
      return "/test/effects.csv";
    };
    await f.app.invoke("search.effectsExport", { id: t.id });
    assert.match(exported, /单篇文章/);
    assert.match(exported, /账号汇总/);
  } finally {
    await f.cleanup();
  }
});
test("v5升级v6：迁移前一致性快照、旧数据保留、备份恢复保留选题与效果且清空核验", async () => {
  const f = await ready();
  try {
    const item = split(f),
      t = await topic(f, item),
      d = (await f.app.invoke("search.write", { id: t.id })) as Draft,
      pub = publication(f, d);
    await f.app.invoke("search.effect", {
      publicationId: pub,
      scope: "article",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-15",
      views: 0,
      saves: null,
      newUsers: null,
      revenueCents: null,
      source: "手工核对",
    });
    f.ports.chooseDirectory = async () => f.dir;
    const folder = await f.app.backup();
    assert.ok(folder);
    const preview = await inspectBackup(folder!);
    assert.equal(
      JSON.parse(await readFile(join(folder!, "manifest.json"), "utf8"))
        .schemaVersion,
      currentSchemaVersion,
    );
    const restored = await stageRestore(folder!, f.dir, preview.databaseSha256),
      db = new Database(join(restored.dataPath, "panxu.db"));
    assert.equal(db.get<any>("SELECT COUNT(*) n FROM search_topics").n, 1);
    assert.equal(db.get<any>("SELECT COUNT(*) n FROM effect_records").n, 1);
    assert.equal(
      db.get<any>("SELECT verified_at FROM split_items").verified_at,
      null,
    );
    db.close();
    const oldPath = join(f.dir, "old-v5.db");
    new Database(oldPath).close();
    const old = new DatabaseSync(oldPath);
    old.exec(removeV6 + "PRAGMA user_version=5");
    old.close();
    const migrated = new Database(oldPath);
    assert.equal(
      migrated.get<any>("PRAGMA user_version").user_version,
      currentSchemaVersion,
    );
    migrated.close();
    new Database(oldPath).close();
    const backups = (await readdir(f.dir)).filter((n) =>
      n.startsWith("old-v5.db.before-v6-"),
    );
    assert.equal(backups.length, 1);
    assert.equal((await stat(join(f.dir, backups[0]))).mode & 0o777, 0o600);
    const snap = new DatabaseSync(join(f.dir, backups[0]), { readOnly: true });
    assert.equal(snap.prepare("PRAGMA user_version").get()!.user_version, 5);
    snap.close();
  } finally {
    await f.cleanup();
  }
});

test("搜索 AI 草稿沿用模型预算与调用台账，只提供所选配套资料及明确录入的教程依据", async () => {
  const f = await ready();
  try {
    const item = split(f),
      t = await topic(f, item);
    await f.app.invoke("search.facts", {
      id: t.id,
      intent: "首次安装",
      softwareVersion: "本人核对版本",
      operatingSystem: "Windows",
      evidence: "本人实际完成安装并记录截图位置。",
    });
    await f.app.secrets.set("openrouter", "test-placeholder");
    f.app.db.setSetting("model", "test/structured");
    let input: any;
    (f.app.ai as any).requestJson = async (_url: string, init: any) => {
      input = JSON.parse(JSON.parse(init.body).messages[1].content);
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "安装教程",
                body: "依据本人记录整理的待审阅教程。",
                tags: [],
                coverText: "",
              }),
            },
          },
        ],
        usage: { cost: 0.00001 },
      };
    };
    const d = (await f.app.invoke("search.generate", { id: t.id })) as Draft;
    assert.equal(d.topicId, t.id);
    assert.equal(d.splitItemId, item);
    assert.equal(d.reviewed, false);
    assert.deepEqual(input.filenames, [f.provider.actual[0].name]);
    assert.equal(input.searchTopic.operatingSystem, "Windows");
    assert.doesNotMatch(
      JSON.stringify(input),
      /child123|own123|source123|test-placeholder/,
    );
    assert.equal(f.app.repo.calls()[0].confirmedMicros, 10);
  } finally {
    await f.cleanup();
  }
});

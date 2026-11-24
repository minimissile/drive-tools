import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers";
import { Database } from "../core/database";
import { saveContentImage } from "../core/content-assets";
import { fileHash, inspectBackup, stageRestore } from "../core/backups";
import type { JianshuArticle, JianshuSource } from "../shared/jianshu";

const body =
  "这是一篇用于备份恢复验证的资料说明文章，包含已知资料的适用范围与使用建议。恢复时需要保留正文、素材来源和旧版本配图。";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
async function setup() {
  const f = await fixture();
  try {
    const image = await saveContentImage(f.dir, png, "原版配图");
    const draft = f.app.jianshu.create({
      requestId: randomUUID(),
      title: "资料备份",
      body,
    });
    const source: JianshuSource = {
      id: "source_backup",
      provider: "rss",
      title: "原资料介绍",
      body,
      summary: body,
      url: "http://example.com/item",
      sourceName: "示例站点",
      author: "原作者",
      publishedAt: null,
      collectedAt: new Date().toISOString(),
      images: [],
      externalShares: [],
      warnings: [],
    };
    f.app.db.setSetting("jianshu:sources:v1", [source.id]);
    f.app.db.setSetting(`jianshu:source:v1:${source.id}`, source);
    const article = {
      ...draft.article,
      sourceIds: [],
      stage: "preparing",
      images: [],
      versions: [
        {
          ...draft.article.versions[0],
          images: [image],
          sourceIds: [source.id],
          copyId: null,
          template: "guide",
        },
      ],
      preparedUid: "old_user",
      preparedEnvironment: "old-env-stamp",
      preparedText: body,
      editorUrl: "https://www.jianshu.com/writer#/",
      preparedRevision: 1,
    } satisfies JianshuArticle;
    f.app.db.setSetting(`jianshu:article:v1:${article.id}`, article);
    const requestId = randomUUID();
    f.app.db.setSetting("jianshu:generations:v1", [requestId]);
    f.app.db.setSetting(`jianshu:generation:v1:${requestId}`, {
      articleId: article.id,
      inputHash: "a".repeat(64),
      status: "running",
    });
    f.app.db.setSetting("jianshu:authorization:v1", {
      approved: true,
      cookie: "not-restored",
    });
    f.ports.chooseDirectory = async () => f.dir;
    const backup = (await f.app.backup())!;
    return { ...f, backup, article, image, requestId };
  } catch (error) {
    await f.cleanup();
    throw error;
  }
}
async function editBackupDatabase(
  folder: string,
  edit: (db: Database) => void,
) {
  const db = new Database(join(folder, "panxu.db"));
  try {
    edit(db);
    db.run("PRAGMA journal_mode=DELETE");
  } finally {
    db.close();
  }
  const manifest = JSON.parse(
    await readFile(join(folder, "manifest.json"), "utf8"),
  );
  manifest.databaseSha256 = await fileHash(join(folder, "panxu.db"));
  await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest));
}

test("简书备份恢复保留来源、正文、旧版本配图和请求记录，撤销运行状态与未知设置", async () => {
  const f = await setup();
  let restored: Database | undefined;
  try {
    const inspected = await inspectBackup(f.backup);
    assert.ok(inspected.contentAssets.includes(f.image.file));
    const staged = await stageRestore(
      f.backup,
      f.dir,
      inspected.databaseSha256,
    );
    restored = new Database(join(staged.dataPath, "panxu.db"));
    const article = restored.setting<JianshuArticle | null>(
      `jianshu:article:v1:${f.article.id}`,
      null,
    )!;
    assert.equal(article.body, body);
    assert.equal(article.stage, "uncertain");
    assert.equal(article.preparedUid, null);
    assert.equal(article.preparedEnvironment, null);
    assert.equal(article.editorUrl, null);
    assert.equal(article.versions[0].images[0].file, f.image.file);
    assert.deepEqual(article.versions[0].sourceIds, ["source_backup"]);
    assert.equal(article.versions[0].copyId, null);
    assert.equal(article.versions[0].template, "guide");
    assert.ok(
      (
        await readFile(join(staged.dataPath, "content-assets", f.image.file))
      ).equals(png),
    );
    assert.equal(
      restored.setting<JianshuSource>(
        "jianshu:source:v1:source_backup",
        {} as JianshuSource,
      ).author,
      "原作者",
    );
    assert.equal(
      restored.setting<JianshuSource>(
        "jianshu:source:v1:source_backup",
        {} as JianshuSource,
      ).url,
      "http://example.com/item",
    );
    assert.equal(
      restored.setting<any>(`jianshu:generation:v1:${f.requestId}`, null)
        .status,
      "interrupted",
    );
    assert.equal(restored.setting("jianshu:authorization:v1", null), null);
  } finally {
    restored?.close();
    await f.cleanup();
  }
});

test("旧版本引用的简书配图缺失会阻止预检与恢复", async () => {
  const f = await setup();
  try {
    const inspected = await inspectBackup(f.backup);
    await rm(join(f.backup, "content-assets", f.image.file));
    await assert.rejects(inspectBackup(f.backup), { code: "INVALID_BACKUP" });
    await assert.rejects(
      stageRestore(f.backup, f.dir, inspected.databaseSha256),
      { code: "INVALID_BACKUP" },
    );
  } finally {
    await f.cleanup();
  }
});

test("备份恢复保留具体官网草稿、归属线索和填写检查点，仍要求重新核实登录", async () => {
  const f = await setup();
  let restored: Database | undefined;
  try {
    const editorUrl =
      "https://www.jianshu.com/writer#/notebooks/57443510/notes/146614893";
    const checkpoint = {
      editorUrl,
      filled: false,
      uploadedImages: 1,
      totalImages: 1,
      titleHash: "a".repeat(64),
      textHash: "b".repeat(64),
      pendingImageSha256: f.image.sha256,
      uploadedImageRefs: [
        {
          sha256: f.image.sha256,
          url: "https://upload-images.jianshu.io/upload_images/test.png",
        },
      ],
    };
    await editBackupDatabase(f.backup, (db) =>
      db.setSetting(`jianshu:article:v1:${f.article.id}`, {
        ...f.article,
        images: [f.image],
        editorUrl,
        preparedFill: checkpoint,
      }),
    );
    const inspected = await inspectBackup(f.backup);
    const staged = await stageRestore(
      f.backup,
      f.dir,
      inspected.databaseSha256,
    );
    restored = new Database(join(staged.dataPath, "panxu.db"));
    const article = restored.setting<JianshuArticle>(
      `jianshu:article:v1:${f.article.id}`,
      f.article,
    );
    assert.equal(article.stage, "uncertain");
    assert.equal(article.editorUrl, editorUrl);
    assert.deepEqual(article.preparedFill, checkpoint);
    assert.equal(
      article.preparedUid,
      "old_user",
      "历史归属仅用于与fresh身份比对，不能作为登录授权",
    );
    assert.equal(article.preparedEnvironment, null);
  } finally {
    restored?.close();
    await f.cleanup();
  }
});

test("官网检查点损坏、图片地址带凭据或草稿不一致时阻止恢复", async () => {
  const f = await setup();
  try {
    const editorUrl =
      "https://www.jianshu.com/writer#/notebooks/57443510/notes/146614893";
    const valid = {
      editorUrl,
      filled: false,
      uploadedImages: 0,
      totalImages: 1,
    };
    for (const preparedFill of [
      { ...valid, editorUrl: editorUrl.replace("146614893", "146614894") },
      { ...valid, textHash: "not-a-hash" },
      { ...valid, pendingImageSha256: "not-a-hash" },
      { ...valid, uploadedImages: 2 },
      {
        ...valid,
        uploadedImageRefs: [
          {
            sha256: f.image.sha256,
            url: "https://user:password@upload-images.jianshu.io/image.png",
          },
        ],
      },
      {
        ...valid,
        uploadedImageRefs: [
          {
            sha256: f.image.sha256,
            url: "http://upload-images.jianshu.io/image.png",
          },
        ],
      },
    ]) {
      await editBackupDatabase(f.backup, (db) =>
        db.setSetting(`jianshu:article:v1:${f.article.id}`, {
          ...f.article,
          editorUrl,
          preparedFill,
        }),
      );
      await assert.rejects(inspectBackup(f.backup), { code: "INVALID_BACKUP" });
    }
  } finally {
    await f.cleanup();
  }
});

test("简书素材引用或哈希被改坏时不能作为空数据恢复", async () => {
  const f = await setup();
  try {
    await editBackupDatabase(f.backup, (db) =>
      db.run(
        "DELETE FROM settings WHERE key=?",
        "jianshu:source:v1:source_backup",
      ),
    );
    await assert.rejects(inspectBackup(f.backup), { code: "INVALID_BACKUP" });
  } finally {
    await f.cleanup();
  }
});

test("备份中的内网原文或非默认端口图片引用不能恢复", async () => {
  const f = await setup();
  try {
    await editBackupDatabase(f.backup, (db) => {
      const item = db.setting<JianshuSource>(
        "jianshu:source:v1:source_backup",
        {} as JianshuSource,
      );
      db.setSetting("jianshu:source:v1:source_backup", {
        ...item,
        images: [
          { url: "https://example.com:444/cover.jpg", alt: "不安全引用" },
        ],
      });
    });
    await assert.rejects(inspectBackup(f.backup), { code: "INVALID_BACKUP" });
    await editBackupDatabase(f.backup, (db) => {
      const item = db.setting<JianshuSource>(
        "jianshu:source:v1:source_backup",
        {} as JianshuSource,
      );
      db.setSetting("jianshu:source:v1:source_backup", {
        ...item,
        url: "http://127.0.0.1/item",
        images: [],
      });
    });
    await assert.rejects(inspectBackup(f.backup), { code: "INVALID_BACKUP" });
  } finally {
    await f.cleanup();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveContentImage, readContentImage } from "../core/content-assets";
import type { SourceMaterial } from "../shared/content-sources";
import { Database } from "../core/database";
import { PipixClient, pipixShareUrl } from "../core/pipix/client";
import { parsePipixPage } from "../core/pipix/parser";
import { PipixSources } from "../core/pipix/service";
import { inspectBackup, stageRestore } from "../core/backups";
import { fixture, removeV22 } from "./helpers";
import { weiboFixture } from "./weibo-fixture";
import {
  pipixCommentId,
  pipixHtml,
  pipixImage,
  pipixItemId,
} from "./pipix-fixture";

const signal = () => AbortSignal.timeout(5000);
const makeClient = (html = pipixHtml(), failImage = false) =>
  new PipixClient((async (url: string | URL | Request) => {
    const u = new URL(String(url));
    if (u.hostname === "h5.pipix.com") return new Response(html);
    return failImage
      ? new Response("error", { status: 403 })
      : new Response(pipixImage);
  }) as typeof fetch);

test("公开页保留大整数 ID，只采集正文图与页面评论，不猜测神评或头像", () => {
  const source = parsePipixPage(pipixHtml());
  assert.equal(source.id, pipixItemId);
  assert.notEqual(String(Number(pipixItemId)), pipixItemId);
  assert.equal(source.comments.length, 2);
  assert.equal(source.comments[0].id, pipixCommentId);
  assert.equal(source.comments[0].label, "神评");
  assert.equal(source.comments[1].label, "");
  assert.equal(source.comments[1].likes, 0);
  assert.equal(source.images.length, 1);
  assert.match(source.images[0].url, /source-0/);
  assert.equal(parsePipixPage(pipixHtml({ video: true })).images.length, 0);
  assert.match(
    parsePipixPage(pipixHtml({ images: 12 })).warnings.join(""),
    /12 张.*9 张/,
  );
  assert.throws(() => parsePipixPage("<html>请验证</html>"), /未返回帖子/);
  assert.throws(() => parsePipixPage(pipixHtml(), "123456789"), /不一致/);
  assert.throws(
    () => parsePipixPage('<script id="RENDER_DATA">%zz</script>'),
    /无法解析/,
  );
});

test("分享链接、每一跳和图片下载均限制域名，超大响应被拒绝", async () => {
  assert.equal(
    pipixShareUrl("分享给你 https://h5.pipix.com/s/AbCd/。打开看看").pathname,
    "/s/AbCd/",
  );
  for (const url of [
    "http://h5.pipix.com/s/a/",
    "https://127.0.0.1/ppx/item/123456789",
    "https://h5.pipix.com.evil.com/s/a/",
    "https://a@h5.pipix.com/s/a/",
    "https://h5.pipix.com/api/private",
  ])
    assert.throws(() => pipixShareUrl(url));
  const requests: string[] = [];
  const blocked = new PipixClient((async (url: string) => {
    requests.push(url);
    return new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/internal" },
    });
  }) as typeof fetch);
  await assert.rejects(
    blocked.collect("https://h5.pipix.com/s/a/", signal()),
    /官方帖子/,
  );
  assert.equal(requests.length, 1);
  await assert.rejects(
    blocked.image("https://evil.com/x.png", signal()),
    /图片域名/,
  );
  const oversized = new PipixClient(
    (async () =>
      new Response("x", {
        headers: { "content-length": "5000000" },
      })) as typeof fetch,
  );
  await assert.rejects(
    oversized.collect(`https://h5.pipix.com/ppx/item/${pipixItemId}`, signal()),
    /过大/,
  );
  const redirect = new PipixClient((async (url: string) =>
    String(url).includes("/s/")
      ? new Response(null, {
          status: 302,
          headers: { location: `/ppx/item/${pipixItemId}` },
        })
      : new Response(pipixHtml())) as typeof fetch);
  assert.equal(
    (await redirect.collect("https://h5.pipix.com/s/a/", signal())).id,
    pipixItemId,
  );
});

function sourcesFor(
  f: Awaited<ReturnType<typeof fixture>>,
  client = makeClient(),
) {
  return new PipixSources(
    {
      db: f.app.db,
      dataPath: f.dir,
      ports: f.ports,
      changed() {},
      destinations: {
        zhihu: (material) => f.app.zhihu.saveSource(material),
        weibo: (material, accountId) =>
          f.app.weiboPosts.saveSource(material, accountId),
      },
    },
    client,
  );
}
function weiboAccount(
  f: Awaited<ReturnType<typeof fixture>>,
  alias = "微博测试账号",
) {
  const a = f.app.websiteAccounts.add("weibo", alias);
  f.app.db.run(
    "UPDATE website_accounts SET uid=?,status='connected' WHERE id=?",
    `uid-${a.id}`,
    a.id,
  );
  return f.app.websiteAccounts.get(a.id);
}
const exportInput = {
  id: pipixItemId,
  title: "日常生活的新发现",
  channel: "zhihu" as const,
  imageIds: ["image-1"],
  commentIds: [pipixCommentId],
};

test("公共采集与两个渠道解耦，同帖分别交付并按微博账号去重，不覆盖已有编辑", async () => {
  const f = await fixture(),
    service = sourcesFor(f);
  try {
    const a = weiboAccount(f),
      b = weiboAccount(f, "第二微博账号");
    const source = await service.collect(
      `https://h5.pipix.com/ppx/item/${pipixItemId}`,
    );
    assert.equal(source.exports.length, 0);
    assert.equal(f.app.zhihu.snapshot().contents.length, 0);
    const results = await Promise.all([
      service.export(exportInput),
      service.export(exportInput),
    ]);
    assert.equal(results.filter((v) => !v.existing).length, 1);
    const zhihu = f.app.zhihu.store.get(
      "zhihu_contents",
      results[0].delivery.targetId,
    );
    assert.equal(zhihu.reviewed, false);
    assert.equal(zhihu.images[0].storage, "content-assets");
    assert.equal(zhihu.source!.itemId, pipixItemId);
    const wb = await service.export({
      ...exportInput,
      channel: "weibo",
      accountId: a.id,
    });
    const post = f.app.weiboPosts.get(wb.delivery.targetId);
    assert.equal(post.stage, "editing");
    assert.equal(post.visibility, "self");
    assert.equal(post.images[0].asset!.file, zhihu.images[0].file);
    assert.equal(post.source!.comments.length, 1);
    f.app.weiboPosts.save({ ...post, text: "本人保留的编辑内容" });
    assert.equal(
      (
        await service.export({
          ...exportInput,
          channel: "weibo",
          accountId: a.id,
        })
      ).existing,
      true,
    );
    assert.equal(f.app.weiboPosts.get(post.id).text, "本人保留的编辑内容");
    await service.export({ ...exportInput, channel: "weibo", accountId: b.id });
    assert.equal(service.list()[0].exports.length, 3);
    await service.collect(source.url);
    assert.equal(service.list().length, 1);
    assert.equal(service.list()[0].exports.length, 3);
    assert.equal(f.app.zhihu.snapshot().tasks.length, 0);
    assert.match(
      await service.image(source.id, "image-1"),
      /^data:image\/png;base64,/,
    );
    const edited = f.app.zhihu.saveContent({
      ...zhihu,
      title: "本人的知乎编辑",
    });
    assert.deepEqual(edited.source, zhihu.source);
    assert.equal(
      (await service.export(exportInput)).delivery.targetId,
      zhihu.id,
    );
  } finally {
    service.close();
    await f.cleanup();
  }
});

test("失败交付不创建半成品，不把知乎字数与微博账号要求强加给采集", async () => {
  const f = await fixture(),
    service = sourcesFor(f, makeClient(pipixHtml(), true));
  try {
    const source = await service.collect(
      `https://h5.pipix.com/ppx/item/${pipixItemId}`,
    );
    assert.match(source.images[0].error!, /403/);
    await assert.rejects(service.export(exportInput), /尚未采集/);
    assert.equal(f.app.zhihu.snapshot().contents.length, 0);
    await assert.rejects(
      service.export({ ...exportInput, imageIds: [], channel: "weibo" }),
      /Invalid|账号|格式/,
    );
    assert.equal(service.list()[0].exports.length, 0);
    const result = await service.export({ ...exportInput, imageIds: [] });
    assert.equal(
      f.app.zhihu.store.get("zhihu_contents", result.delivery.targetId).images
        .length,
      0,
    );
    const a = weiboAccount(f);
    const material: SourceMaterial = {
      title: "长文",
      body: "长".repeat(2100),
      images: [],
      source: {
        provider: "pipix",
        itemId: pipixItemId,
        url: source.url,
        author: "测试",
        collectedAt: source.collectedAt,
        comments: [],
      },
    };
    assert.throws(() => f.app.weiboPosts.saveSource(material, a.id), /2000/);
    assert.equal(f.app.weiboPosts.list().length, 0);
    assert.equal(f.app.zhihu.saveSource(material).body.length, 2100);
  } finally {
    service.close();
    await f.cleanup();
  }
});

test("重新采集下载期间的交付独立持久化，关闭会取消未完成的读取", async () => {
  const f = await fixture();
  let hold = false,
    release: (() => void) | undefined,
    entered: (() => void) | undefined;
  const client = new PipixClient((async (url: string, init: RequestInit) => {
    if (String(url).includes("byteimg.com")) {
      if (hold)
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          entered?.();
          init.signal?.addEventListener(
            "abort",
            () => reject(Error("aborted")),
            { once: true },
          );
        });
      return new Response(pipixImage);
    }
    return new Response(pipixHtml());
  }) as typeof fetch);
  const service = sourcesFor(f, client);
  try {
    const source = await service.collect(
      `https://h5.pipix.com/ppx/item/${pipixItemId}`,
    );
    hold = true;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const refresh = service.collect(source.url);
    await started;
    const result = await service.export({ ...exportInput, imageIds: [] });
    release!();
    assert.equal((await refresh).exports[0].targetId, result.delivery.targetId);
    assert.equal((await service.export(exportInput)).existing, true);
    const next = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const interrupted = service.collect(source.url);
    await next;
    service.close();
    await assert.rejects(interrupted, /aborted/);
    assert.equal(service.isBusy, false);
    assert.equal(service.list()[0].exports.length, 1);
  } finally {
    release?.();
    service.close();
    await f.cleanup();
  }
});

test("公共图片随双渠道草稿备份与恢复，损坏或缺失图片阻止交付", async () => {
  const f = await fixture(),
    service = sourcesFor(f);
  let restored: Database | undefined;
  try {
    const a = weiboAccount(f);
    const source = await service.collect(
      `https://h5.pipix.com/ppx/item/${pipixItemId}`,
    );
    await service.export(exportInput);
    const wb = await service.export({
      ...exportInput,
      channel: "weibo",
      accountId: a.id,
    });
    const gif = Buffer.from(
      "47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b",
      "hex",
    );
    f.ports.readWeiboImages = async () => [
      { name: "替换配图.gif", bytes: gif },
    ];
    await f.app.weiboPosts.images(wb.delivery.targetId);
    f.app.db.setSetting(`weiboPosts:v1:${wb.delivery.targetId}`, {
      ...f.app.weiboPosts.get(wb.delivery.targetId),
      stage: "submitting",
    });
    f.ports.chooseDirectory = async () => f.dir;
    const backup = (await f.app.backup())!;
    const preview = await inspectBackup(backup);
    assert.equal(preview.contentAssets.length, 2);
    assert.equal(preview.zhihuAssets.length, 0);
    const staged = await stageRestore(backup, f.dir, preview.databaseSha256);
    restored = new Database(join(staged.dataPath, "panxu.db"));
    assert.equal(
      restored.all("SELECT id FROM content_source_exports").length,
      2,
    );
    const post = restored.setting<any>(
      `weiboPosts:v1:${wb.delivery.targetId}`,
      null,
    );
    assert.deepEqual(
      await readContentImage(staged.dataPath, post.images[0].asset),
      gif,
    );
    assert.equal(post.stage, "uncertain");
    assert.equal(post.environment, undefined);
    assert.equal(
      JSON.parse(
        restored.all<{ data: string }>("SELECT data FROM zhihu_contents")[0]
          .data,
      ).reviewed,
      false,
    );
    await writeFile(
      join(f.dir, "content-assets", source.images[0].asset!.file),
      "corrupted",
    );
    const second = weiboAccount(f, "图片损坏测试");
    await assert.rejects(
      service.export({
        ...exportInput,
        channel: "weibo",
        accountId: second.id,
      }),
      /已变化/,
    );
    assert.equal(f.app.weiboPosts.list(second.id).length, 0);
    await rm(join(backup, "content-assets", source.images[0].asset!.file));
    await assert.rejects(inspectBackup(backup), /缺少公共/);
  } finally {
    restored?.close();
    service.close();
    await f.cleanup();
  }
});

test("v20采集数据迁移保留原知乎素材关联、旧配图及已有文本", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panxu-source-migration-")),
    path = join(dir, "panxu.db");
  let db: Database | undefined;
  try {
    db = new Database(path);
    const source = parsePipixPage(pipixHtml());
    const asset = await saveContentImage(
      dir,
      pipixImage,
      "旧配图.png",
      "zhihu-assets",
    );
    delete asset.storage;
    source.images[0].asset = asset;
    const old = { ...source, contentId: "zhcontent_legacy" };
    db.run(
      "INSERT INTO pipix_sources VALUES(?,?)",
      source.id,
      JSON.stringify(old),
    );
    db.run(
      "INSERT INTO zhihu_contents VALUES(?,?)",
      "zhcontent_legacy",
      JSON.stringify({
        id: "zhcontent_legacy",
        title: "此前已编辑的素材",
        reviewed: true,
        images: [asset],
      }),
    );
    db.db.exec(
      removeV22 + "DROP TABLE content_source_exports; PRAGMA user_version=20;",
    );
    db.close();
    db = new Database(path);
    const next = JSON.parse(
      db.get<{ data: string }>("SELECT data FROM pipix_sources")!.data,
    );
    assert.equal(next.contentId, undefined);
    assert.equal(next.images[0].asset.storage, "zhihu-assets");
    assert.deepEqual(
      await readContentImage(dir, next.images[0].asset),
      pipixImage,
    );
    const exported = JSON.parse(
      db.get<{ data: string }>("SELECT data FROM content_source_exports")!.data,
    );
    assert.equal(exported.channel, "zhihu");
    assert.equal(exported.targetId, "zhcontent_legacy");
    assert.equal(exported.title, "此前已编辑的素材");
    assert.equal(
      JSON.parse(
        db.get<{ data: string }>("SELECT data FROM zhihu_contents")!.data,
      ).reviewed,
      true,
    );
    assert.equal(
      (await readdir(dir)).some((v) => v.includes("before-v21")),
      true,
    );
  } finally {
    db?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("公共配图可复用微博现有填写端口，读取同一图片文件且不调用生成或提交", async () => {
  const f = await weiboFixture(),
    service = sourcesFor(f);
  let prepares = 0,
    submits = 0;
  try {
    await service.collect(`https://h5.pipix.com/ppx/item/${pipixItemId}`);
    const result = await service.export({
      ...exportInput,
      channel: "weibo",
      accountId: f.websiteAccount.id,
    });
    f.ports.weiboPublisher = {
      prepare: async (_a, payload) => {
        prepares++;
        assert.match(payload.images[0].path, /content-assets/);
        assert.deepEqual(await readFile(payload.images[0].path), pipixImage);
        return {
          uid: payload.uid,
          imageCount: payload.images.length,
          visibility: payload.visibility,
        };
      },
      submit: async () => {
        submits++;
        throw Error("不应提交");
      },
    };
    const filled = await f.invoke("weiboPosts.fill", {
      id: result.delivery.targetId,
      confirmed: true,
    });
    assert.equal(filled.stage, "filled");
    assert.equal(prepares, 1);
    assert.equal(submits, 0);
    assert.equal(f.generated.length, 0);
  } finally {
    service.close();
    await f.cleanup();
  }
});

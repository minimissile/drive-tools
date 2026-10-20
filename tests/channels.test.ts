import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture, removeV10 } from "./helpers";
import { Database } from "../core/database";
import { AiService } from "../core/ai";
import { platformSpecs } from "../shared/platforms";
import {
  channelProfiles,
  defaultContentFormat,
  platformIds,
} from "../shared/channels";
import { platformSchema } from "../shared/schemas";
import { validateEditorUrl, validatePublicationUrl } from "../core/links";
import type { BrowserBinding, Draft } from "../shared/types";

async function ready() {
  const f = await fixture();
  const saved = await f.add();
  await f.app.queue.execute(saved.jobId);
  return { ...f, saved };
}
async function reviewed(
  f: Awaited<ReturnType<typeof ready>>,
  platform: string,
  contentFormat?: string,
) {
  const draft = (await f.app.invoke("draft.manual", {
    copyId: f.saved.copyId,
    platform,
    contentFormat,
    template: true,
  })) as Draft;
  await f.app.invoke("draft.review", { id: draft.id, reviewed: true });
  return draft;
}

test("21 channels share schema, official-host guards and complete offline handoff for every supported format", async () => {
  const f = await ready();
  try {
    assert.equal(platformIds.length, 21);
    assert.deepEqual(
      platformSpecs.map((p) => p.id),
      [...platformIds],
    );
    f.app.bit.open = async (b) => ({ opened: true, url: b.editorUrl });
    f.ports.chooseDirectory = async () => f.dir;
    for (const spec of platformSpecs) {
      assert.equal(platformSchema.parse(spec.id), spec.id);
      assert.equal(
        validateEditorUrl(spec.id, spec.defaultUrl),
        spec.defaultUrl,
      );
      assert.throws(() =>
        validateEditorUrl(
          spec.id,
          `https://${spec.hosts[0]}.evil.example/write`,
        ),
      );
      const binding = (await f.app.invoke("binding.save", {
        platform: spec.id,
        alias: spec.name,
        windowId: "mock-window",
        editorUrl: spec.defaultUrl,
        linkPermission: "none",
        ruleNote: "",
        capabilities: {
          formats: [...channelProfiles[spec.id].formats],
          linkPositions: [],
        },
      })) as BrowserBinding;
      for (const format of channelProfiles[spec.id].formats) {
        const draft = await reviewed(f, spec.id, format);
        assert.equal(draft.contentFormat, format);
        const result = (await f.app.invoke("publication.export", {
          draftId: draft.id,
          bindingId: binding.id,
          includeLink: false,
        })) as { folder: string };
        const fields = JSON.parse(
          await readFile(join(result.folder, "发布字段.json"), "utf8"),
        );
        assert.equal(fields.contentFormat, format);
        assert.equal(fields.platform, spec.id);
        assert.equal(fields.delivery, null);
        assert.equal(fields.published, false);
        assert.equal(fields.deliveryMounted, false);
        assert.ok(
          (await readFile(join(result.folder, "文章.md"), "utf8")).startsWith(
            "# ",
          ),
        );
        assert.doesNotMatch(
          await readFile(join(result.folder, "发布文案.txt"), "utf8"),
          /source123|own123/,
        );
        await f.app.invoke("publication.open", {
          draftId: draft.id,
          bindingId: binding.id,
        });
      }
    }
    assert.ok(f.app.snapshot().publications.length > 21);
    assert.ok(
      f.app.snapshot().publications.every((p) => p.status === "opened"),
    );
    assert.equal(f.app.repo.calls().length, 0);
    assert.equal(f.provider.shares, 1);
  } finally {
    await f.cleanup();
  }
});

test("link permission is scoped to the account, format and position; nonbody fields never enter public prose", async () => {
  const f = await ready();
  try {
    const article = await reviewed(f, "wechat");
    const binding = (await f.app.invoke("binding.save", {
      platform: "wechat",
      alias: "阅读原文获准账号",
      windowId: "mock",
      editorUrl: "https://mp.weixin.qq.com/",
      linkPermission: "allowed",
      ruleNote: "模拟核对此账号阅读原文能力及平台规则，允许本文配套资料。",
      capabilities: { formats: ["article"], linkPositions: ["original"] },
    })) as BrowserBinding;
    await assert.rejects(f.app.contentPackage(article.id, binding.id, true), {
      code: "CHANNEL_LINK_BLOCKED",
    });
    const pack = await f.app.contentPackage(
      article.id,
      binding.id,
      true,
      "original",
    );
    assert.equal(pack.delivery?.url, f.provider.ownUrl);
    assert.equal(pack.delivery?.code, "test");
    assert.equal(pack.delivery?.position, "original");
    assert.equal(pack.includesOwnLink, false);
    assert.doesNotMatch(pack.text, /own123/);
    const injected = (await f.app.invoke("draft.save", {
      id: article.id,
      title: "标题",
      body: f.provider.ownUrl,
      tags: [],
      coverText: "",
    })) as Draft;
    await f.app.invoke("draft.review", { id: injected.id, reviewed: true });
    await assert.rejects(
      f.app.contentPackage(injected.id, binding.id, true, "original"),
      { code: "CHANNEL_LINK_BLOCKED" },
    );
    f.app.db.run(
      "UPDATE browser_bindings SET verified_at='2000-01-01' WHERE id=?",
      binding.id,
    );
    await assert.rejects(
      f.app.contentPackage(article.id, binding.id, true, "original"),
      { code: "CHANNEL_LINK_BLOCKED" },
    );
    const bili = await reviewed(f, "bilibili", "video-script");
    const biliBinding = (await f.app.invoke("binding.save", {
      platform: "bilibili",
      alias: "只验证图文",
      windowId: "mock",
      editorUrl: "https://member.bilibili.com/",
      linkPermission: "none",
      ruleNote: "",
      capabilities: { formats: ["note"], linkPositions: [] },
    })) as BrowserBinding;
    await assert.rejects(f.app.contentPackage(bili.id, biliBinding.id, false), {
      code: "CHANNEL_FORMAT_UNVERIFIED",
    });
    await assert.rejects(
      f.app.contentPackage(article.id, biliBinding.id, false),
      { code: "BINDING_MISMATCH" },
    );
    f.provider.ownValid = false;
    await assert.rejects(f.app.contentPackage(article.id, null, false), {
      code: "SHARE_INVALID",
    });
  } finally {
    await f.cleanup();
  }
});

test("blocked prose cannot be enabled by a general allow flag; official components need explicit scoped evidence", async () => {
  const f = await ready();
  try {
    const input = {
      platform: "xiaohongshu",
      alias: "获准组件测试",
      windowId: "mock",
      editorUrl: "https://creator.xiaohongshu.com/",
      linkPermission: "allowed",
      ruleNote: "模拟核对本账号、本文资料及可用官方组件的具体使用场景。",
    };
    await assert.rejects(f.app.invoke("binding.save", input), {
      code: "CHANNEL_CAPABILITY_INVALID",
    });
    await assert.rejects(
      f.app.invoke("binding.save", {
        ...input,
        capabilities: { formats: ["article"], linkPositions: ["component"] },
      }),
      { code: "CHANNEL_CAPABILITY_INVALID" },
    );
    const binding = (await f.app.invoke("binding.save", {
      ...input,
      capabilities: { formats: ["note"], linkPositions: ["component"] },
    })) as BrowserBinding;
    const draft = await reviewed(f, "xiaohongshu", "note");
    const pack = await f.app.contentPackage(
      draft.id,
      binding.id,
      true,
      "component",
    );
    assert.equal(pack.delivery?.position, "component");
    assert.doesNotMatch(pack.body, /own123/);
    await assert.rejects(
      f.app.contentPackage(draft.id, binding.id, true, "body"),
      { code: "CHANNEL_LINK_BLOCKED" },
    );
    await assert.rejects(
      f.app.invoke("binding.save", {
        ...input,
        platform: "toutiao",
        editorUrl: "https://mp.toutiao.com/",
        capabilities: { formats: ["article"], linkPositions: ["component"] },
      }),
      { code: "CHANNEL_CAPABILITY_INVALID" },
    );
  } finally {
    await f.cleanup();
  }
});

test("content format survives version edits and unsupported combinations fail before AI calls", async () => {
  const f = await ready();
  try {
    for (const method of ["studio.create", "draft.manual", "draft.generate"]) {
      await assert.rejects(
        f.app.invoke(method, {
          copyId: f.saved.copyId,
          platform: "juejin",
          contentFormat: "note",
          poolId: null,
          mode: "ai",
        }),
        { code: "CHANNEL_FORMAT_UNSUPPORTED" },
      );
    }
    const draft = await reviewed(f, "douyin", "longform");
    const edited = (await f.app.invoke("draft.save", {
      id: draft.id,
      title: "长文新版本",
      body: "完整说明",
      tags: [],
      coverText: "",
    })) as Draft;
    assert.equal(edited.contentFormat, "longform");
    assert.equal(edited.reviewed, false);
    assert.equal(f.app.repo.draft(draft.id).contentFormat, "longform");
    assert.equal(f.app.repo.calls().length, 0);
  } finally {
    await f.cleanup();
  }
});

test("AI creative instructions contain trusted platform format, SEO/GEO evidence requirements and no source URL", async () => {
  const f = await ready();
  try {
    await f.app.secrets.set("openrouter", "fake-channel-test-key");
    f.app.db.setSetting("model", "mock/text");
    const prompts: string[] = [];
    const ai = new AiService(
      f.app.repo,
      f.app.secrets,
      () => {},
      async (_url, init) => {
        const payload = JSON.parse(String(init?.body));
        prompts.push(payload.messages[0].content);
        assert.doesNotMatch(
          JSON.stringify(payload.messages),
          /source123|own123|fake-channel-test-key/,
        );
        return {
          usage: { cost: 0 },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title: "实操说明",
                  body: "已提供的信息和需要补充的操作证据。",
                  tags: [],
                  coverText: "",
                  cards: [],
                  videoPrompt: "",
                  voiceover: "",
                }),
              },
            },
          ],
        };
      },
    );
    f.app.ai.creativeDraft = ai.creativeDraft.bind(ai);
    const draft = (await f.app.invoke("studio.create", {
      copyId: f.saved.copyId,
      platform: "aliyun",
      contentFormat: "article",
      format: "text",
      mode: "ai",
    })) as Draft;
    assert.equal(draft.contentFormat, "article");
    assert.match(prompts[0], /SEO与GEO/);
    assert.match(prompts[0], /可复现步骤/);
    assert.match(prompts[0], /机器人刷稿/);
    assert.match(prompts[0], /不承诺排名/);
    assert.match(prompts[0], /私信领取/);
  } finally {
    await f.cleanup();
  }
});

test("new publication hosts reject wrong platforms, spoofed subdomains, credentials and insecure URLs", () => {
  const urls = {
    bilibili: "https://www.bilibili.com/opus/123",
    toutiao: "https://www.toutiao.com/article/123/",
    baijiahao: "https://baijiahao.baidu.com/s?id=123",
    juejin: "https://juejin.cn/post/123",
    "51cto": "https://blog.51cto.com/u_123/123",
    cnblogs: "https://www.cnblogs.com/author/p/123.html",
    segmentfault: "https://segmentfault.com/a/123",
    oschina: "https://my.oschina.net/author/blog/123",
    tencent: "https://cloud.tencent.com/developer/article/123",
    aliyun: "https://developer.aliyun.com/article/123",
    jianshu: "https://www.jianshu.com/p/123",
  } as const;
  for (const [platform, url] of Object.entries(urls)) {
    const p = platform as keyof typeof urls;
    assert.equal(validatePublicationUrl(p, url), url);
    assert.throws(() =>
      validatePublicationUrl(p, "https://evil.example/post/123"),
    );
    assert.throws(() =>
      validatePublicationUrl(p, url.replace("https:", "http:")),
    );
    const u = new URL(url);
    assert.throws(() =>
      validatePublicationUrl(
        p,
        `https://${u.hostname}.evil.example${u.pathname}`,
      ),
    );
    assert.throws(() =>
      validatePublicationUrl(p, `https://user@${u.hostname}${u.pathname}`),
    );
  }
});

test("v9 upgrade preserves drafts and narrows legacy link permission to the old default form and body", async () => {
  const f = await ready();
  const draft = await reviewed(f, "wechat");
  const binding = (await f.app.invoke("binding.save", {
    platform: "wechat",
    alias: "旧账号",
    windowId: "mock",
    editorUrl: "https://mp.weixin.qq.com/",
    linkPermission: "allowed",
    ruleNote: "旧版已核实正文配套资料使用场景。",
  })) as BrowserBinding;
  const path = f.app.db.path;
  f.app.close();
  try {
    const raw = new DatabaseSync(path);
    raw.exec(removeV10 + "PRAGMA user_version=9;");
    raw.close();
    const db = new Database(path);
    try {
      assert.equal(
        db.get<{ user_version: number }>("PRAGMA user_version")!.user_version,
        14,
      );
      assert.equal(
        db.get<{ content_format: string }>(
          "SELECT content_format FROM drafts WHERE id=?",
          draft.id,
        )!.content_format,
        defaultContentFormat("wechat"),
      );
      const stored = db.get<{ capabilities: string }>(
        "SELECT capabilities FROM browser_bindings WHERE id=?",
        binding.id,
      )!;
      assert.deepEqual(JSON.parse(stored.capabilities), {
        formats: ["article"],
        linkPositions: ["body"],
      });
      assert.equal(
        db.get<{ title: string }>(
          "SELECT title FROM drafts WHERE id=?",
          draft.id,
        )!.title,
        draft.title,
      );
    } finally {
      db.close();
    }
    assert.equal(
      (await readdir(f.dir)).filter((n) => n.includes("before-v10-")).length,
      1,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

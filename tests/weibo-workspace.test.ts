import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { weiboFixture } from "./weibo-fixture";
import { WeiboWorkspace } from "../core/weibo/workspace";
import { weiboResourceStyle } from "../shared/weibo-workspace";

test("本地词库来源随选题保留，关联资料交付继续使用原来源记录", async () => {
  const f = await weiboFixture();
  try {
    await f.invoke("pool.manual", {
      name: "本地选题",
      resourceId: f.saved.resourceId,
      words: "Python 基础练习清单",
    });
    const word = (
      await f.invoke("weibo.words", { query: "Python 基础练习清单" })
    )[0];
    const idea = await f.invoke("weiboWorkspace.save", {
      title: word.word,
      sourceId: word.id,
      accountId: f.websiteAccount.id,
      copyId: f.saved.copyId,
      evidence: "本人制作的基础练习与学习清单，已核对内容与适合人群。",
    });
    const target = await f.invoke("weiboWorkspace.deliver", { id: idea.id });
    assert.equal(target.kind, "marketing");
    assert.equal(f.app.weibo.get(target.id).run.source.id, word.id);
    assert.equal(f.app.weibo.get(target.id).run.source.source, word.source);
    assert.equal(f.generated.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("微博选题不要求资料或登录；刷新重建保留计划，读取不调用模型或官方页面", async () => {
  const f = await weiboFixture();
  try {
    const offline = await f.invoke("websiteAccounts.add", {
      provider: "weibo",
      alias: "待登录的资料号",
    });
    const idea = await f.invoke("weiboWorkspace.save", {
      title: "资料整理技巧",
      kind: "tutorial",
      plannedAt: "2026-11-09T06:00:00.000Z",
    });
    const draft = await f.invoke("weiboWorkspace.save", {
      title: "待补充主题",
      accountId: offline.id,
      text: "尚待核对的本地草稿。",
    });
    const restarted = new WeiboWorkspace({
      db: f.app.db,
      accounts: f.app.websiteAccounts,
      posts: f.app.weiboPosts,
      marketing: f.app.weibo,
      statistics: f.app.weiboStatistics,
      ai: f.app.ai,
      changed() {},
    });
    assert.equal(restarted.get(idea.id).kind, "tutorial");
    assert.equal(
      restarted.list().find((r) => r.id === idea.id)?.status,
      "planned",
    );
    assert.equal(
      restarted.list().find((r) => r.id === draft.id)?.status,
      "draft",
    );
    assert.equal(f.generated.length, 0);
    assert.equal(f.opened.length, 0);
    await assert.rejects(f.invoke("weiboWorkspace.generate", { id: idea.id }), {
      code: "WEIBO_ACCOUNT_REQUIRED",
    });
    await assert.rejects(f.invoke("weiboWorkspace.deliver", { id: draft.id }), {
      code: "WEBSITE_LOGIN_REQUIRED",
    });
  } finally {
    await f.cleanup();
  }
});

test("账号文风独立保存；显式AI生成使用事实与文风，保留AI标识且不上传", async () => {
  const f = await weiboFixture();
  try {
    const other = await f.invoke("websiteAccounts.add", { provider: "weibo" });
    const instructions =
      "保持资源目录式分享，方括号名称与规格在最前，只写简短客观介绍，不加营销口号。";
    await f.invoke("weiboWorkspace.saveStyle", {
      accountId: f.websiteAccount.id,
      instructions,
      linkFirst: true,
    });
    assert.equal(
      (await f.invoke("weiboWorkspace.style", { accountId: other.id }))
        .instructions,
      weiboResourceStyle,
    );
    const idea = await f.invoke("weiboWorkspace.save", {
      title: "[本人练习资料]",
      accountId: f.websiteAccount.id,
      evidence: "本人制作的基础练习和配套清单，适合初学者逐项完成。",
    });
    let request = "";
    Object.assign(f.app.ai, {
      requestJson: async (_url: string, init: RequestInit) => {
        request = String(init.body);
        return {
          usage: { cost: 0.001 },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  text: "[本人练习资料]\n\n包含基础练习和配套清单，适合初学者逐项完成。",
                }),
              },
            },
          ],
        };
      },
    });
    const generated = await f.invoke("weiboWorkspace.generate", {
      id: idea.id,
    });
    assert.equal(generated.aiAssisted, true);
    assert.ok(request.includes(instructions));
    assert.ok(request.includes(idea.evidence));
    assert.match(request, /不编造年份/);
    const target = await f.invoke("weiboWorkspace.deliver", { id: idea.id });
    assert.equal(target.kind, "post");
    const post = f.app.weiboPosts.get(target.id);
    assert.equal(post.aiAssisted, true);
    assert.equal(post.visibility, "self");
    assert.deepEqual(
      await f.invoke("weiboWorkspace.deliver", { id: idea.id }),
      target,
    );
    assert.equal(f.app.weiboPosts.list().length, 1);
    assert.equal(f.opened.length, 0);
    assert.equal(post.stage, "editing");
  } finally {
    await f.cleanup();
  }
});

test("生成期间阻止改写并发；迟到的模型输出不覆盖已变化的草稿", async () => {
  const f = await weiboFixture();
  try {
    const idea = await f.invoke("weiboWorkspace.save", {
      title: "资料介绍",
      accountId: f.websiteAccount.id,
      evidence: "已核对资料清单与用途，适合入门练习使用。",
    });
    let release!: (value: { text: string }) => void, entered!: () => void;
    const gate = new Promise<{ text: string }>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    Object.assign(f.app.ai, {
      resourceExport: async () => {
        entered();
        return gate;
      },
    });
    const pending = f.invoke("weiboWorkspace.generate", { id: idea.id });
    await started;
    await assert.rejects(
      f.invoke("weiboWorkspace.save", { ...idea, text: "覆盖" }),
      { code: "WEIBO_BUSY" },
    );
    f.app.db.setSetting(`weiboWorkspace:v1:${idea.id}`, {
      ...idea,
      text: "外部更新的稿件",
    });
    release({ text: "迟到的模型输出" });
    await assert.rejects(pending, { code: "WEIBO_DRAFT_CHANGED" });
    assert.equal(f.app.weiboWorkspace.get(idea.id).text, "外部更新的稿件");
    assert.equal(f.app.weiboWorkspace.isBusy, false);
  } finally {
    await f.cleanup();
  }
});

test("同资源多账号与同账号版本使用独立稿件，不覆盖原文、审阅或计划", async () => {
  const f = await weiboFixture();
  try {
    const second = await f.invoke("websiteAccounts.add", {
      provider: "weibo",
      alias: "第二资料号",
    });
    f.setSession({ uid: "2234567890", nickname: "第二资料号" });
    await f.invoke("websiteAccounts.check", { id: second.id });
    const idea = await f.invoke("weiboWorkspace.save", {
      title: "[Python 基础练习]",
      accountId: f.websiteAccount.id,
      copyId: f.saved.copyId,
      text: "[Python 基础练习]\n\n本人制作的练习与学习清单。",
      evidence: "本人制作的基础练习与学习清单，资料用途已经核对。",
      plannedAt: "2026-11-09T06:00:00.000Z",
    });
    const target = await f.invoke("weiboWorkspace.deliver", { id: idea.id });
    assert.equal(target.kind, "marketing");
    const first = f.app.weibo.get(target.id);
    await f.invoke("draft.review", { id: first.draft.id, reviewed: true });
    const variant = await f.invoke("weiboWorkspace.variant", {
      id: target.id,
      kind: "marketing",
      accountId: second.id,
    });
    assert.equal(variant.plannedAt, null);
    const changed = await f.invoke("weiboWorkspace.save", {
      ...variant,
      text: "[Python 基础练习]\n\n第二账号的独立介绍。",
    });
    const target2 = await f.invoke("weiboWorkspace.deliver", {
      id: changed.id,
    });
    const secondDetail = f.app.weibo.get(target2.id);
    assert.notEqual(first.draft.id, secondDetail.draft.id);
    assert.ok(
      !f.app.weibo
        .get(target.id)
        .versions.some((v) => v.id === secondDetail.draft.id),
    );
    await assert.rejects(
      f.invoke("weibo.attachDraft", {
        id: target.id,
        draftId: secondDetail.draft.id,
      }),
      { code: "DRAFT_ACCOUNT_MISMATCH" },
    );
    assert.match(secondDetail.draft.body, /第二账号/);
    assert.equal(secondDetail.draft.reviewed, false);
    assert.equal(f.app.weibo.get(target.id).draft.body, first.draft.body);
    assert.equal(f.app.weibo.get(target.id).draft.reviewed, true);
    const sameAccountVariant = await f.invoke("weiboWorkspace.variant", {
      id: idea.id,
      accountId: f.websiteAccount.id,
    });
    const third = await f.invoke("weiboWorkspace.deliver", {
      id: sameAccountVariant.id,
    });
    assert.notEqual(third.id, target.id);
    assert.notEqual(f.app.weibo.get(third.id).draft.id, first.draft.id);
    assert.deepEqual(
      await f.invoke("weiboWorkspace.deliver", { id: idea.id }),
      target,
    );
    assert.equal(
      f.app.weiboWorkspace.list().filter((r) => r.id === idea.id).length,
      0,
    );
    assert.equal(
      f.app.weiboWorkspace.list().find((r) => r.id === target.id)?.plannedAt,
      idea.plannedAt,
    );
    assert.equal(f.generated.length, 0);
    assert.equal(f.opened.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("资源内容仍需权利与链接核验；托管附件无需目录选择，文风保持标题后链接", async () => {
  const f = await weiboFixture();
  try {
    const unbound = await f.invoke("weiboWorkspace.save", {
      title: "资料介绍",
      accountId: f.websiteAccount.id,
      text: "链接：https://pan.quark.cn/s/unverified",
    });
    await assert.rejects(
      f.invoke("weiboWorkspace.deliver", { id: unbound.id }),
      { code: "WEIBO_RESOURCE_REQUIRED" },
    );
    const reviewed = await f.reviewed();
    f.ports.chooseDirectory = async () => {
      throw Error("托管准备不得弹出目录选择");
    };
    const prepared = await f.invoke("weibo.prepare", {
      id: reviewed.run.id,
      export: false,
    });
    assert.equal(prepared.run.stage, "ready", prepared.run.message);
    assert.ok(
      prepared.run.prepared!.folder.startsWith(join(f.dir, "weibo-packages")),
    );
    const text = prepared.run.prepared!.text;
    assert.ok(text.indexOf("链接：") > text.indexOf(prepared.draft.title));
    assert.ok(text.indexOf("链接：") < text.indexOf(prepared.draft.body));
    assert.equal(
      await readFile(
        join(prepared.run.prepared!.folder, "微博文案.txt"),
        "utf8",
      ),
      text,
    );
    assert.equal(f.app.db.setting("lastContentExportDirectory", null), null);
    await writeFile(
      join(prepared.run.prepared!.folder, "微博文案.txt"),
      "外部篡改",
    );
    const blocked = await f.invoke("weibo.handoff", { id: prepared.run.id });
    assert.equal(blocked.run.stage, "attention");
    assert.match(blocked.run.message, /修改/);
    assert.equal(f.opened.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("内容复盘聚合本地快照，真实0与未提供分开，不隐式抓取官方页面", async () => {
  const f = await weiboFixture();
  try {
    const draft = await f.invoke("weiboPosts.save", {
      accountId: f.websiteAccount.id,
      text: "本人历史内容的本地测试记录。",
      visibility: "self",
    });
    const url = "https://weibo.com/1234567890/Abc123456";
    f.app.db.setSetting(`weiboPosts:v1:${draft.id}`, {
      ...draft,
      url,
      stage: "submitted",
    });
    let reads = 0;
    f.ports.weiboStatistics = {
      read: async () => {
        reads++;
        return {
          uid: "1234567890",
          url,
          metrics: {
            reads: { value: 0, display: "0", approximate: false },
            reposts: { value: 0, display: "0", approximate: false },
            comments: { value: null, display: null, approximate: false },
            likes: { value: 2, display: "2", approximate: false },
            linkClicks: { value: null, display: null, approximate: false },
          },
        };
      },
    };
    assert.equal((await f.invoke("weiboWorkspace.list"))[0].latest, null);
    assert.equal(reads, 0);
    await f.invoke("weiboStats.refresh", {
      accountId: f.websiteAccount.id,
      url,
    });
    const row = (await f.invoke("weiboWorkspace.list"))[0];
    assert.equal(row.latest?.metrics.reads.value, 0);
    assert.equal(row.latest?.metrics.comments.value, null);
    assert.equal(row.latest?.metrics.linkClicks.value, null);
    assert.equal(reads, 1);
    const variant = await f.invoke("weiboWorkspace.variant", {
      id: draft.id,
      kind: "post",
      accountId: f.websiteAccount.id,
    });
    assert.equal(variant.text, draft.text);
    assert.equal(variant.target, undefined);
    assert.equal(f.app.weiboPosts.get(draft.id).url, url);
  } finally {
    await f.cleanup();
  }
});

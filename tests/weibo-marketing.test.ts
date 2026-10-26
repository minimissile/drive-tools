import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { weiboFixture } from "./weibo-fixture";
import { editorValueForDraft } from "../shared/studio";
import { WeiboMarketing } from "../core/weibo/marketing";
import {
  weiboContentIssue,
  weiboPostText,
  weiboReceiptUrl,
} from "../shared/weibo-marketing";
import { readWeiboViewer } from "../desktop/weibo-identity";

test("微博模拟完整链路：本地选题、生成审阅、本人链接和封面导出、交接、回执入账", async () => {
  const f = await weiboFixture();
  try {
    const created = await f.create();
    assert.equal((await f.create()).run.id, created.run.id);
    assert.equal(f.generated.length, 0);
    assert.equal(
      f.app.weibo.matches({ keyword: "Python 入门" })[0].copyId,
      f.saved.copyId,
    );
    const ready = await f.ready();
    assert.equal(f.generated.length, 1);
    assert.equal(
      f.app.repo.calls().filter((call) => call.endpoint === "openrouter")
        .length,
      1,
    );
    assert.equal(ready.draft.reviewed, true);
    const pack = ready.run.prepared!;
    assert.match(pack.text, /https:\/\/pan\.quark\.cn\/s\/own123/);
    assert.doesNotMatch(pack.text, /source123/);
    assert.equal(
      await readFile(join(pack.folder, "微博文案.txt"), "utf8"),
      pack.text,
    );
    assert.equal(pack.images.length, 1);
    const manifest = JSON.parse(
      await readFile(join(pack.folder, "发布清单.json"), "utf8"),
    );
    assert.equal(manifest.published, false);
    assert.equal(manifest.uid, "1234567890");
    assert.equal(manifest.accountId, f.websiteAccount.id);
    assert.equal(f.app.snapshot().publications.length, 0);
    const handed = await f.invoke("weibo.handoff", { id: ready.run.id });
    assert.equal(handed.run.stage, "handoff", handed.run.message);
    assert.deepEqual(f.opened, [
      { accountId: f.websiteAccount.id, uid: "1234567890" },
    ]);
    assert.deepEqual(f.copied, [pack.text]);
    assert.deepEqual(
      f.app.snapshot().publications.map((item) => item.status),
      ["opened"],
    );
    await f.invoke("weibo.handoff", { id: ready.run.id });
    assert.equal(f.app.snapshot().publications.length, 1);
    const url = "https://weibo.com/1234567890/Abc123456";
    for (const result of ["submitted", "published", "published"] as const) {
      const resolved = await f.invoke("weibo.resolve", {
        id: ready.run.id,
        result,
        url,
        confirmed: true,
      });
      assert.equal(resolved.run.stage, result, resolved.run.message);
      assert.equal(
        resolved.run.receiptSyncPending,
        false,
        resolved.run.message,
      );
    }
    assert.equal(
      f.app
        .snapshot()
        .publications.filter((item) => item.status === "published").length,
      1,
    );
    assert.equal(f.app.search.get(ready.run.topicId).publications.length, 1);
    assert.ok(f.app.db.get("SELECT publication_id FROM publication_targets"));
    await assert.rejects(f.invoke("weibo.prepare", { id: ready.run.id }), {
      code: "WEIBO_RECEIPT_REQUIRED",
    });
    await assert.rejects(f.invoke("weibo.handoff", { id: ready.run.id }), {
      code: "WEIBO_PREPARE_REQUIRED",
    });
  } finally {
    await f.cleanup();
  }
});

test("微博未审阅、未保存编辑及过期资料版本均不能交接", async () => {
  const f = await weiboFixture();
  try {
    const created = await f.create();
    const generated = await f.invoke("weibo.generate", {
      id: created.run.id,
      artwork: "cover",
    });
    await f.configure(created.run.id);
    const unreviewed = await f.invoke("weibo.prepare", { id: created.run.id });
    assert.equal(unreviewed.run.stage, "attention");
    assert.match(unreviewed.run.message, /审阅/);
    await f.invoke("draft.review", { id: generated.draft.id, reviewed: true });
    const draft = f.app.repo.draft(generated.draft.id);
    await f.invoke("studio.workingSave", {
      draftId: draft.id,
      editedAt: Date.now(),
      value: { ...editorValueForDraft(draft), body: "未保存的另一版正文" },
    });
    const unsaved = await f.invoke("weibo.prepare", { id: created.run.id });
    assert.match(unsaved.run.message, /未保存|编辑/);
    await f.invoke("studio.workingClear", { draftId: draft.id });
    f.app.db.run(
      "UPDATE copies SET share_version=share_version+1 WHERE id=?",
      f.saved.copyId,
    );
    const stale = await f.invoke("weibo.prepare", { id: created.run.id });
    assert.match(stale.run.message, /更新|审阅/);
    assert.equal(f.opened.length, 0);
    assert.equal(f.copied.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("微博分享失效不生成；账号权限未核实或外链权限过期不导出", async () => {
  const f = await weiboFixture();
  try {
    const created = await f.create();
    f.provider.ownValid = false;
    const invalid = await f.invoke("weibo.generate", {
      id: created.run.id,
      artwork: "cover",
    });
    assert.equal(invalid.run.stage, "attention");
    assert.equal(f.generated.length, 0);
    f.provider.ownValid = true;
    await f.invoke("copies.check", { copyIds: [f.saved.copyId] });
    await f.reviewed();
    f.app.db.run(
      "UPDATE browser_bindings SET capabilities=? WHERE id=?",
      JSON.stringify({ formats: [], linkPositions: [] }),
      f.bindingId,
    );
    const unverified = await f.invoke("weibo.prepare", { id: created.run.id });
    assert.match(unverified.run.message, /形式|能力/);
    await f.invoke("websiteAccounts.weiboPublishing", {
      id: f.websiteAccount.id,
      allowLink: true,
      ruleNote: "模拟重新核实本人资源推荐和正文网盘入口能力。",
      confirmed: true,
    });
    f.app.db.run(
      "UPDATE browser_bindings SET verified_at='2020-01-01T00:00:00.000Z' WHERE id=?",
      f.bindingId,
    );
    const expired = await f.invoke("weibo.prepare", { id: created.run.id });
    assert.match(expired.run.message, /30天|权限|核实/);
    assert.equal(f.opened.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("微博在交接前重新核验身份，换号、过期和重复身份不自动替换任务账号", async () => {
  const f = await weiboFixture();
  try {
    const ready = await f.ready();
    f.setSession({ uid: "9999999999", nickname: "另一账号" });
    const blocked = await f.invoke("weibo.handoff", { id: ready.run.id });
    assert.equal(blocked.run.stage, "attention");
    assert.equal(
      f.app.websiteAccounts.get(f.websiteAccount.id).uid,
      "1234567890",
    );
    assert.equal(f.opened.length, 0);
    assert.equal(f.copied.length, 0);
    f.setSession({ uid: "1234567890", hasSession: true });
    const duplicate = await f.invoke("websiteAccounts.add", {
      provider: "weibo",
    });
    const duplicateStatus = await f.invoke("websiteAccounts.check", {
      id: duplicate.id,
    });
    assert.equal(duplicateStatus.status, "disconnected");
    assert.equal(duplicateStatus.uid, null);
    assert.match(duplicateStatus.message, /已有|其他账号/);
    f.setSession({ hasSession: false, uid: null, expired: true });
    const expired = await f.invoke("weibo.prepare", { id: ready.run.id });
    assert.equal(expired.run.stage, "attention");
    assert.equal(
      f.app.websiteAccounts.get(f.websiteAccount.id).status,
      "expired",
    );
    assert.equal(f.opened.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("微博导出后图片或文案被改动、移动时阻止交接，取消导出保留原稿", async () => {
  const f = await weiboFixture();
  try {
    const ready = await f.ready();
    await writeFile(
      join(ready.run.prepared!.folder, "微博文案.txt"),
      "被外部修改的内容",
    );
    const changed = await f.invoke("weibo.handoff", { id: ready.run.id });
    assert.equal(changed.run.stage, "attention");
    assert.match(changed.run.message, /修改/);
    const reexport = await f.invoke("weibo.prepare", { id: ready.run.id });
    await rm(
      join(reexport.run.prepared!.folder, reexport.run.prepared!.images[0]),
    );
    const missing = await f.invoke("weibo.handoff", { id: ready.run.id });
    assert.match(missing.run.message, /缺失|移动/);
    f.ports.chooseDirectory = async () => null;
    const cancelled = await f.invoke("weibo.prepare", { id: ready.run.id });
    assert.equal(cancelled.run.stage, "review");
    assert.equal(cancelled.run.prepared, null);
    assert.equal(cancelled.draft.id, ready.draft.id);
    assert.equal(f.opened.length, 0);
    assert.equal(f.copied.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("微博打开窗口失败仍保留交接意图，明确确认未发后才允许重新准备", async () => {
  const f = await weiboFixture();
  try {
    const ready = await f.ready();
    f.ports.websiteSessions!.open = async () => {
      throw Error("模拟窗口打开失败");
    };
    const failed = await f.invoke("weibo.handoff", { id: ready.run.id });
    assert.equal(failed.run.stage, "handoff");
    assert.match(failed.run.message, /窗口打开失败/);
    await assert.rejects(f.configure(ready.run.id), {
      code: "WEIBO_RECEIPT_REQUIRED",
    });
    await assert.rejects(
      f.invoke("weibo.resolve", {
        id: ready.run.id,
        result: "not_submitted",
        url: "",
      }),
      /Invalid input/,
    );
    const cleared = await f.invoke("weibo.resolve", {
      id: ready.run.id,
      result: "not_submitted",
      url: "",
      confirmed: true,
    });
    assert.equal(cleared.run.stage, "review");
    assert.equal(cleared.run.prepared, null);
    assert.equal(f.app.snapshot().publications.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("微博回执校验目标作者、阻止回退和换链接，台账失败不丢回执也不要求重发", async () => {
  const f = await weiboFixture();
  try {
    const ready = await f.ready();
    const args = {
      id: ready.run.id,
      result: "published" as const,
      url: "https://weibo.com/1234567890/Abc123456",
      confirmed: true as const,
    };
    await assert.rejects(f.invoke("weibo.resolve", args), {
      code: "WEIBO_HANDOFF_REQUIRED",
    });
    await f.invoke("weibo.handoff", { id: ready.run.id });
    await assert.rejects(
      f.invoke("weibo.resolve", {
        ...args,
        url: "https://weibo.com/9999999999/Abc123456",
      }),
      { code: "WEIBO_RECEIPT_MISMATCH" },
    );
    const mark = f.app.invoke.bind(f.app);
    f.app.invoke = async (method, input) => {
      if (method === "publication.mark") throw Error("模拟发布台账写入失败");
      return mark(method, input);
    };
    const pending = await f.invoke("weibo.resolve", args);
    assert.equal(pending.run.stage, "published");
    assert.equal(pending.run.url, args.url);
    assert.equal(pending.run.receiptSyncPending, true);
    assert.match(pending.run.message, /无需重复发帖/);
    f.app.invoke = mark;
    const synced = await f.invoke("weibo.resolve", args);
    assert.equal(synced.run.receiptSyncPending, false, synced.run.message);
    assert.equal(f.opened.length, 1);
    await assert.rejects(
      f.invoke("weibo.resolve", { ...args, result: "not_submitted", url: "" }),
      { code: "WEIBO_RESULT_EXISTS" },
    );
    await assert.rejects(
      f.invoke("weibo.resolve", { ...args, result: "submitted" }),
      { code: "WEIBO_RESULT_EXISTS" },
    );
    await assert.rejects(
      f.invoke("weibo.resolve", {
        ...args,
        url: "https://weibo.com/1234567890/Xyz987654",
      }),
      { code: "WEIBO_RECEIPT_MISMATCH" },
    );
  } finally {
    await f.cleanup();
  }
});

test("微博导出过程中内容改变会清理半成品，同任务并发操作被拦截", async () => {
  const f = await weiboFixture();
  try {
    const reviewed = await f.reviewed();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.ports.chooseDirectory = async () => {
      entered();
      await gate;
      return f.dir;
    };
    const preparing = f.invoke("weibo.prepare", { id: reviewed.run.id });
    await waiting;
    assert.equal(f.app.weibo.isBusy, true);
    await assert.rejects(f.invoke("weibo.prepare", { id: reviewed.run.id }), {
      code: "WEIBO_BUSY",
    });
    f.app.db.run(
      "UPDATE browser_bindings SET rule_note='模拟导出过程中改变权限',verified_at=? WHERE id=?",
      new Date(Date.now() - 1000).toISOString(),
      f.bindingId,
    );
    release();
    const changed = await preparing;
    assert.equal(changed.run.stage, "attention");
    assert.match(changed.run.message, /变化/);
    assert.equal(
      (await readdir(f.dir)).filter((name) => name.startsWith("盘序微博-"))
        .length,
      0,
    );
    assert.equal(f.app.weibo.isBusy, false);
  } finally {
    await f.cleanup();
  }
});

test("微博重启保留已交接任务，正在准备的任务仅恢复到待处理而不自动发帖", async () => {
  const f = await weiboFixture();
  try {
    const ready = await f.ready();
    await f.invoke("weibo.handoff", { id: ready.run.id });
    const interrupted = await f.create("Python 学习清单");
    interrupted.run.stage = "preparing";
    f.app.db.setSetting(
      `weiboMarketing:v1:${interrupted.run.id}`,
      interrupted.run,
    );
    const restarted = new WeiboMarketing({
      repo: f.app.repo,
      search: f.app.search,
      ai: f.app.ai,
      studio: f.app.studio,
      websiteAccounts: f.app.websiteAccounts,
      dataPath: f.dir,
      ports: f.ports,
      verifyTarget: async () => {
        throw Error("重启不核验远端");
      },
      contentPackage: async () => {
        throw Error("重启不准备");
      },
      record: async () => {
        throw Error("重启不发帖");
      },
      changed: () => {},
    });
    assert.equal(restarted.get(ready.run.id).run.stage, "handoff");
    assert.equal(restarted.get(interrupted.run.id).run.stage, "attention");
    assert.equal(restarted.get(interrupted.run.id).run.prepared, null);
    assert.equal(f.opened.length, 1);
    assert.equal(f.generated.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("微博文案规则按完整文本计数、去重话题，不截断；回执只接受目标作者的官方单条链接", () => {
  const draft = {
    title: "资料推荐",
    body: "基础练习 #Python#",
    tags: ["Python", "编程"],
  };
  const text = weiboPostText(draft);
  assert.equal(text.match(/#Python#/g)?.length, 1);
  assert.equal(weiboContentIssue(draft), null);
  assert.match(
    weiboContentIssue({ ...draft, body: "😀".repeat(2001) })!,
    /2000/,
  );
  assert.match(
    weiboContentIssue({ ...draft, body: "【待补充资料事实】" })!,
    /占位/,
  );
  assert.match(weiboContentIssue({ ...draft, tags: ["不允许 空格"] })!, /话题/);
  assert.equal(
    weiboReceiptUrl(
      "https://www.weibo.com/1234567890/Abc123456/?from=test#comment",
      "1234567890",
    ),
    "https://weibo.com/1234567890/Abc123456",
  );
  for (const url of [
    "http://weibo.com/1234567890/Abc123456",
    "https://weibo.com/1234567890",
    "https://weibo.com/9999999999/Abc123456",
    "https://weibo.com.evil.test/1234567890/Abc123456",
    "https://m.weibo.cn/status/Abc123456",
  ]) {
    assert.throws(() => weiboReceiptUrl(url, "1234567890"));
  }
});

test("微博身份解析只提取当前用户 UID 与昵称，访客及未知结构不误判登录", () => {
  assert.deepEqual(
    readWeiboViewer({
      uid: "1234567890",
      user: { screen_name: "  模拟账号  " },
      token: "不可返回",
    }),
    { kind: "identity", identity: { uid: "1234567890", nickname: "模拟账号" } },
  );
  assert.deepEqual(
    readWeiboViewer({
      data: { user: { idstr: "1234567890", screen_name: "模拟账号" } },
    }),
    { kind: "identity", identity: { uid: "1234567890", nickname: "模拟账号" } },
  );
  for (const payload of [
    { uid: "1234567890", islogin: false },
    { uid: "0" },
    { uid: 0 },
  ])
    assert.equal(readWeiboViewer(payload).kind, "guest");
  for (const payload of [
    null,
    [],
    {},
    { ok: 0, uid: "1234567890" },
    { uid: "bad" },
    { uid: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.equal(readWeiboViewer(payload).kind, "unknown");
});

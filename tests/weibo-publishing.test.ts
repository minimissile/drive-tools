import test from "node:test";
import assert from "node:assert/strict";
import { weiboFixture } from "./weibo-fixture";
import { weiboSubmitReceipt } from "../desktop/weibo-publisher";
import type { WeiboEditorPayload } from "../shared/weibo-publishing";

test("微博原生发布：本地文案和图片经官方发布器上传，回执自动保存且禁止二次提交", async () => {
  const f = await weiboFixture();
  try {
    const filled: WeiboEditorPayload[] = [];
    let clicks = 0;
    f.ports.weiboPublisher = {
      prepare: async (_account, payload) => {
        filled.push(payload);
        return {
          uid: payload.uid,
          imageCount: payload.images.length,
          visibility: payload.visibility,
        };
      },
      submit: async (_account, payload, before) => {
        await before();
        clicks++;
        return {
          status: "submitted",
          url: `https://weibo.com/${payload.uid}/Abc123456`,
          postId: "Abc123456",
        };
      },
    };
    f.ports.readWeiboImages = async () => [
      {
        name: "test.png",
        bytes: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9U8AAAAASUVORK5CYII=",
          "base64",
        ),
      },
    ];
    const saved = await f.invoke("weiboPosts.save", {
      accountId: f.websiteAccount.id,
      text: "本地功能验证，不带外链。",
      visibility: "self",
    });
    await f.invoke("weiboPosts.images", { id: saved.id });
    await assert.rejects(
      f.invoke("weiboPosts.fill", { id: saved.id }),
      /Invalid input/,
    );
    const uploaded = await f.invoke("weiboPosts.fill", {
      id: saved.id,
      confirmed: true,
    });
    assert.equal(uploaded.stage, "filled", uploaded.message);
    assert.equal(filled[0].images.length, 1);
    assert.equal(filled[0].visibility, "self");
    assert.equal(filled[0].aiAssisted, false);
    const result = await f.invoke("weiboPosts.submit", {
      id: saved.id,
      confirmed: true,
    });
    assert.equal(result.stage, "submitted", result.message);
    assert.equal(result.url, "https://weibo.com/1234567890/Abc123456");
    const opened: string[] = [];
    f.ports.websiteSessions!.openPost = async (account, url) => {
      assert.equal(account.id, f.websiteAccount.id);
      opened.push(url);
    };
    await f.invoke("weiboPosts.open", { id: saved.id });
    assert.deepEqual(opened, [result.url]);
    await assert.rejects(
      f.invoke("weiboPosts.submit", { id: saved.id, confirmed: true }),
      { code: "WEIBO_FILL_REQUIRED" },
    );
    assert.equal(clicks, 1);
    assert.equal(f.generated.length, 0);
    await assert.rejects(
      f.invoke("weiboPosts.resolve", {
        id: saved.id,
        url: "",
        confirmed: true,
      }),
      { code: "WEIBO_RESULT_EXISTS" },
    );
  } finally {
    await f.cleanup();
  }
});

test("微博营销复用同一发布器，提交前复核稿件与图片，自动关联公共发布台账", async () => {
  const f = await weiboFixture();
  try {
    let clicks = 0;
    f.ports.weiboPublisher = {
      prepare: async (_account, payload) => ({
        uid: payload.uid,
        imageCount: payload.images.length,
        visibility: payload.visibility,
      }),
      submit: async (_account, payload, before) => {
        await before();
        clicks++;
        return {
          status: "submitted",
          url: `https://weibo.com/${payload.uid}/Abc123456`,
          postId: "Abc123456",
        };
      },
    };
    const ready = await f.ready();
    const uploaded = await f.invoke("weibo.fill", { id: ready.run.id });
    assert.equal(uploaded.run.stage, "filled", uploaded.run.message);
    await assert.rejects(
      f.invoke("weibo.submit", { id: ready.run.id }),
      /Invalid input/,
    );
    const result = await f.invoke("weibo.submit", {
      id: ready.run.id,
      confirmed: true,
    });
    assert.equal(result.run.stage, "submitted", result.run.message);
    assert.equal(result.run.receiptSyncPending, false, result.run.message);
    assert.equal(
      f.app
        .snapshot()
        .publications.filter((post) => post.status === "submitted").length,
      1,
    );
    await assert.rejects(
      f.invoke("weibo.submit", { id: ready.run.id, confirmed: true }),
      { code: "WEIBO_FILL_REQUIRED" },
    );
    assert.equal(clicks, 1);
  } finally {
    await f.cleanup();
  }
});

test("仅自己可见的微博不能被任务误登记为已公开", async () => {
  const f = await weiboFixture();
  try {
    f.ports.weiboPublisher = {
      prepare: async (_account, payload) => ({
        uid: payload.uid,
        imageCount: payload.images.length,
        visibility: payload.visibility,
      }),
      submit: async (_account, payload, before) => {
        await before();
        return {
          status: "submitted",
          url: `https://weibo.com/${payload.uid}/Abc123456`,
          postId: "Abc123456",
        };
      },
    };
    const reviewed = await f.reviewed();
    await f.invoke("weibo.configure", {
      id: reviewed.run.id,
      options: { ...reviewed.run.options!, visibility: "self" },
    });
    await f.invoke("weibo.prepare", { id: reviewed.run.id });
    await f.invoke("weibo.fill", { id: reviewed.run.id });
    const submitted = await f.invoke("weibo.submit", {
      id: reviewed.run.id,
      confirmed: true,
    });
    assert.equal(submitted.run.stage, "submitted", submitted.run.message);
    await assert.rejects(
      f.invoke("weibo.resolve", {
        id: reviewed.run.id,
        result: "published",
        url: submitted.run.url!,
        confirmed: true,
      }),
      { code: "WEIBO_PRIVATE_POST" },
    );
  } finally {
    await f.cleanup();
  }
});

test("微博提交回执丢失进入待核对，无法重试发帖；显式拒绝则保留已填内容", async () => {
  const f = await weiboFixture();
  try {
    f.ports.weiboPublisher = {
      prepare: async (_account, payload) => ({
        uid: payload.uid,
        imageCount: 0,
        visibility: payload.visibility,
      }),
      submit: async (_account, _payload, before) => {
        await before();
        throw Error("模拟回执丢失");
      },
    };
    const saved = await f.invoke("weiboPosts.save", {
      accountId: f.websiteAccount.id,
      text: "测试回执恢复。",
      visibility: "self",
    });
    await f.invoke("weiboPosts.fill", { id: saved.id, confirmed: true });
    const uncertain = await f.invoke("weiboPosts.submit", {
      id: saved.id,
      confirmed: true,
    });
    assert.equal(uncertain.stage, "uncertain");
    await assert.rejects(
      f.invoke("weiboPosts.submit", { id: saved.id, confirmed: true }),
      { code: "WEIBO_FILL_REQUIRED" },
    );
    await assert.rejects(
      f.invoke("weiboPosts.save", {
        id: saved.id,
        accountId: saved.accountId,
        text: "不能改稿重发",
      }),
      { code: "WEIBO_RESULT_EXISTS" },
    );
    const reset = await f.invoke("weiboPosts.resolve", {
      id: saved.id,
      url: "",
      confirmed: true,
    });
    assert.equal(reset.stage, "editing");
    await f.invoke("weiboPosts.fill", { id: saved.id, confirmed: true });
    f.ports.weiboPublisher.submit = async (_a, _p, before) => {
      await before();
      return { status: "rejected", message: "模拟平台明确拒绝" };
    };
    const rejected = await f.invoke("weiboPosts.submit", {
      id: saved.id,
      confirmed: true,
    });
    assert.equal(rejected.stage, "filled");
    assert.match(rejected.message, /明确拒绝/);
  } finally {
    await f.cleanup();
  }
});

test("微博独立发帖仍固定账号身份，网盘链接须走已核验资料流程", async () => {
  const f = await weiboFixture();
  try {
    await assert.rejects(
      f.invoke("weiboPosts.save", {
        accountId: f.websiteAccount.id,
        text: "资料 https://pan.quark.cn/s/unsafe",
      }),
      { code: "WEIBO_RESOURCE_REQUIRED" },
    );
    const saved = await f.invoke("weiboPosts.save", {
      accountId: f.websiteAccount.id,
      text: "测试账号保护",
    });
    f.setSession({ uid: "9999999999" });
    let touched = false;
    f.ports.weiboPublisher = {
      prepare: async () => {
        touched = true;
        throw Error("不应执行");
      },
      submit: async () => {
        throw Error("不应执行");
      },
    };
    const blocked = await f.invoke("weiboPosts.fill", {
      id: saved.id,
      confirmed: true,
    });
    assert.equal(blocked.stage, "attention");
    assert.equal(touched, false);
    assert.equal(
      f.app.websiteAccounts.get(f.websiteAccount.id).uid,
      "1234567890",
    );
  } finally {
    await f.cleanup();
  }
});

test("微博官方回执只接受发布成功的单条 ID，安全验证和成功缺 ID 均保留未知结果", () => {
  assert.equal(
    weiboSubmitReceipt(
      { ok: 1, data: { mblogid: "Abc123456", user: { idstr: "1234567890" } } },
      200,
      "1234567890",
    ).status,
    "submitted",
  );
  assert.equal(
    weiboSubmitReceipt({ ok: 0, msg: "内容不符合要求" }, 200, "1234567890")
      .status,
    "rejected",
  );
  for (const body of [
    { ok: 1, data: { verify: true } },
    { ok: 1, data: {} },
    { ok: 1, data: { mblogid: "Abc123456", user: { idstr: "9999999999" } } },
  ])
    assert.throws(() => weiboSubmitReceipt(body, 200, "1234567890"), {
      code: "WEIBO_RECEIPT_UNKNOWN",
    });
});

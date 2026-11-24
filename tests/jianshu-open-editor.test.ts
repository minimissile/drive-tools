import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { BrowserContext } from "playwright-core";
import type { WebsiteAccount } from "../shared/website-accounts";
import type { JianshuDetail } from "../shared/jianshu";
import { fixture } from "./helpers";
import { jianshuBrowser } from "../core/jianshu/browser";
import { jianshuHandoff } from "../core/jianshu/handoff";

const editorUrl = "https://www.jianshu.com/writer#/notebooks/12/notes/99";
const uid = "03f80ba6b743";
const account: WebsiteAccount = {
  id: "web_jianshu_open",
  provider: "jianshu",
  alias: "简书",
  uid,
  status: "connected",
  createdAt: "2026-11-24",
  updatedAt: "2026-11-24",
};

test("真实查看原稿IPC按简书分流并fresh核验身份，不重新填写或改变已交接文章", async () => {
  let checks = 0,
    fills = 0,
    opens = 0;
  let currentUid: string | null = uid;
  const state = () => ({
    hasSession: !!currentUid,
    uid: currentUid,
    windowOpen: false,
    error: null,
  });
  const f = await fixture(
    {},
    {
      openExternal: async () => {
        throw Error("不得丢失账号环境打开系统浏览器");
      },
      websiteSessions: {
        isOpen: () => false,
        login: async () => {},
        clear: async () => {},
        invalidate: async () => {},
        status: async () => state(),
        verify: async () => {
          checks++;
          return state();
        },
        openDocument: async () => {
          throw Error("不得误走通用文档适配器");
        },
      },
      jianshu: {
        prepare: async () => {
          fills++;
          return {
            opened: true,
            filled: true,
            editorUrl,
            message: "已填写",
            uploadedImages: 0,
            totalImages: 0,
          };
        },
        checkResult: async (_a, url) => ({
          verified: false,
          url,
          reason: "未发布",
        }),
        openEditor: async (a, url) => {
          assert.equal(a.uid, uid);
          assert.equal(url, editorUrl);
          opens++;
          return { opened: true, editorUrl: url };
        },
      },
    },
  );
  try {
    const connected = f.app.websiteAccounts.add("jianshu", "资料分享");
    const initial = (await f.app.invoke("jianshu.create", {
      requestId: randomUUID(),
      accountId: connected.id,
      title: "英语资料使用指南",
      body: "先根据目录选择适合自己的学习内容，再按每日计划练习并记录不熟悉的表达，定期回顾学习笔记。",
      copyId: null,
      sourceIds: [],
      template: "guide",
    })) as JianshuDetail;
    const prepared = (await f.app.invoke("jianshu.prepare", {
      id: initial.article.id,
      revision: initial.article.revision,
    })) as JianshuDetail;
    const checksBefore = checks;
    const result = await f.app.invoke("websiteAccounts.openDocument", {
      id: connected.id,
      url: editorUrl,
    });
    assert.deepEqual(result, { opened: true, url: editorUrl });
    assert.equal(checks, checksBefore + 1, "每次打开都重新核验所选账号身份");
    assert.equal(opens, 1);
    assert.equal(fills, 1, "查看不得再次调用填写");
    const after = (await f.app.invoke("jianshu.get", {
      id: initial.article.id,
    })) as JianshuDetail;
    assert.deepEqual(
      after.article,
      prepared.article,
      "原稿stage/revision/checkpoint均不改动",
    );
    for (const bad of [
      "https://www.jianshu.com/writer#/notebooks/12",
      "https://www.jianshu.com/p/abc",
      "https://www.jianshu.com.evil.test/writer#/notebooks/12/notes/99",
      "https://user:pass@www.jianshu.com/writer#/notebooks/12/notes/99",
    ]) {
      await assert.rejects(
        f.app.invoke("websiteAccounts.openDocument", {
          id: connected.id,
          url: bad,
        }),
        /官方平台/,
      );
    }
    assert.equal(opens, 1);
    currentUid = "differentuid";
    await assert.rejects(
      f.app.invoke("websiteAccounts.openDocument", {
        id: connected.id,
        url: editorUrl,
      }),
      /身份|登录/,
    );
    assert.equal(opens, 1, "身份变化不得打开其他账号的原稿");
  } finally {
    await f.cleanup();
  }
});

test("指纹查看准确原稿直接复用既有页面，保留用户内容和其他稿件，不发填写脚本", async () => {
  let shown = 0,
    contexts = 0;
  const unexpected = async () => {
    throw Error("只读查看不得加载、关闭或执行编辑器脚本");
  };
  const exact = {
    url: () => editorUrl,
    isClosed: () => false,
    bringToFront: async () => {
      shown++;
    },
    goto: unexpected,
    evaluate: unexpected,
    close: unexpected,
  };
  const other = {
    ...exact,
    url: () => editorUrl.replace("99", "100"),
    bringToFront: unexpected,
  };
  const context = {
    pages: () => [other, exact],
    newPage: unexpected,
  } as unknown as BrowserContext;
  const port = jianshuBrowser(async (_a, run, visible) => {
    contexts++;
    assert.equal(visible, true);
    return run(context);
  });
  assert.deepEqual(await port.openEditor!(account, editorUrl), {
    opened: true,
    editorUrl,
  });
  assert.deepEqual(await port.openEditor!(account, editorUrl), {
    opened: true,
    editorUrl,
  });
  assert.equal(shown, 2);
  assert.equal(contexts, 2);
  await assert.rejects(
    port.openEditor!({ ...account, uid: null }, editorUrl),
    /核实/,
  );
  await assert.rejects(
    port.openEditor!(account, "https://www.jianshu.com/writer#/"),
    /准确/,
  );
  assert.equal(contexts, 2, "不合法输入不启动账号环境");
});

test("简书交接wrapper透传只读原稿打开，不覆盖剪贴板或触发填写", async () => {
  const unexpected = async (): Promise<never> => {
    throw Error("查看原稿不得复制或填写");
  };
  const port = jianshuHandoff(
    {
      openEditor: async (_a, url) => ({ opened: true, editorUrl: url }),
      prepare: unexpected,
      checkResult: unexpected,
    },
    { copyText: unexpected, copyRichText: unexpected },
  );
  assert.deepEqual(await port!.openEditor!(account, editorUrl), {
    opened: true,
    editorUrl,
  });
});

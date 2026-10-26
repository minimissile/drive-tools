import assert from "node:assert/strict";
import { fixture } from "./helpers";
import type { IpcMethod, IpcValue } from "../shared/ipc";
import type { WebsiteSessionState } from "../shared/website-accounts";

/** All files and records are temporary; no official website or paid API is called. */
export async function weiboFixture() {
  const f = await fixture();
  const invoke = <M extends IpcMethod>(method: M, args?: unknown) =>
    f.app.invoke(method, args) as Promise<IpcValue<M>>;
  const saved = await f.add(true, {
    title: "Python 入门练习资料",
    summary: "本人制作的 Python 基础练习和配套清单。",
    tags: ["Python", "编程"],
    coverData:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9U8AAAAASUVORK5CYII=",
  });
  await f.app.queue.execute(saved.jobId);
  let session: WebsiteSessionState = {
    hasSession: true,
    uid: "1234567890",
    nickname: "本地模拟微博账号",
    windowOpen: false,
    checkedAt: new Date().toISOString(),
    error: null,
  };
  const opened: { accountId: string; uid: string }[] = [];
  const copied: string[] = [];
  const generated: unknown[] = [];
  f.ports.websiteSessions = {
    isOpen: () => false,
    login: async () => {},
    clear: async () => {},
    invalidate: async () => {},
    status: async () => session,
    verify: async () => session,
    open: async (account, uid) => {
      opened.push({ accountId: account.id, uid: uid! });
    },
  };
  f.ports.chooseDirectory = async () => f.dir;
  f.ports.copyText = async (text) => {
    copied.push(text);
  };
  const account = await invoke("websiteAccounts.add", {
    provider: "weibo",
    alias: "本地模拟微博",
  });
  await invoke("websiteAccounts.check", { id: account.id });
  const publishing = await invoke("websiteAccounts.weiboPublishing", {
    id: account.id,
    allowLink: true,
    ruleNote: "模拟已核实本人资源推荐和正文网盘入口能力。",
    confirmed: true,
  });
  const bindingId = publishing.publishing!.bindingId;
  await f.app.secrets.set("openrouter", "mock-weibo-key");
  f.app.db.setSetting("model", "mock/weibo-text");
  f.app.db.setSetting("modelCatalog", [
    {
      id: "mock/weibo-text",
      name: "本地模拟文案模型",
      structured: true,
      promptPrice: 0.000001,
      completionPrice: 0.000001,
    },
  ]);
  f.app.db.setSetting("dailyAiBudgetMicros", 1_000_000);
  Object.assign(f.app.ai, {
    requestJson: async (url: string, init: RequestInit) => {
      assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
      generated.push(JSON.parse(String(init.body)));
      return {
        usage: { cost: 0.001 },
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "Python 基础练习资料",
                body: "适合刚开始学习 Python 的朋友，包含基础语法练习与学习清单。建议按自己的进度完成；本资料是练习辅助，不承诺学习效果。",
                tags: ["Python", "编程入门"],
                coverText: "基础练习",
              }),
            },
          },
        ],
      };
    },
  });
  const create = (keyword = "Python 入门练习") =>
    invoke("weibo.create", {
      keyword,
      sourceId: "manual",
      copyId: saved.copyId,
      audience: "Python 初学者",
      evidence: "本人制作的基础练习和学习清单，已核对资料用途及适用人群。",
    });
  const configure = (id: string, includeLink = true) =>
    invoke("weibo.configure", {
      id,
      options: {
        accountId: account.id,
        bindingId,
        uid: "1234567890",
        includeLink,
        artwork: "cover",
      },
    });
  const reviewed = async (keyword?: string) => {
    const created = await create(keyword);
    const generated = await invoke("weibo.generate", {
      id: created.run.id,
      artwork: "cover",
    });
    assert.equal(generated.run.stage, "review", generated.run.message);
    await invoke("draft.review", { id: generated.draft.id, reviewed: true });
    return configure(created.run.id);
  };
  const ready = async (keyword?: string) => {
    const result = await reviewed(keyword);
    const prepared = await invoke("weibo.prepare", { id: result.run.id });
    assert.equal(prepared.run.stage, "ready", prepared.run.message);
    return prepared;
  };
  return {
    ...f,
    invoke,
    saved,
    websiteAccount: account,
    bindingId,
    generated,
    opened,
    copied,
    create,
    configure,
    reviewed,
    ready,
    setSession(patch: Partial<WebsiteSessionState>) {
      session = { ...session, ...patch };
    },
  };
}

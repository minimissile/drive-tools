import assert from "node:assert/strict";
import test from "node:test";
import { Database } from "../core/database";
import { WechatArticleModules } from "../core/wechat/article-modules";
import type { IpcArgs, IpcMethod, IpcValue } from "../shared/ipc";
import { wechatArticleModuleBodyLimit } from "../shared/wechat-article-modules";
import { fixture } from "./helpers";

test("公众号模块库允许编辑预设和创建 Markdown 模块，拒绝无效字段或过期版本", async () => {
  const { app, cleanup } = await fixture();
  const invoke = <M extends IpcMethod>(method: M, args?: IpcArgs<M>) =>
    app.invoke(method, args) as Promise<IpcValue<M>>;
  try {
    const presets = await invoke("wechat.listModules");
    assert.ok(presets.length > 0);
    const existing = presets[0];
    const edited = await invoke("wechat.saveModule", {
      id: existing.id,
      revision: existing.revision,
      name: "  补充说明  ",
      body: "## 补充说明\n\n- 条件一\n- 条件二",
    });
    assert.deepEqual(edited[0], {
      id: existing.id,
      revision: existing.revision + 1,
      name: "补充说明",
      body: "## 补充说明\n\n- 条件一\n- 条件二",
    });
    assert.deepEqual(edited.slice(1), presets.slice(1));
    const current = await invoke("wechat.saveModule", {
      name: "代码示例",
      body: "    npm run check\n\n保留 Markdown 缩进。",
    });
    assert.deepEqual(current.slice(0, -1), edited);
    assert.equal(current.at(-1)?.body, "    npm run check\n\n保留 Markdown 缩进。");
    assert.equal(current.at(-1)?.revision, 1);

    await assert.rejects(
      invoke("wechat.saveModule", { ...existing, body: "旧窗口的内容" }),
      { code: "WECHAT_MODULE_CHANGED" },
    );
    await assert.rejects(
      invoke("wechat.deleteModule", { id: existing.id, revision: existing.revision }),
      { code: "WECHAT_MODULE_CHANGED" },
    );
    for (const invalid of [
      { name: " ", body: "正文" },
      { name: "说明", body: " \n " },
      { name: "说明", body: "文".repeat(wechatArticleModuleBodyLimit + 1) },
    ]) {
      await assert.rejects(invoke("wechat.saveModule", invalid));
    }
    assert.deepEqual(await invoke("wechat.listModules"), current);
    assert.deepEqual(await invoke("wechat.list"), []);
  } finally {
    await cleanup();
  }
});

test("公众号模块按工作空间保存，删除全部预设后不会恢复或被旧编辑重建", async () => {
  const { app, cleanup } = await fixture();
  const invoke = <M extends IpcMethod>(method: M, args?: IpcArgs<M>) =>
    app.invoke(method, args) as Promise<IpcValue<M>>;
  try {
    const presets = await invoke("wechat.listModules");
    for (const { id, revision } of presets)
      await invoke("wechat.deleteModule", { id, revision });
    assert.deepEqual(await invoke("wechat.listModules"), []);
    await assert.rejects(invoke("wechat.saveModule", presets[0]), {
      code: "WECHAT_MODULE_NOT_FOUND",
    });
    const reopened = new Database(app.db.path);
    const separate = new Database(":memory:");
    try {
      assert.deepEqual(new WechatArticleModules(reopened, () => {}).list(), []);
      assert.deepEqual(
        new WechatArticleModules(separate, () => {}).list(),
        presets,
      );
    } finally {
      separate.close();
      reopened.close();
    }
  } finally {
    await cleanup();
  }
});

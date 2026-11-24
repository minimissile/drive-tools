import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { jianshuEditorScript } from "../core/jianshu/editor.ts";

/** Read only the exact note opened by this workflow. Disconnect the debugger;
 * never close the user's browser, account, note, or other tabs. */
export async function verifyOfficialDraft(endpoint, detail, evidence) {
  const origin = new URL(endpoint);
  assert.equal(origin.hostname, "127.0.0.1");
  assert.equal(origin.protocol, "http:");
  const editorUrl = detail.article.editorUrl;
  let target;
  for (let attempt = 0; attempt < 30; attempt++) {
    const targets = await fetch(`${origin.origin}/json/list`).then((response) =>
      response.json(),
    );
    target = targets.find(
      (item) => item.type === "page" && item.url === editorUrl,
    );
    if (target) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(target, "没有找到由当前账号打开的准确简书草稿页面");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map();
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.addEventListener("message", (event) => {
      const result = JSON.parse(event.data);
      const callback = pending.get(result.id);
      if (!callback) return;
      pending.delete(result.id);
      result.error
        ? callback.reject(Error(result.error.message))
        : callback.resolve(result.result);
    });
    const command = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error(`简书只读检查超时：${method}`));
        }, 15000);
        pending.set(id, {
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const result = await command("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails)
        throw Error(
          result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text,
        );
      return result.result.value;
    };
    const read = () =>
      evaluate(
        jianshuEditorScript({ action: "read", html: detail.delivery.html }),
      );
    const check = async () => {
      let state;
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          state = await read();
          if (state.ready && state.images.every((image) => image.loaded)) break;
        } catch {
          /* A reload may briefly destroy its execution context. */
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.equal(state?.ready, true, "官网草稿没有加载完成");
      assert.equal(state.url, editorUrl);
      assert.equal(state.unpublished, true);
      assert.equal(state.title, detail.article.title);
      assert.equal(
        state.text,
        state.expectedText,
        "官网全文应与本地最终交付正文一致",
      );
      assert.equal(state.images.length, detail.article.images.length);
      assert.ok(state.images.every((image) => image.loaded));
      const saved = await evaluate(
        jianshuEditorScript({
          action: "verify",
          title: detail.article.title,
          html: detail.delivery.html,
          expectedEditorUrl: editorUrl,
          expectedTitle: state.title,
          expectedText: state.text,
          expectedImages: state.images.map(({ url, name }) => ({ url, name })),
          expectedRemoteImages: state.images.map((image) => image.url),
        }),
      );
      assert.equal(
        saved,
        true,
        "服务器中的标题、正文、真实链接与配图应完整且尚未发布",
      );
      return state;
    };
    const before = await check();
    await command("Page.reload");
    const after = await check();
    assert.deepEqual(
      after.images.map((image) => image.url),
      before.images.map((image) => image.url),
    );
    const screenshot = await command("Page.captureScreenshot", {
      format: "png",
    });
    await writeFile(
      join(evidence, "official-draft.png"),
      Buffer.from(screenshot.data, "base64"),
    );
    return {
      targetId: target.id,
      editorUrl,
      title: after.title,
      bodyCharacters: detail.delivery.text.length,
      imageCount: after.images.length,
      imageUrls: after.images.map((image) => image.url),
      serverVerified: true,
      officialReloaded: true,
      published: false,
    };
  } finally {
    socket.close();
  }
}

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Real local draft, no business mocks or writes. Close only this task's HMR socket. */
export async function run({ page, windowId }) {
  const out = join(tmpdir(), `panxu-wechat-live-preview-${windowId}`);
  await mkdir(out, { recursive: true });
  const messages = [];
  await page.on("console", (message) => {
    const text = message.text();
    if (/vite|worker|Content Security|panxu-hmr/i.test(text))
      messages.push(text);
  });
  await page.on("pageerror", (error) => messages.push(String(error)));
  const snapshot = await page.evaluate(() => window.panxu.invoke("snapshot"));
  const articleId = "wechat_c29c4aaa-979a-4a04-b97f-b02b4e9fd783";
  const original = await page.evaluate(
    (id) => window.panxu.invoke("wechat.get", { id }),
    articleId,
  );
  await page.evaluate(
    ({ windowId, dataPath, id }) =>
      localStorage.setItem(
        `panxu-window:${encodeURIComponent(windowId)}:panxu:wechat:${dataPath}:selection`,
        JSON.stringify({ url: "", selected: id, query: "", page: 1 }),
      ),
    { windowId, dataPath: snapshot.dataPath, id: articleId },
  );
  // Instrument only this task page. The constructor still opens the actual native socket.
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.WebSocket = new Proxy(Native, {
      construct(target, args) {
        const socket = Reflect.construct(target, args);
        if (args[1] === "vite-hmr") window.__panxuTaskHmrSocket = socket;
        return socket;
      },
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  const policy = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content");
  assert.match(policy, /worker-src 'self' blob:;/);
  const worker = await page.evaluate(async () => {
    const url = URL.createObjectURL(
      new Blob(
        [
          'onconnect=e=>{const p=e.ports[0];p.onmessage=e=>{if(e.data==="close")close();else p.postMessage("ready");};p.start();};',
        ],
        { type: "text/javascript" },
      ),
    );
    let worker;
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("恢复Worker无法启动")),
          4000,
        );
        worker = new SharedWorker(url);
        worker.port.onmessage = (event) => {
          clearTimeout(timer);
          resolve(event.data);
        };
        worker.onerror = () => {
          clearTimeout(timer);
          reject(Error("恢复Worker被阻止"));
        };
        worker.port.start();
        worker.port.postMessage("ping");
      });
    } finally {
      worker?.port.postMessage("close");
      worker?.port.close();
      URL.revokeObjectURL(url);
    }
  });
  assert.equal(worker, "ready");
  const editor = page.locator(".wechat-editor");
  const comparison = page.getByRole("dialog", {
    name: "全屏预览",
    exact: true,
  });
  const current = comparison.locator(
    "section[aria-labelledby='wechat-comparison-current']",
  );
  const checkPreview = async () => {
    await editor.getByRole("button", { name: "全屏预览", exact: true }).click();
    await current.getByText("夸克网盘资源", { exact: true }).waitFor();
    assert.equal(
      await current.getByText("夸克网盘资源", { exact: true }).count(),
      1,
    );
    assert.equal(
      await current
        .getByRole("link", { name: /^https:\/\/pan.quark.cn\/s\// })
        .count(),
      1,
    );
    assert.equal(
      await current.getByRole("heading", { name: /获取.*方法/ }).count(),
      1,
    );
  };
  await checkPreview();
  await page.screenshot({ path: join(out, "live-draft-fixed.png") });
  await comparison
    .getByRole("button", { name: "退出全屏", exact: true })
    .click();
  const before = await page.evaluate(() => performance.timeOrigin);
  await page.bringToFront();
  try {
    await page.waitForFunction(
      () => window.__panxuTaskHmrSocket?.readyState === 1,
    );
    const closed = await page.evaluate(() => {
      const socket = window.__panxuTaskHmrSocket;
      if (!socket || socket.protocol !== "vite-hmr" || socket.readyState !== 1)
        return 0;
      socket.close();
      return 1;
    });
    assert.equal(closed, 1, "只断开本任务页面的实际HMR连接");
    await page.waitForFunction(
      (origin) => performance.timeOrigin !== origin,
      before,
      { timeout: 20000 },
    );
  } catch (cause) {
    const diagnostics = await page.evaluate(() => ({
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      state: window.__panxuTaskHmrSocket?.readyState,
      origin: performance.timeOrigin,
    }));
    await writeFile(
      join(out, "recovery-failure.json"),
      JSON.stringify({ diagnostics, messages }, null, 2),
    );
    throw new Error(`断线恢复失败：${out}/recovery-failure.json`, { cause });
  }
  await checkPreview();
  await page.screenshot({ path: join(out, "after-hmr-recovery.png") });
  const latest = await page.evaluate(
    (id) => window.panxu.invoke("wechat.get", { id }),
    articleId,
  );
  assert.deepEqual(latest.article, original.article, "整个验收不改写共享稿件");
  const report = {
    windowId,
    out,
    checks: [
      "实际共享稿件只读验收，无业务mock",
      "实际预览显示网盘卡片和小标题",
      "开发SharedWorker正常运行",
      "本窗口实际HMR断线后自动恢复并重新加载",
      "恢复后仍使用正确排版",
      "共享稿件保持不变",
    ],
  };
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  return report;
}

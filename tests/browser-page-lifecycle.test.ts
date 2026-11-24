import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import { findEnvironmentPage } from "../core/browser-pages";
import {
  attachPageLedger,
  BrowserPageLedger,
  createTemporaryPage,
  disposablePage,
  freezePageLedger,
  inspectManagedPages,
  pageLedger,
  releaseTemporaryPage,
} from "../core/browser-page-lifecycle";
import { browserProcessMode } from "../core/browser-process-mode";
import { BitBrowserLifecycle } from "../core/bitbrowser-lifecycle";
import { BitBrowser } from "../core/bitbrowser";
import type { BrowserBinding } from "../shared/types";
let context: BrowserContext, directory: string, endpoint: string;
const lifecycle = new BitBrowserLifecycle();
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "panxu-browser-lifecycle-"));
  context = await chromium.launchPersistentContext(directory, {
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--remote-debugging-port=0", "--enable-automation", lifecycle.token],
  });
  const [port, path] = (
    await readFile(join(directory, "DevToolsActivePort"), "utf8")
  )
    .trim()
    .split(/\r?\n/);
  endpoint = `ws://127.0.0.1:${port}${path}`;
  await context.route("https://**/*", (route) =>
    route.fulfill({
      body: "<!doctype html><title>本地隔离测试</title><textarea></textarea><div contenteditable=true></div>",
      contentType: "text/html",
    }),
  );
});
after(async () => {
  await context?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
test("同一入口并发打开只建一页，重连和跨域跳转后仍复用且不导航草稿", async () => {
  const ledger = new BrowserPageLedger();
  attachPageLedger(context, ledger);
  const [a, b] = await Promise.all([
    findEnvironmentPage(context, "fixture:editor", "https://editor.test/start"),
    findEnvironmentPage(context, "fixture:editor", "https://editor.test/start"),
  ]);
  assert.equal(a, b);
  await a.goto("https://login.test/redirect");
  await a.locator("textarea").fill("尚未提交的草稿");
  const connected = await chromium.connectOverCDP(endpoint);
  try {
    const resumed = connected.contexts()[0];
    attachPageLedger(resumed, ledger);
    const found = await findEnvironmentPage(
      resumed,
      "fixture:editor",
      "https://editor.test/start",
    );
    assert.equal(found.url(), "https://login.test/redirect");
    assert.equal(
      await found.locator("textarea").inputValue(),
      "尚未提交的草稿",
    );
    await inspectManagedPages(resumed, true);
    assert.equal(found.isClosed(), false);
  } finally {
    await connected.close();
  }
  await a.close();
});
test("恢复的同源标签标记可复用，但不授予历史页面清理权限", async () => {
  attachPageLedger(context, new BrowserPageLedger());
  const page = await findEnvironmentPage(
    context,
    "fixture:restored",
    "https://restored.test/",
  );
  await page.evaluate(() => {
    window.name = "";
  });
  attachPageLedger(context, new BrowserPageLedger());
  const restored = await findEnvironmentPage(
    context,
    "fixture:restored",
    "https://restored.test/",
  );
  assert.equal(restored, page);
  await inspectManagedPages(context, true);
  assert.equal(page.isClosed(), false);
  await page.close();
});
test("临时页成功失败均回收，手动页、点击、键入、脚本草稿、附件和未知状态均保留", async () => {
  attachPageLedger(context, new BrowserPageLedger());
  const manual = await context.newPage();
  await manual.goto("https://manual.test/");
  const temp = await createTemporaryPage(context, "https://read.test/");
  await temp.goto("https://read.test/");
  assert.equal(await disposablePage(temp), true, JSON.stringify([...pageLedger(context).records.values()]));
  await releaseTemporaryPage(temp);
  assert.equal(temp.isClosed(), true);
  const touched = await createTemporaryPage(context, "https://read.test/");
  await touched.goto("https://read.test/");
  await touched.locator("textarea").fill("未提交");
  await touched.locator("textarea").fill("");
  await releaseTemporaryPage(touched);
  assert.equal(touched.isClosed(), false);
  const clicked = await createTemporaryPage(context, "https://read.test/");
  await clicked.goto("https://read.test/");
  assert.equal(await disposablePage(clicked), true);
  await clicked.locator("body").click({ position: { x: 4, y: 4 } });
  await releaseTemporaryPage(clicked);
  assert.equal(clicked.isClosed(), false);
  const draft = await createTemporaryPage(context, "https://read.test/");
  await draft.goto("https://read.test/");
  await draft.locator("[contenteditable]").evaluate((el) => {
    el.textContent = "脚本填入的草稿";
  });
  assert.equal(await disposablePage(draft), false);
  const file = await createTemporaryPage(context, "https://read.test/");
  await file.goto("https://read.test/");
  await file.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    document.body.append(input);
  });
  await file.locator("input").setInputFiles({
    name: "草稿.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("draft"),
  });
  assert.equal(await disposablePage(file), false);
  const result = await inspectManagedPages(context, true);
  assert.ok(result.protected >= 5);
  assert.equal(manual.isClosed(), false);
  for (const page of [manual, touched, clicked, draft, file]) await page.close();
});
test("断连后导航、页面内导航后清空表单、草稿页不因清理而丢失", async () => {
  const ledger = new BrowserPageLedger();
  attachPageLedger(context, ledger);
  const temp = await createTemporaryPage(context, "https://read.test/one");
  await temp.goto("https://read.test/one");
  await freezePageLedger(context);
  await temp.goto("https://read.test/two");
  assert.equal(await disposablePage(temp), false);
  await inspectManagedPages(context, true);
  assert.equal(temp.isClosed(), false);
  await temp.close();
});
test("窗口归属须匹配本进程标记；手动保留、重启后未知窗口一律保留", async () => {
  const key = lifecycle.key("http://127.0.0.1:54345", "fixture");
  await lifecycle.attach(key, endpoint, context);
  assert.equal(lifecycle.info(key).owner, "panxu");
  const emptyWindow = await lifecycle.inspect(key);
  assert.equal(emptyWindow.protected, 1);
  assert.equal(emptyWindow.temporary, 0);
  const cdp = await context.browser()!.newBrowserCDPSession();
  try {
    const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
    const pid = processInfo.find((p) => p.type === "browser")!.id;
    const debug = new URL(endpoint);
    assert.equal(
      (
        await browserProcessMode(
          pid,
          basename(directory),
          Number(debug.port),
          debug.pathname,
          lifecycle.token,
        )
      )?.owned,
      true,
    );
    assert.equal(
      (
        await browserProcessMode(
          pid,
          basename(directory),
          Number(debug.port),
          debug.pathname,
          "--panxu-window-owner=other",
        )
      )?.owned,
      false,
    );
    assert.equal(
      await browserProcessMode(
        pid,
        basename(directory) + "-other",
        Number(debug.port),
        debug.pathname,
        lifecycle.token,
      ),
      null,
    );
  } finally {
    await cdp.detach();
  }
  lifecycle.keep(key);
  assert.equal(lifecycle.info(key).owner, "retained");
  const unknown = new BitBrowserLifecycle();
  await unknown.attach(key, endpoint, context);
  assert.equal(unknown.info(key).owner, "retained");
  assert.equal((await unknown.inspect("never-opened", true)).connected, false);
});
test("已归属浏览器仍保留既有和用户新增空白页，只清理明确创建的临时页", async () => {
  const originalPages = context.pages();
  const beforeAttach = await context.newPage();
  const key = lifecycle.key("http://127.0.0.1:54345", "fixture-blank-pages");
  await lifecycle.attach(key, endpoint, context);
  assert.equal(lifecycle.info(key).owner, "panxu");
  const afterAttach = await context.newPage();
  const temporary = await createTemporaryPage(context);
  try {
    assert.equal(await disposablePage(beforeAttach), false);
    assert.equal(await disposablePage(afterAttach), false);
    assert.equal(await disposablePage(temporary), true);
    const result = await lifecycle.inspect(key, true);
    assert.equal(result.closed, 1);
    assert.equal(temporary.isClosed(), true);
    assert.equal(beforeAttach.isClosed(), false);
    assert.equal(afterAttach.isClosed(), false);
    assert.ok(originalPages.every((page) => !page.isClosed()));
  } finally {
    for (const page of [beforeAttach, afterAttach, temporary])
      if (!page.isClosed()) await page.close();
  }
});
test("编辑器默认复用不覆盖草稿，明确新建才增加页面，任务结束不关闭窗口", async () => {
  const calls: string[] = [];
  const bit = new BitBrowser(
    async () => ({ url: "http://127.0.0.1:54345", key: null }),
    async (url, init) => {
      const args = JSON.parse(String(init?.body)).args;
      assert.ok(
        args.some((a: string) => a.startsWith("--panxu-window-owner=")),
      );
      assert.ok(!args.includes("--enable-automation"));
      calls.push(String(url));
      return { success: true, data: { ws: endpoint } };
    },
  );
  const binding = {
    id: "fixture-binding",
    platform: "csdn",
    windowId: "fixture",
    editorUrl: "https://editor.csdn.net/md/",
  } as BrowserBinding;
  await bit.open(binding);
  const first = context.pages().find((p) => p.url() === binding.editorUrl)!;
  await first.locator("textarea").fill("重要草稿");
  await bit.open(binding);
  assert.equal(
    context.pages().filter((p) => p.url() === binding.editorUrl).length,
    1,
  );
  assert.equal(await first.locator("textarea").inputValue(), "重要草稿");
  await bit.open(binding, true);
  assert.equal(
    context.pages().filter((p) => p.url() === binding.editorUrl).length,
    2,
  );
  await context.route("https://editor.csdn.net/md/**", (route) =>
    route.fulfill({ status: 503, body: "暂不可用" }),
  );
  await assert.rejects(() => bit.open(binding, true), /HTTP 503|HTTP503/);
  const recovering = { ...binding, id: "fixture-recovering" };
  await assert.rejects(() => bit.open(recovering), /HTTP 503|HTTP503/);
  const failedPage = context.pages().at(-1)!;
  await context.unroute("https://editor.csdn.net/md/**");
  await failedPage.reload();
  const pageCount = context.pages().length;
  await bit.open(recovering);
  assert.equal(context.pages().length, pageCount);
  assert.ok(calls.every((url) => url.endsWith("/browser/open")));
  for (const page of context
    .pages()
    .filter((p) => p.url() === binding.editorUrl))
    await page.close();
});

test("无法读取命令行时只接受绑定本机进程的证明，不增加自动化标志", async () => {
  const owner = new BitBrowserLifecycle();
  const context = {
    browser: () => ({
      newBrowserCDPSession: async () => ({
        send: async () => {
          throw Error("automation flag absent");
        },
        detach: async () => {},
      }),
    }),
    pages: () => [],
  } as unknown as BrowserContext;
  const key = owner.key("http://127.0.0.1:54345", "attested");
  await owner.attach(
    key,
    "ws://127.0.0.1:1234/devtools/browser/fixture",
    context,
    async () => true,
  );
  assert.equal(owner.info(key).owner, "panxu");
  const unknown = new BitBrowserLifecycle();
  await unknown.attach(
    key,
    "ws://127.0.0.1:1234/devtools/browser/fixture",
    context,
    async () => {
      throw Error("cannot attest");
    },
  );
  assert.equal(unknown.info(key).owner, "retained");
});
test("最后一个临时页不会被清理成整窗关闭", async () => {
  attachPageLedger(context, new BrowserPageLedger());
  const temp = await createTemporaryPage(context, "https://read.test/last");
  await temp.goto("https://read.test/last");
  for (const page of context.pages()) if (page !== temp) await page.close();
  await releaseTemporaryPage(temp);
  assert.equal(temp.isClosed(), false);
  const result = await inspectManagedPages(context, true);
  assert.equal(result.closed, 0);
});

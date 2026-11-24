import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { BrowserContext, Page } from "playwright-core";
import {
  BrowserPageLedger,
  attachPageLedger,
  disposablePage,
  expectTemporaryPageNavigation,
  freezePageLedger,
  inspectManagedPages,
  pageLedger,
  recordManagedPage,
  releaseTemporaryPage,
} from "../core/browser-page-lifecycle";
import { BitBrowserLifecycle } from "../core/bitbrowser-lifecycle";

function fixture(stalledMethod?: string, targetId = "fixture-target") {
  const requests: string[] = [];
  let binding = "";
  let closed = false;
  let stalledRead = false;
  let stalledClose = false;
  let closeCalls = 0;
  const guard = {
    touched: false,
    documentId: "initial-document",
    url: "about:blank",
    binding: "",
  };
  const mainFrame = { evaluate: async () => true };
  const page = Object.assign(new EventEmitter(), {
    url: () => guard.url,
    mainFrame: () => mainFrame,
    frames: () => [mainFrame],
    isClosed: () => closed,
    close: async () => {
      closeCalls++;
      if (stalledClose) return new Promise<never>(() => {});
      closed = true;
    },
    context: () => context,
    evaluate: async () => stalledRead ? new Promise<never>(() => {}) : { ...guard },
    exposeFunction: () => { throw Error("context-global binding must not be used"); },
    addInitScript: () => { throw Error("context-global initialization must not be used"); },
  });
  const inputSession = Object.assign(new EventEmitter(), {
    send: async (method: string, args?: Record<string, unknown>): Promise<any> => {
      requests.push(method);
      if (method === stalledMethod) return new Promise(() => {});
      if (method === "Target.getTargetInfo") return { targetInfo: { targetId } };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
      if (method === "Runtime.enable") {
        inputSession.emit("Runtime.executionContextCreated", { context: { id: 1, auxData: { frameId: "main-frame" } } });
      }
      if (method === "Runtime.addBinding") guard.binding = binding = String(args?.name);
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "fixture-script" };
      if (method === "Runtime.evaluate") return { result: { value: { ...guard } } };
      return {};
    },
    detach: async () => {},
  });
  const context = {
    newCDPSession: async () => inputSession,
    pages: () => [page],
    browser: () => ({ newBrowserCDPSession: async () => ({
      send: async () => ({ arguments: [] }), detach: async () => {},
    }) }),
  } as unknown as BrowserContext;
  const record = { key: "reader", role: "temporary" as "temporary" | "interactive" };
  const ready = (url: string, documentId: string, kind = "ready") => {
    guard.url = url;
    guard.documentId = documentId;
    inputSession.emit("Runtime.bindingCalled", {
      name: binding, executionContextId: 1,
      payload: JSON.stringify({ kind, url, documentId }),
    });
  };
  return { context, page: page as unknown as Page, record, requests, ready, guard,
    attachFrame: () => page.emit("frameattached", {}),
    stalledRead: () => { stalledRead = true; },
    stallClose: () => { stalledClose = true; },
    closeCalls: () => closeCalls };
}

test("登记只用当前页CDP，不初始化上下文中其他登录页或广告iframe", async () => {
  const f = fixture();
  await recordManagedPage(f.context, f.page, f.record);
  assert.ok(f.requests.includes("Runtime.addBinding"));
  assert.ok(f.requests.includes("Page.addScriptToEvaluateOnNewDocument"));
  assert.equal(await disposablePage(f.page), true);
});

test("登记超时有确切阶段并永久保留页面，后续冻结不再等待它", async () => {
  const f = fixture("Runtime.addBinding");
  await assert.rejects(
    recordManagedPage(f.context, f.page, f.record, { timeoutMs: 10 }),
    (error: any) => error.code === "BROWSER_PAGE_LIFECYCLE_TIMEOUT" && error.details.stage === "input-binding",
  );
  assert.equal(f.record.role, "interactive");
  assert.equal(f.page.isClosed(), false);
  f.stalledRead();
  await freezePageLedger(f.context, { timeoutMs: 10 });
  assert.equal(await disposablePage(f.page), false);
});

test("owned既有空白页不授予清理权限，也不等待输入保护登记", async () => {
  const f = fixture("Runtime.addBinding");
  const lifecycle = new BitBrowserLifecycle();
  const browser = f.context.browser()!;
  Object.assign(browser, { newBrowserCDPSession: async () => ({
    send: async () => ({ arguments: [lifecycle.token] }), detach: async () => {},
  }) });
  Object.assign(f.context, { browser: () => browser });
  await lifecycle.attach("fixture", "fixture-endpoint", f.context, undefined, { timeoutMs: 10 });
  assert.equal(lifecycle.info("fixture").owner, "panxu");
  assert.equal(pageLedger(f.context).records.size, 0);
  assert.equal(await disposablePage(f.page), false);
  assert.ok(!f.requests.includes("Runtime.addBinding"));
  assert.equal(f.page.isClosed(), false);
});

test("明确声明的目标可清理，只忽略hash，重载及未知导航永久保留", async () => {
  const f = fixture();
  await recordManagedPage(f.context, f.page, f.record);
  expectTemporaryPageNavigation(f.page, "https://reader.test/article#one");
  f.ready("https://reader.test/article#two", "controlled-document");
  assert.equal(await disposablePage(f.page), true);
  f.ready("https://reader.test/article#two", "unexpected-reload");
  assert.equal(await disposablePage(f.page), false);
  expectTemporaryPageNavigation(f.page, "https://reader.test/next");
  f.ready("https://reader.test/next", "late-controlled-document");
  assert.equal(f.record.role, "interactive");
});

test("同源不同路径或查询参数不会被当作受控目标", async () => {
  for (const url of ["https://reader.test/other", "https://reader.test/article?q=1"]) {
    const f = fixture();
    await recordManagedPage(f.context, f.page, f.record);
    expectTemporaryPageNavigation(f.page, "https://reader.test/article");
    f.ready(url, "unexpected-document");
    assert.equal(await disposablePage(f.page), false);
  }
});

test("输入后清空并导航也保留；未知iframe即使随后移除仍保留", async () => {
  const f = fixture();
  await recordManagedPage(f.context, f.page, f.record);
  f.ready("about:blank", "initial-document", "touch");
  expectTemporaryPageNavigation(f.page, "https://reader.test/");
  f.ready("https://reader.test/", "next-document");
  assert.equal(await disposablePage(f.page), false);
  const frame = fixture();
  await recordManagedPage(frame.context, frame.page, frame.record);
  frame.attachFrame();
  assert.equal(await disposablePage(frame.page), false);
});

test("空账本冻结不访问页面，未知页面不发CDP；读失败永久保留", async () => {
  const empty = { pages: () => { throw Error("empty ledger must not inspect pages"); } } as unknown as BrowserContext;
  await freezePageLedger(empty);
  const f = fixture();
  attachPageLedger(f.context, new BrowserPageLedger());
  pageLedger(f.context).records.set("other-connection", { key: "", role: "temporary" });
  await freezePageLedger(f.context);
  assert.equal(f.requests.length, 0);
  await recordManagedPage(f.context, f.page, f.record);
  f.stalledRead();
  await freezePageLedger(f.context, { timeoutMs: 10 });
  assert.equal(f.record.role, "interactive");
  assert.equal(f.page.isClosed(), false);
});

test("重新登记同一target不覆盖此前可信输入留下的永久保护", async () => {
  const f = fixture();
  await recordManagedPage(f.context, f.page, f.record);
  f.ready("about:blank", "initial-document", "touch");
  // A fresh document can have an empty local guard, but the ledger remembers
  // trusted input before navigation and must not replace that history.
  f.guard.documentId = "later-empty-document";
  await recordManagedPage(f.context, f.page, { key: "", role: "temporary" });
  assert.equal(await disposablePage(f.page), false);
  assert.equal(pageLedger(f.context).records.get("fixture-target")?.touched, true);
});

test("临时页关闭超时不占住业务，结果未知后不再重试关闭", async () => {
  const f = fixture();
  await recordManagedPage(f.context, f.page, f.record);
  Object.assign(f.context, { pages: () => [f.page, {}] });
  f.stallClose();
  const started = Date.now();
  await releaseTemporaryPage(f.page, { timeoutMs: 10 });
  assert.ok(Date.now() - started < 1000);
  assert.equal(f.page.isClosed(), false);
  assert.equal(f.closeCalls(), 1);
  assert.equal(f.record.role, "interactive");
  assert.equal(pageLedger(f.context).records.get("fixture-target")?.protectionFailure, "close-unknown");
  await releaseTemporaryPage(f.page, { timeoutMs: 10 });
  assert.equal(f.closeCalls(), 1);
});

test("清理一页关闭超时后继续清理其余已确认临时页", async () => {
  const stalled = fixture(undefined, "stalled-target");
  const next = fixture(undefined, "next-target");
  const stalledSession = await stalled.context.newCDPSession(stalled.page);
  const nextSession = await next.context.newCDPSession(next.page);
  const context = {
    pages: () => [stalled.page, next.page],
    newCDPSession: async (page: Page) => page === stalled.page ? stalledSession : nextSession,
  } as unknown as BrowserContext;
  await recordManagedPage(context, stalled.page, stalled.record);
  await recordManagedPage(context, next.page, next.record);
  stalled.stallClose();
  const result = await inspectManagedPages(context, true, { timeoutMs: 10 });
  assert.deepEqual(result, { temporary: 1, protected: 1, closed: 1 });
  assert.equal(stalled.closeCalls(), 1);
  assert.equal(stalled.page.isClosed(), false);
  assert.equal(next.page.isClosed(), true);
  await inspectManagedPages(context, true, { timeoutMs: 10 });
  assert.equal(stalled.closeCalls(), 1);
});

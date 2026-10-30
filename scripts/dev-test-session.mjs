import { chromium } from "playwright-core";
import { setTimeout as delay } from "node:timers/promises";
import { devConnection, devSessionRequest } from "./dev-session-client.mjs";

/** Attach to one visible window in the running app. Never launch/quit Electron,
 * replace global fetch, or install browser-context-wide mocks in a shared backend. */
export async function withDevTestSession(
  { label, session = "", initialPage, close = false },
  run,
) {
  if (typeof run !== "function")
    throw new Error(
      "测试模块必须导出 async run({ page, checkpoint, windowId })。",
    );
  const connection = await devConnection();
  let browser,
    info,
    page,
    status = "interrupted";
  const abort = new AbortController();
  const stop = () => abort.abort(new Error("测试被中断。"));
  const request = (action, args) => devSessionRequest(action, args, connection);
  const checkpoint = async () => {
    for (;;) {
      abort.signal.throwIfAborted();
      const current = (await request("dev.sessions")).find(
        (item) => item.id === info.id,
      );
      if (!current || !["running", "paused"].includes(current.status))
        throw new Error("测试窗口已关闭或已手动接管，本轮测试停止。");
      if (current.status === "running") return;
      await delay(250, undefined, { signal: abort.signal });
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    // Connect before creating a window; a missing debug service leaves no orphan.
    browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${connection.cdpPort}`,
      { timeout: 10000, noDefaults: true },
    );
    info = await request("dev.session.open", {
      label,
      session,
      mode: "automation",
      initialPage,
    });
    const deadline = Date.now() + 20000;
    while (!page && Date.now() < deadline) {
      abort.signal.throwIfAborted();
      for (const candidate of browser
        .contexts()
        .flatMap((context) => context.pages())) {
        if (!candidate.url().startsWith(connection.url)) continue;
        const id = await candidate
          .evaluate(() => window.panxu?.windowId)
          .catch(() => undefined);
        if (id === info.id) {
          page = candidate;
          break;
        }
      }
      if (!page) await delay(100, undefined, { signal: abort.signal });
    }
    if (!page)
      throw new Error("未找到本轮测试的页面，请检查开发窗口是否加载成功。");
    try {
      await request("dev.session.update", {
        id: info.id,
        status: "running",
        expectedStatus: "paused",
      });
    } catch (error) {
      const current = (await request("dev.sessions")).find(
        (item) => item.id === info.id,
      );
      // A user can resume the visible window while CDP discovers its page.
      if (current?.status !== "running") throw error;
    }
    await checkpoint();
    const value = await run({
      page: controlledPage(page, checkpoint),
      checkpoint,
      windowId: info.id,
    });
    for (;;) {
      await checkpoint();
      try {
        await request("dev.session.update", {
          id: info.id,
          status: "passed",
          expectedStatus: "running",
        });
        status = "passed";
        break;
      } catch (error) {
        const current = (await request("dev.sessions")).find(
          (item) => item.id === info.id,
        );
        if (current?.status !== "paused") throw error;
      }
    }
    return { windowId: info.id, status, value };
  } catch (error) {
    if (info) {
      try {
        const current = (await request("dev.sessions")).find(
          (item) => item.id === info.id,
        );
        if (current && ["running", "paused"].includes(current.status)) {
          status = abort.signal.aborted ? "interrupted" : "failed";
          await request("dev.session.update", {
            id: info.id,
            status,
            expectedStatus: current.status,
          });
        }
      } catch {
        /* A closed window or stopped backend must not affect other sessions. */
      }
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (close && info) {
      try {
        const current = (await request("dev.sessions")).find(
          (item) => item.id === info.id,
        );
        if (current && ["passed", "failed"].includes(current.status))
          await request("dev.session.close", { id: info.id });
      } catch {
        /* Keep the window if ownership or backend state is uncertain. */
      }
    }
    // connectOverCDP owns a connection, not the already running application.
    await browser?.close();
  }
}

// Pause before each Playwright operation, while leaving locator construction
// synchronous. An operation already in flight is allowed to finish before pause.
function controlledPage(page, checkpoint) {
  const proxies = new WeakMap(),
    originals = new WeakMap();
  const synchronous = new Set([
    "locator",
    "getByRole",
    "getByLabel",
    "getByText",
    "getByTitle",
    "getByAltText",
    "getByPlaceholder",
    "getByTestId",
    "frameLocator",
    "filter",
    "first",
    "last",
    "nth",
    "and",
    "or",
    "describe",
    "toString",
    "url",
    "isClosed",
    "mainFrame",
    "frames",
    "page",
    "parentFrame",
    "childFrames",
    "contentFrame",
    "owner",
    "asElement",
    "frame",
    "name",
    "isDetached",
    "on",
    "once",
    "off",
    "removeListener",
    "removeAllListeners",
    "setDefaultTimeout",
    "setDefaultNavigationTimeout",
  ]);
  const classes = new Set([
    "Page",
    "Locator",
    "Frame",
    "FrameLocator",
    "ElementHandle",
    "JSHandle",
    "Keyboard",
    "Mouse",
    "Touchscreen",
  ]);
  const wrap = (target) => {
    if (Array.isArray(target)) return target.map(wrap);
    if (
      !target ||
      !classes.has(
        String(target.constructor?.name).replace(/^_/, "").replace(/\d+$/, ""),
      )
    )
      return target;
    if (proxies.has(target)) return proxies.get(target);
    const proxy = new Proxy(target, {
      get(object, key) {
        if (["context", "browser", "close"].includes(key))
          return () => {
            throw new Error(
              "共享测试只操作自己的页面；关闭窗口由会话运行器管理。",
            );
          };
        const value = Reflect.get(object, key, object);
        // Playwright's locator composition compares private frame identities.
        // Keep those implementation fields raw while wrapping public operations.
        if (
          typeof key === "string" &&
          key.startsWith("_") &&
          typeof value !== "function"
        )
          return value;
        if (typeof value !== "function") return wrap(value);
        const invoke = (args) => {
          const result = Reflect.apply(
            value,
            object,
            args.map((arg) => originals.get(arg) ?? arg),
          );
          return result instanceof Promise ? result.then(wrap) : wrap(result);
        };
        return synchronous.has(key)
          ? (...args) => invoke(args)
          : async (...args) => {
              await checkpoint();
              return invoke(args);
            };
      },
    });
    proxies.set(target, proxy);
    originals.set(proxy, target);
    return proxy;
  };
  return wrap(page);
}

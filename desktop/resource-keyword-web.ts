import { BrowserWindow, session } from "electron";
import { createHash } from "node:crypto";
import type { AppPorts } from "../core/ports";
import { createBackgroundBrowserWindow } from "./background-browser-window";
import { isAbortedNavigation } from "./website-session-policy";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "../core/errors";

const home = "https://ci.5118.com/";
const login = "https://account.5118.com";
function isLoginPage(raw: string) {
  const url = URL.parse(raw);
  return (
    !!url &&
    url.origin === login &&
    /^\/(?:signin|login)(?:\/|$)/i.test(url.pathname)
  );
}
function allowedPage(raw: string) {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ((url.hostname === "ci.5118.com" && url.pathname === "/") ||
        url.hostname === "account.5118.com" ||
        (url.hostname === "www.5118.com" && url.pathname === "/") ||
        (url.hostname === "www.5118.com" &&
          /^\/seo\/newwords\/[a-z0-9]{1,48}\/?$/i.test(url.pathname)))
    );
  } catch {
    return false;
  }
}

function submitPublicSearch(keyword: string) {
  const form = document.querySelector("form.seo-search-box");
  const input = form?.querySelector<HTMLInputElement>(
    'input[placeholder="请输入搜索关键词"]',
  );
  const button = Array.from(form?.querySelectorAll("button") ?? []).find(
    (item) => item.textContent?.replace(/\s+/g, "") === "搜索",
  );
  if (!input || !button || button.disabled) return false;
  input.value = keyword;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  button.click();
  return true;
}

/** Only read visible text from the official public first-page keyword table. */
export function read5118KeywordTable(keyword: string) {
  const normalize = (s: string) =>
    s.normalize("NFKC").replace(/\s+/g, " ").trim();
  const query = document.querySelector<HTMLInputElement>("#txt_content");
  if (!query || normalize(query.value) !== normalize(keyword)) return null;
  const table = Array.from(
    document.querySelectorAll<HTMLTableElement>("table.list-table"),
  ).find((item) =>
    item.rows[0]?.cells[0]?.innerText.trim().startsWith("关键词"),
  );
  if (!table) return null;
  const words: string[] = [];
  for (const row of Array.from(table.rows).slice(1, 101)) {
    const first = row.cells[0];
    if (!first || !first.getClientRects().length) continue;
    const link = Array.from(
      first.querySelectorAll<HTMLAnchorElement>("a"),
    ).find((node) => node.getClientRects().length && !!node.innerText.trim());
    if (link) words.push(link.innerText.trim());
  }
  return words;
}

function hasPublicSearch() {
  const input = document.querySelector<HTMLInputElement>(
    'form.seo-search-box input[placeholder="请输入搜索关键词"]',
  );
  return !!input && !input.disabled && !!input.getClientRects().length;
}

type Context = {
  window: BrowserWindow;
  busy: boolean;
  blocked: boolean;
  loginRequired: boolean;
};

/** Each workspace keeps its own reusable search page and official login session. */
export function createResourceKeywordWeb(workspace: () => string) {
  const contexts = new Map<string, Context>();
  const context = () => {
    const key = createHash("sha256")
      .update(workspace())
      .digest("hex")
      .slice(0, 24);
    const previous = contexts.get(key);
    if (previous && !previous.window.isDestroyed()) return previous;
    const profile = session.fromPartition(`persist:panxu-5118-${key}`);
    profile.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    const window = createBackgroundBrowserWindow({
      width: 1200,
      height: 820,
      title: "5118 关键词 · 内置浏览器",
      webPreferences: {
        session: profile,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const value: Context = {
      window,
      busy: false,
      blocked: false,
      loginRequired: false,
    };
    const allow = (url: string) => {
      value.loginRequired = isLoginPage(url);
      if (allowedPage(url)) return true;
      value.blocked = true;
      return false;
    };
    window.webContents.on("will-navigate", (event, url) => {
      if (!allow(url)) event.preventDefault();
    });
    window.webContents.on(
      "will-redirect",
      (event, url, _inPlace, mainFrame) => {
        if (mainFrame && !allow(url)) event.preventDefault();
      },
    );
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (allow(url)) void window.loadURL(url).catch(() => {});
      return { action: "deny" };
    });
    window.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    window.on("closed", () => {
      if (contexts.get(key) === value) contexts.delete(key);
    });
    contexts.set(key, value);
    return value;
  };
  const run = <T>(
    window: BrowserWindow,
    fn: (word: string) => T,
    keyword = "",
  ) =>
    window.webContents.executeJavaScript(
      `(() => {const __name = fn => fn; return (${fn.toString()})(${JSON.stringify(keyword)})})()`,
    ) as Promise<T>;
  const requireLogin = (ctx: Context) => {
    if (ctx.loginRequired || isLoginPage(ctx.window.webContents.getURL()))
      throw new AppError(
        "KEYWORD_5118_LOGIN_REQUIRED",
        "5118 要求登录后查询。请打开5118内置浏览器完成登录，再重新检索。",
      );
  };
  const withPage = async <T>(
    signal: AbortSignal,
    action: (ctx: Context, deadline: AbortSignal) => Promise<T>,
  ) => {
    signal.throwIfAborted();
    const ctx = context();
    if (ctx.busy)
      throw new AppError(
        "KEYWORD_BROWSER_BUSY",
        "5118正在处理其他检索，请完成后重试。",
      );
    ctx.busy = true;
    ctx.blocked = false;
    ctx.loginRequired = false;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    const stop = () => {
      if (!ctx.window.isDestroyed()) ctx.window.webContents.stop();
    };
    deadline.addEventListener("abort", stop, { once: true });
    try {
      return await action(ctx, deadline);
    } catch (cause) {
      signal.throwIfAborted();
      if (!ctx.window.isDestroyed()) requireLogin(ctx);
      if (cause instanceof AppError) throw cause;
      throw new AppError(
        "KEYWORD_5118_UNAVAILABLE",
        "5118暂未返回可读取的免费结果，请在内置浏览器检查后重试。",
      );
    } finally {
      deadline.removeEventListener("abort", stop);
      ctx.busy = false;
    }
  };
  const homePage = async (ctx: Context, signal: AbortSignal) => {
    requireLogin(ctx);
    if (
      ctx.window.webContents.getURL() !== home ||
      !(await run(ctx.window, hasPublicSearch))
    ) {
      await ctx.window.loadURL(home);
    }
    for (;;) {
      signal.throwIfAborted();
      requireLogin(ctx);
      if (ctx.blocked)
        throw new AppError(
          "KEYWORD_5118_UNAVAILABLE",
          "5118跳转到了其他页面，请打开内置浏览器检查。",
        );
      const ready = await run(ctx.window, hasPublicSearch);
      signal.throwIfAborted();
      if (ready) return;
      await delay(350, undefined, { signal });
    }
  };
  return {
    read: (keyword: string, signal: AbortSignal) => {
      if (keyword.length > 80)
        throw new AppError(
          "KEYWORD_TOO_LONG",
          "5118网页最多接受80字，请缩短这个搜索词。",
        );
      return withPage(signal, async (ctx, deadline) => {
        await homePage(ctx, deadline);
        if (!(await run(ctx.window, submitPublicSearch, keyword)))
          throw new AppError(
            "KEYWORD_5118_UNAVAILABLE",
            "5118查询入口暂不可用，请打开内置浏览器检查。",
          );
        for (;;) {
          deadline.throwIfAborted();
          requireLogin(ctx);
          if (ctx.blocked)
            throw new AppError(
              "KEYWORD_5118_UNAVAILABLE",
              "5118返回了异常页面，请打开内置浏览器检查。",
            );
          if (
            /^https:\/\/www\.5118\.com\/seo\/newwords\//.test(
              ctx.window.webContents.getURL(),
            )
          ) {
            const words = await run(ctx.window, read5118KeywordTable, keyword);
            deadline.throwIfAborted();
            if (words?.length) return words;
          }
          await delay(350, undefined, { signal: deadline });
        }
      });
    },
    check: (signal: AbortSignal) =>
      withPage(signal, (ctx, deadline) => homePage(ctx, deadline)),
    async open() {
      const ctx = context();
      if (ctx.window.isMinimized()) ctx.window.restore();
      ctx.window.show();
      ctx.window.focus();
      if (!ctx.window.webContents.getURL()) {
        try {
          await ctx.window.loadURL(home);
        } catch (cause) {
          if (!isAbortedNavigation(cause)) throw cause;
        }
      }
    },
    isOpen: () =>
      [...contexts.values()].some(
        ({ window, busy }) =>
          busy || (!window.isDestroyed() && window.isVisible()),
      ),
    close() {
      for (const { window } of contexts.values())
        if (!window.isDestroyed()) window.destroy();
      contexts.clear();
    },
  } satisfies NonNullable<AppPorts["keywordWebBrowser"]> & {
    read: NonNullable<AppPorts["read5118PublicKeywords"]>;
  };
}

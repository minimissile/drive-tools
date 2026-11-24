import { BrowserWindow, session } from "electron";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  BaiduDiscoveryPort,
  DiscoverySource,
} from "../shared/baidu-discovery";
import {
  inspectBaiduRelated,
  readBaiduSuggestions,
} from "../core/baidu-discovery-page";
import { AppError } from "../core/errors";
import { createBackgroundBrowserWindow } from "./background-browser-window";

const allowed = (raw: string) => {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["www.baidu.com", "passport.baidu.com", "wappass.baidu.com"].includes(
        url.hostname,
      )
    );
  } catch {
    return false;
  }
};

/** One background Chromium page; revealing it keeps the same workspace session. */
export function createBaiduDiscoverySession(
  workspace: () => string,
): BaiduDiscoveryPort {
  const views = new Map<string, BrowserWindow>();
  let busy = false;
  const view = () => {
    const key = createHash("sha256")
      .update(workspace())
      .digest("hex")
      .slice(0, 24);
    const old = views.get(key);
    if (old && !old.isDestroyed()) return old;
    const profile = session.fromPartition(
      `persist:panxu-baidu-discovery-${key}`,
    );
    profile.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    const win = createBackgroundBrowserWindow({
      width: 1280,
      height: 900,
      title: "百度批量扩词 · 采集窗口",
      webPreferences: {
        session: profile,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.webContents.on("will-navigate", (event, url) => {
      if (!allowed(url)) event.preventDefault();
    });
    win.webContents.on("will-redirect", (event, url, _inPlace, mainFrame) => {
      if (mainFrame && !allowed(url)) event.preventDefault();
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (allowed(url)) void win.loadURL(url).catch(() => {});
      return { action: "deny" };
    });
    win.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    win.on("closed", () => {
      if (views.get(key) === win) views.delete(key);
    });
    views.set(key, win);
    return win;
  };
  const inspect = (
    win: BrowserWindow,
    source: "related" | "people" = "related",
  ) =>
    win.webContents.executeJavaScript(
      `(() => {const __name = fn => fn;return (${inspectBaiduRelated.toString()})(${JSON.stringify(source)})})()`,
    ) as Promise<ReturnType<typeof inspectBaiduRelated>>;
  const check = async (win: BrowserWindow) => {
    if ((await inspect(win)).kind === "verification") {
      throw new AppError(
        "BAIDU_VERIFICATION",
        "百度要求安全验证。请点击“查看异常页”完成验证，再继续采集。",
      );
    }
  };
  async function read(
    source: "search",
    keyword: string,
    signal: AbortSignal,
  ): Promise<{ related: string[]; people: string[] }>;
  async function read(
    source: DiscoverySource,
    keyword: string,
    signal: AbortSignal,
  ): Promise<string[]>;
  async function read(
    source: DiscoverySource | "search",
    keyword: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (busy)
      throw new AppError(
        "BAIDU_BROWSER_BUSY",
        "百度采集窗口正在读取，请稍后继续。",
      );
    const win = view();
    busy = true;
    const timeout = new AbortController();
    const reading = AbortSignal.any([signal, timeout.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (!win.isDestroyed()) win.destroy();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await Promise.race([
        (async () => {
          const url =
            source !== "suggest"
              ? `https://www.baidu.com/s?wd=${encodeURIComponent(keyword)}`
              : "https://www.baidu.com/";
          await win.loadURL(url);
          reading.throwIfAborted();
          await check(win);
          if (source === "suggest") {
            const words = (await win.webContents.executeJavaScript(
              `(() => {const __name = fn => fn;return (${readBaiduSuggestions.toString()})(${JSON.stringify(keyword)})})()`,
            )) as string[];
            reading.throwIfAborted();
            return words;
          }
          await win.webContents.executeJavaScript(
            "window.scrollTo(0,document.documentElement.scrollHeight)",
          );
          if (source === "search") {
            const collected = {
              related: [] as string[],
              people: [] as string[],
            };
            const deadline = Date.now() + 4000;
            do {
              reading.throwIfAborted();
              for (const group of ["related", "people"] as const) {
                if (collected[group].length) continue;
                const data = await inspect(win, group);
                if (data.kind === "verification") await check(win);
                if (data.kind === "ready") collected[group] = data.words;
              }
              if (collected.related.length && collected.people.length) break;
              await delay(400, undefined, { signal: reading });
            } while (Date.now() < deadline);
            return collected;
          }
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            reading.throwIfAborted();
            await check(win);
            const result = await inspect(win);
            if (result.kind === "ready") return result.words;
            await delay(500, undefined, { signal: reading });
          }
          throw new AppError(
            "BAIDU_RELATED_MISSING",
            "未识别到相关搜索模块，可能尚未加载或页面结构已变化。请查看采集窗口后重试，也可以跳过当前词；已采集结果保留。",
          );
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new AppError(
              "BAIDU_BROWSER_TIMEOUT",
              "百度页面加载超时，已保留结果；可点击“查看异常页”检查后继续。",
            );
            timeout.abort(error);
            if (!win.isDestroyed()) win.webContents.stop();
            reject(error);
          }, 45000);
        }),
      ]);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AppError) throw error;
      if (!win.isDestroyed()) await check(win);
      throw new AppError(
        "BAIDU_BROWSER_READ",
        error instanceof Error
          ? error.message
          : "采集窗口已关闭，请重新打开后继续。",
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      busy = false;
    }
  }
  return {
    isOpen: () =>
      busy ||
      [...views.values()].some((win) => !win.isDestroyed() && win.isVisible()),
    async check(signal) {
      signal.throwIfAborted();
      if (busy)
        throw new AppError(
          "BAIDU_BROWSER_BUSY",
          "百度搜索正在处理其他检索，请完成后重试。",
        );
      const win = view();
      busy = true;
      const stop = () => {
        if (!win.isDestroyed()) win.webContents.stop();
      };
      signal.addEventListener("abort", stop, { once: true });
      try {
        if (!win.webContents.getURL())
          await win.loadURL("https://www.baidu.com/");
        signal.throwIfAborted();
        await check(win);
        const ready = await win.webContents.executeJavaScript(
          '!!Array.from(document.querySelectorAll("input[name=wd], #kw")).find(input => !input.disabled && input.getClientRects().length)',
        );
        if (!ready)
          throw new AppError(
            "BAIDU_SEARCH_UNAVAILABLE",
            "百度搜索页面尚不可用，请查看内置浏览器后重试。",
          );
      } finally {
        signal.removeEventListener("abort", stop);
        busy = false;
      }
    },
    async open(keyword) {
      const win = view();
      win.show();
      win.focus();
      if (!win.webContents.getURL())
        await win.loadURL(
          keyword
            ? `https://www.baidu.com/s?wd=${encodeURIComponent(keyword)}`
            : "https://www.baidu.com/",
        );
    },
    read,
    readSearchWords: (keyword, signal) => read("search", keyword, signal),
    close() {
      for (const win of views.values()) if (!win.isDestroyed()) win.destroy();
      views.clear();
    },
  };
}

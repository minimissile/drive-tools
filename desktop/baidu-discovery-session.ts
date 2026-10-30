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

/** One reusable, visible Chromium window; its persistent storage belongs to this workspace. */
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
    const win = new BrowserWindow({
      show: true,
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
  const inspect = (win: BrowserWindow) =>
    win.webContents.executeJavaScript(
      `(() => {const __name = fn => fn;return (${inspectBaiduRelated.toString()})()})()`,
    ) as Promise<ReturnType<typeof inspectBaiduRelated>>;
  const check = async (win: BrowserWindow) => {
    if ((await inspect(win)).kind === "verification") {
      win.show();
      win.focus();
      throw new AppError(
        "BAIDU_VERIFICATION",
        "百度要求安全验证。请在采集窗口手动完成验证，再返回这里点击“继续采集”。",
      );
    }
  };
  return {
    isOpen: () => [...views.values()].some((win) => !win.isDestroyed()),
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
    async read(source: DiscoverySource, keyword, signal) {
      signal.throwIfAborted();
      if (busy)
        throw new AppError(
          "BAIDU_BROWSER_BUSY",
          "百度采集窗口正在读取，请稍后继续。",
        );
      busy = true;
      const win = view();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        if (!win.isDestroyed()) win.destroy();
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        return await Promise.race([
          (async () => {
            const url =
              source === "related"
                ? `https://www.baidu.com/s?wd=${encodeURIComponent(keyword)}`
                : "https://www.baidu.com/";
            await win.loadURL(url);
            signal.throwIfAborted();
            await check(win);
            if (source === "suggest")
              return (await win.webContents.executeJavaScript(
                `(() => {const __name = fn => fn;return (${readBaiduSuggestions.toString()})(${JSON.stringify(keyword)})})()`,
              )) as string[];
            await win.webContents.executeJavaScript(
              "window.scrollTo(0,document.documentElement.scrollHeight)",
            );
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
              signal.throwIfAborted();
              await check(win);
              const result = await inspect(win);
              if (result.kind === "ready") return result.words;
              await delay(500, undefined, { signal });
            }
            throw new AppError(
              "BAIDU_RELATED_MISSING",
              "未识别到相关搜索模块，可能尚未加载或页面结构已变化。请查看采集窗口后重试，也可以跳过当前词；已采集结果保留。",
            );
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              abort();
              reject(
                new AppError(
                  "BAIDU_BROWSER_TIMEOUT",
                  "百度页面加载超时，已保留结果，请检查网络后继续。",
                ),
              );
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
    },
    close() {
      for (const win of views.values()) if (!win.isDestroyed()) win.destroy();
      views.clear();
    },
  };
}

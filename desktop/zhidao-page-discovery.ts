import { BrowserWindow, session } from "electron";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { PageDiscoveryPort } from "../shared/zhidao-page-discovery";
import { allowedDiscoveryUrl } from "../core/zhidao/page-discovery/runner";
import { AppError } from "../core/errors";
import { createBackgroundBrowserWindow } from "./background-browser-window";

/** A dedicated public-reading page. It never borrows an account's cookies or navigates other task windows. */
export function createZhidaoPageDiscovery(
  workspace: () => string,
): PageDiscoveryPort {
  let win: BrowserWindow | undefined;
  let busy = false;
  const allowed = (raw: string) => {
    if (allowedDiscoveryUrl(raw)) return true;
    try {
      const u = new URL(raw);
      return (
        u.protocol === "https:" &&
        !u.port &&
        !u.username &&
        !u.password &&
        ["wappass.baidu.com", "passport.baidu.com"].includes(u.hostname)
      );
    } catch {
      return false;
    }
  };
  const view = () => {
    if (win && !win.isDestroyed()) return win;
    const key = createHash("sha256")
      .update(workspace())
      .digest("hex")
      .slice(0, 24);
    const profile = session.fromPartition(
      `persist:panxu-zhidao-page-discovery-${key}`,
    );
    profile.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    win = createBackgroundBrowserWindow({
      width: 1280,
      height: 900,
      title: "网盘回答发现 · 公开页面读取",
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
      if (allowed(url)) void win!.loadURL(url).catch(() => {});
      return { action: "deny" };
    });
    win.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    return win;
  };
  return {
    isOpen: () => busy || (!!win && !win.isDestroyed() && win.isVisible()),
    async open(url) {
      const target = view();
      target.show();
      target.focus();
      if (!target.webContents.getURL() && url && allowedDiscoveryUrl(url))
        await target.loadURL(url);
    },
    async read(url, signal) {
      if (!allowedDiscoveryUrl(url))
        throw new AppError(
          "DISCOVERY_URL",
          "仅允许读取百度搜索和百度知道问题页。",
        );
      if (busy)
        throw new AppError("DISCOVERY_BUSY", "读取页面正在使用，请稍后继续。");
      signal.throwIfAborted();
      const target = view();
      busy = true;
      const timeout = new AbortController();
      const readingSignal = AbortSignal.any([signal, timeout.signal]);
      const abort = () => {
        if (!target.isDestroyed()) target.webContents.stop();
      };
      signal.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            await target.loadURL(url);
            readingSignal.throwIfAborted();
            if (new URL(url).pathname === "/s") {
              const deadline = Date.now() + 10000;
              let ready = false;
              while (Date.now() < deadline) {
                readingSignal.throwIfAborted();
                const status = (await target.webContents.executeJavaScript(
                  "({title:document.title,results:!!document.querySelector('#content_left h3 a, #content_left .result h3, #content_left .result-op h3'),empty:/抱歉.{0,80}(没有找到|未找到)|(没有找到|未找到).{0,50}(结果|网页)/.test(document.body?.innerText||'')})",
                )) as { title: string; results: boolean; empty: boolean };
                if (
                  /安全验证|访问验证|验证码/.test(status.title) ||
                  status.results ||
                  status.empty
                ) {
                  ready = true;
                  break;
                }
                await delay(300, undefined, { signal: readingSignal });
              }
              if (!ready)
                throw new AppError(
                  "DISCOVERY_SEARCH_STRUCTURE",
                  "搜索结果尚未加载或结构未识别，已暂停；请查看读取页面后继续。",
                );
            }
            const reading = (await target.webContents.executeJavaScript(
              "({body:document.documentElement.outerHTML,url:location.href,title:document.title})",
            )) as { body: string; url: string; title: string };
            if (
              /安全验证|访问验证|验证码/.test(reading.title) ||
              !allowedDiscoveryUrl(reading.url)
            )
              throw new AppError(
                "DISCOVERY_VERIFICATION",
                "页面要求安全验证或限制访问，请查看异常页，完成后手动继续。",
              );
            if (reading.body.length > 4_000_000)
              throw new AppError("DISCOVERY_TOO_LARGE", "页面过大，已跳过。");
            return { body: reading.body, url: reading.url };
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              timeout.abort();
              abort();
              reject(
                new AppError(
                  "DISCOVERY_EMPTY_RESPONSE",
                  "页面读取超时，已保留进度，可查看异常页后继续。",
                ),
              );
            }, 30000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        busy = false;
      }
    },
    close() {
      if (win && !win.isDestroyed()) win.destroy();
      win = undefined;
    },
  };
}

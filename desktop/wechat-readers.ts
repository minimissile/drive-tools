import { BrowserWindow, type Session } from "electron";
import type { BrowserContext } from "playwright-core";
import { findEnvironmentPage } from "../core/browser-pages";
import { websiteNavigationAllowed } from "./website-session-policy";
import { AppError } from "../core/errors";

export interface WechatReader {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  executeJavaScript(script: string): Promise<unknown>;
  isDestroyed(): boolean;
  destroy(): Promise<void>;
  show(): Promise<void>;
}
export interface WechatReaderContext {
  window?: WechatReader;
  reader(show?: boolean): Promise<WechatReader>;
  flush(): Promise<void>;
  observe(invalidate: () => void): void;
}
export type NativeWechatContext = { profile: Session; window?: BrowserWindow };

export function nativeWechatContext(
  ctx: NativeWechatContext,
): WechatReaderContext {
  const windows = new WeakMap<WechatReader, BrowserWindow>();
  const wrap = (win: BrowserWindow): WechatReader => {
    const reader: WechatReader = {
      loadURL: (url) => win.loadURL(url),
      getURL: () => win.webContents.getURL(),
      executeJavaScript: (script) => win.webContents.executeJavaScript(script),
      isDestroyed: () => win.isDestroyed(),
      destroy: async () => {
        if (!win.isDestroyed()) win.destroy();
      },
      show: async () => {
        win.show();
        win.focus();
      },
    };
    windows.set(reader, win);
    return reader;
  };
  return {
    get window() {
      return ctx.window && !ctx.window.isDestroyed()
        ? wrap(ctx.window)
        : undefined;
    },
    set window(value) {
      ctx.window = value ? windows.get(value) : undefined;
    },
    flush: () => ctx.profile.cookies.flushStore(),
    observe(invalidate) {
      ctx.profile.cookies.on("changed", (_event, cookie) => {
        if (
          /(^|\.)weixin\.qq\.com$/.test(cookie.domain ?? "") &&
          /^(slave_sid|slave_user|bizuin)$/.test(cookie.name)
        )
          invalidate();
      });
    },
    async reader(show = false) {
      const win = new BrowserWindow({
        show,
        width: 1280,
        height: 900,
        title: "微信公众号 · 草稿箱",
        webPreferences: {
          session: ctx.profile,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (show && websiteNavigationAllowed("wechat", url))
          void win.loadURL(url).catch(() => {});
        return { action: "deny" };
      });
      win.webContents.on("will-navigate", (event) => {
        if (!websiteNavigationAllowed("wechat", event.url))
          event.preventDefault();
      });
      win.webContents.on("will-redirect", (event) => {
        if (event.isMainFrame && !websiteNavigationAllowed("wechat", event.url))
          event.preventDefault();
      });
      return wrap(win);
    },
  };
}

export function bitWechatContext(
  context: BrowserContext,
  accountId: string,
): WechatReaderContext {
  return {
    flush: async () => {}, // Persistence belongs to the existing BitBrowser profile.
    observe: () => {}, // Every explicit verification and write reads the actual identity again.
    async reader(show = false) {
      const page = show
        ? await findEnvironmentPage(
            context,
            `panxu:wechat:${accountId}`,
            "https://mp.weixin.qq.com/",
          )
        : await context.newPage();
      const guard = async (route: import("playwright-core").Route) => {
        const request = route.request();
        if (
          request.isNavigationRequest() &&
          request.frame() === page.mainFrame() &&
          !websiteNavigationAllowed("wechat", request.url())
        )
          return route.abort();
        await route.fallback();
      };
      await page.route("**/*", guard);
      return {
        async loadURL(url) {
          if (!websiteNavigationAllowed("wechat", url))
            throw new AppError("WECHAT_PAGE_URL", "请使用公众号官方后台地址。");
          const response = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          if (new URL(page.url()).protocol === "chrome-extension:")
            throw new AppError(
              "WECHAT_BIT_ACCESS_BLOCKED",
              "比特浏览器扩展拦截了公众号后台。请在比特客户端完成实名认证并升级客户端，再在原环境重试；盘序不会改用内置浏览器。",
            );
          if (
            !response?.ok() ||
            !websiteNavigationAllowed("wechat", page.url())
          )
            throw new AppError(
              "WECHAT_PAGE_LOAD",
              "公众号后台加载失败，请在关联的比特环境中完成登录或验证后重试。",
            );
        },
        getURL: () => page.url(),
        executeJavaScript: (script) => page.evaluate(script),
        isDestroyed: () => page.isClosed(),
        destroy: async () => {
          await page.close().catch(() => {});
        },
        show: async () => {
          await page.unroute("**/*", guard);
          await page.bringToFront();
        },
      };
    },
  };
}

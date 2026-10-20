import { BrowserWindow, session } from "electron";
import { AppError } from "../core/errors";
import { readLimited } from "../core/http";
import type { AppPorts } from "../core/ports";

export function createZhidaoSession(): NonNullable<AppPorts["zhidaoSession"]> {
  const windows = new Map<string, BrowserWindow>();
  const profile = (id: string) => {
    if (!/^zd_[\w-]+$/.test(id))
      throw new AppError("INVALID_ACCOUNT", "知道账号ID不正确。");
    return session.fromPartition(`persist:panxu-zhidao-${id}`);
  };
  const close = async (id: string) => {
    const win = windows.get(id);
    if (win && !win.isDestroyed()) win.close();
    windows.delete(id);
  };
  return {
    isOpen: () => windows.size > 0,
    async login(id) {
      const old = windows.get(id);
      if (old && !old.isDestroyed()) {
        old.show();
        old.focus();
        return;
      }
      const win = new BrowserWindow({
        width: 1050,
        height: 800,
        title: "百度知道 · 登录与安全验证",
        webPreferences: {
          session: profile(id),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      windows.set(id, win);
      const allowed = (url: string) => {
        try {
          const u = new URL(url);
          return (
            u.protocol === "https:" &&
            [
              "zhidao.baidu.com",
              "passport.baidu.com",
              "wappass.baidu.com",
            ].includes(u.hostname)
          );
        } catch {
          return false;
        }
      };
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (allowed(url)) void win.loadURL(url);
        return { action: "deny" };
      });
      win.webContents.on("will-navigate", (event, url) => {
        if (!allowed(url)) event.preventDefault();
      });
      win.webContents.session.setPermissionRequestHandler((_c, _p, callback) =>
        callback(false),
      );
      win.on("closed", () => windows.delete(id));
      await win.loadURL("https://zhidao.baidu.com/");
    },
    close,
    async clear(id) {
      await close(id);
      await profile(id).clearStorageData();
      await profile(id).clearCache();
    },
    async setCookie(id, cookie) {
      for (const pair of cookie.split(";")) {
        const index = pair.indexOf("=");
        if (index < 1) continue;
        const name = pair.slice(0, index).trim(),
          value = pair.slice(index + 1).trim();
        if (!/^[\w-]+$/.test(name))
          throw new AppError("INVALID_COOKIE", "Cookie字段不正确。");
        await profile(id).cookies.set({
          url: "https://zhidao.baidu.com",
          domain: ".baidu.com",
          path: "/",
          name,
          value,
          secure: true,
        });
      }
    },
    async request(id, url, init = {}) {
      const u = new URL(url);
      if (
        u.origin !== "https://zhidao.baidu.com" ||
        u.username ||
        u.password ||
        u.hash
      )
        throw new AppError("ZHIDAO_URL_BLOCKED", "知道请求不属于允许的地址。");
      const response = await profile(id).fetch(url, {
        ...init,
        redirect: "error",
        credentials: "include",
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(45000)])
          : AbortSignal.timeout(45000),
        headers: {
          Referer: "https://zhidao.baidu.com/",
          "Accept-Language": "zh-CN,zh;q=0.9",
          ...init.headers,
        },
      });
      return {
        status: response.status,
        body: await readLimited(response, 4_000_000),
      };
    },
  };
}

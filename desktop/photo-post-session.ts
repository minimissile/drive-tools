import { BrowserWindow, session } from "electron";
import { createHash } from "node:crypto";
import { platformSpecs } from "../shared/platforms";
import { photoPlatformNames, type PhotoPlatform } from "../shared/photo-posts";
import { isAbortedNavigation } from "./website-session-policy";
/** One disk-backed official website session per workspace and platform. */
export function createPhotoPostSessions(workspace: () => string) {
  const windows = new Map<string, BrowserWindow>();
  const allowed = (platform: PhotoPlatform, value: string) => {
    try {
      const u = new URL(value),
        host =
          platform === "xiaohongshu"
            ? "xiaohongshu.com"
            : platform === "douyin"
              ? "douyin.com"
              : "kuaishou.com";
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.port &&
        (u.hostname === host ||
          u.hostname.endsWith(`.${host}`) ||
          u.hostname === "open.weixin.qq.com")
      );
    } catch {
      return false;
    }
  };
  return {
    isOpen: () => [...windows.values()].some((w) => !w.isDestroyed()),
    close: () => {
      for (const win of windows.values()) if (!win.isDestroyed()) win.destroy();
      windows.clear();
    },
    async open(platform: PhotoPlatform) {
      const key = createHash("sha256")
          .update(`${workspace()}\0${platform}`)
          .digest("hex")
          .slice(0, 24),
        existing = windows.get(key);
      if (existing && !existing.isDestroyed()) {
        existing.show();
        existing.focus();
        return;
      }
      const profile = session.fromPartition(`persist:panxu-photo-posts-${key}`);
      profile.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      const win = new BrowserWindow({
        width: 1200,
        height: 820,
        minWidth: 1000,
        minHeight: 700,
        title: `图文营销 · ${photoPlatformNames[platform]} · 官方发布`,
        webPreferences: {
          session: profile,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      windows.set(key, win);
      win.on("closed", () => {
        if (windows.get(key) === win) windows.delete(key);
        profile.flushStorageData();
        void profile.cookies.flushStore().catch(() => {});
      });
      win.webContents.on("will-navigate", (event, url) => {
        if (!allowed(platform, url)) event.preventDefault();
      });
      win.webContents.on("will-redirect", (event, url) => {
        if (!allowed(platform, url)) event.preventDefault();
      });
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (allowed(platform, url)) void win.loadURL(url).catch(() => {});
        return { action: "deny" };
      });
      try {
        await win.loadURL(
          platformSpecs.find((p) => p.id === platform)!.defaultUrl,
        );
      } catch (error) {
        if (!isAbortedNavigation(error)) throw error;
      }
    },
  };
}

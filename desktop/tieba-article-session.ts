import { BrowserWindow, session } from "electron";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "../core/errors";
import { tiebaBaiduMiniAppShare } from "../shared/tieba-article-links";
import {
  tiebaArticleImageHosts,
  tiebaArticleUrl,
  type WechatTiebaImportSource,
} from "../shared/wechat";
import {
  readTiebaArticle,
  type TiebaArticleReading,
} from "./tieba-article-page";
import { readPublicTiebaArticle } from "./tieba-article-source";
import { websiteNavigationAllowed } from "./website-session-policy";

const readMessages = {
  "wrong-page": "贴吧未打开原帖，请核对链接后重试。",
  missing: "贴吧原帖不存在或已删除。",
  empty: "贴吧主帖没有可导入的文字或图片。",
  "too-large": "贴吧主帖内容过长，请摘取需要的部分后使用。",
};

export function createTiebaArticleSession() {
  let reader: { window: BrowserWindow; verificationUrl?: string } | undefined;

  function openReader() {
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 850,
      title: "百度贴吧 · 采集原帖",
      webPreferences: {
        session: session.fromPartition("panxu-public-tieba-article"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const allowed = (url: string) => websiteNavigationAllowed("tieba", url);
    win.webContents.session.setPermissionRequestHandler((_, __, done) =>
      done(false),
    );
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (win.isVisible() && allowed(url))
        void win.loadURL(url).catch(() => {});
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event) => {
      if (!allowed(event.url)) event.preventDefault();
    });
    win.webContents.on("will-redirect", (event) => {
      if (event.isMainFrame && !allowed(event.url)) event.preventDefault();
    });
    win.on("closed", () => {
      if (reader?.window === win) reader = undefined;
    });
    return win;
  }

  return {
    isOpen: () => !!reader && !reader.window.isDestroyed(),
    async readArticle(rawUrl: string): Promise<WechatTiebaImportSource> {
      const url = tiebaArticleUrl.parse(rawUrl);
      if (reader?.verificationUrl !== url) {
        const publicSource = await readPublicTiebaArticle(url).catch(
          () => null,
        );
        if (publicSource) {
          if (reader && !reader.window.isDestroyed()) reader.window.destroy();
          return publicSource;
        }
      }
      const previous =
        reader && !reader.window.isDestroyed() ? reader.window : undefined;
      const win = previous ?? openReader();
      let keepOpen = false;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        if (!win.isDestroyed()) win.destroy();
      }, 30000);
      const read = async (): Promise<TiebaArticleReading> => {
        if (!websiteNavigationAllowed("tieba", win.webContents.getURL()))
          return { status: "wrong-page" };
        return win.webContents.executeJavaScriptInIsolatedWorld(1001, [
          {
            code: `(${readTiebaArticle.toString()})(${JSON.stringify(url)},${JSON.stringify(tiebaArticleImageHosts)},(${tiebaBaiduMiniAppShare.toString()}))`,
          },
        ]);
      };
      try {
        // A completed manual verification may already have returned to the exact original post.
        let result = previous ? await read() : undefined;
        if (result?.status !== "read") {
          let loadFailed = false;
          try {
            await win.loadURL(url);
          } catch {
            loadFailed = true;
          }
          result = await read();
          if (
            loadFailed &&
            result.status !== "read" &&
            result.status !== "challenge" &&
            result.status !== "missing"
          )
            throw new AppError(
              "TIEBA_ARTICLE_LOAD",
              "贴吧原帖加载失败，请检查网络或打开原帖确认后重试。",
            );
        }
        for (
          let attempt = 0;
          result.status === "not-ready" && attempt < 15;
          attempt++
        ) {
          await delay(400);
          result = await read();
        }
        if (result.status === "read") return result.source;
        if (result.status === "challenge" || result.status === "not-ready") {
          const needsVerification = result.status === "challenge";
          reader = {
            window: win,
            verificationUrl: needsVerification ? url : undefined,
          };
          keepOpen = true;
          win.setTitle(
            needsVerification ? "百度贴吧 · 请完成验证" : "百度贴吧 · 查看原帖",
          );
          win.show();
          win.focus();
          throw new AppError(
            needsVerification ? "TIEBA_ARTICLE_VERIFY" : "TIEBA_ARTICLE_READ",
            needsVerification
              ? "贴吧要求验证或登录。请在已打开的官方窗口完成操作，再点击“导入到本地草稿”。"
              : "已打开贴吧原帖。请等主楼正文显示后，回到草稿箱再点“导入到本地草稿”。",
          );
        }
        throw new AppError("TIEBA_ARTICLE_READ", readMessages[result.status]);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          "TIEBA_ARTICLE_LOAD",
          timedOut
            ? "贴吧原帖加载超时，请稍后重试。"
            : "贴吧页面读取失败，请打开原帖确认后重试。",
        );
      } finally {
        clearTimeout(timeout);
        if (!keepOpen && !win.isDestroyed()) win.destroy();
      }
    },
  };
}

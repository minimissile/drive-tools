import { BrowserWindow, session, type Session } from "electron";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { AppPorts } from "../core/ports";
import type { ShareInspection } from "../shared/types";
import { AppError } from "../core/errors";
import { createBackgroundBrowserWindow } from "./background-browser-window";
import {
  enterBaiduShareCode,
  inspectBaiduSharePage,
  readBaiduShareDirectory,
} from "./baidu-share-page";

const allowed = (raw: string) => {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["pan.baidu.com", "passport.baidu.com", "wappass.baidu.com"].includes(
        url.hostname,
      )
    );
  } catch {
    return false;
  }
};
const listSchema = z.object({
  list: z
    .array(
      z.object({
        fs_id: z.union([z.string().min(1), z.number().int()]),
        server_filename: z.string().min(1).max(2000),
        isdir: z.union([
          z.boolean(),
          z.literal(0),
          z.literal(1),
          z.literal("0"),
          z.literal("1"),
        ]),
        size: z.union([z.string(), z.number(), z.null()]).optional(),
        path: z.string().max(8000).optional(),
      }),
    )
    .max(100),
});
type Context = {
  window: BrowserWindow;
  source: string;
  meta?: { shareId: string; uk: string; title: string };
};
const script = (fn: Function, input?: unknown) =>
  `(() => {const __name = fn => fn; return (${fn.toString()})(${input === undefined ? "" : JSON.stringify(input)})})()`;

/** This reader always uses its own Electron session, independently of drive accounts. */
export function createBaiduShareReader(
  workspace: () => string,
): NonNullable<AppPorts["baiduShareReader"]> {
  const contexts = new Map<string, Context>();
  const securedProfiles = new WeakSet<Session>();
  let busy = false;
  const workspaceKey = () =>
    createHash("sha256").update(workspace()).digest("hex").slice(0, 24);
  const context = () => {
    const key = workspaceKey();
    const existing = contexts.get(key);
    if (existing && !existing.window.isDestroyed()) return existing;
    const profile = session.fromPartition(
      `persist:panxu-baidu-share-reader-${key}`,
    );
    profile.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    if (!securedProfiles.has(profile)) {
      profile.on("will-download", (event) => event.preventDefault());
      securedProfiles.add(profile);
    }
    const win = createBackgroundBrowserWindow({
      width: 1200,
      height: 850,
      title: "资源包目录 · 内置浏览器",
      webPreferences: {
        session: profile,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.webContents.on("page-title-updated", (event) => {
      event.preventDefault();
      win.setTitle("资源包目录 · 内置浏览器");
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
    const ctx: Context = { window: win, source: "" };
    contexts.set(key, ctx);
    win.on("closed", () => {
      if (contexts.get(key) === ctx) contexts.delete(key);
    });
    return ctx;
  };
  const metadata = async (ctx: Context, code: string, signal: AbortSignal) => {
    const win = ctx.window;
    const deadline = Date.now() + 25000;
    let entered = false;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (win.isDestroyed())
        throw new AppError(
          "SHARE_BROWSER_CLOSED",
          "内置读取窗口已关闭，请重新读取。",
        );
      let state: ReturnType<typeof inspectBaiduSharePage>;
      try {
        state = await win.webContents.executeJavaScript(
          script(inspectBaiduSharePage),
        );
      } catch {
        signal.throwIfAborted();
        await delay(300, undefined, { signal });
        continue;
      }
      signal.throwIfAborted();
      if (state.kind === "ready") return state;
      if (state.kind === "expired")
        throw new AppError(
          "SHARE_EXPIRED",
          "分享已失效或不可访问，请检查链接。",
        );
      if (state.kind === "bad-code")
        throw new AppError("BAD_CODE", "百度网盘提取码不正确，请检查后重试。");
      if (state.kind === "verification")
        throw new AppError(
          "SHARE_VERIFICATION",
          "百度要求安全验证，请点击“查看异常页面”手动完成后重试。",
        );
      if (state.kind === "login")
        throw new AppError(
          "SHARE_LOGIN",
          "百度要求登录，请点击“查看异常页面”登录后重试。",
        );
      if (state.kind === "password" && !entered) {
        if (!code)
          throw new AppError(
            "SHARE_CODE_REQUIRED",
            "此分享需要提取码，请在链接后补充提取码。",
          );
        entered = await win.webContents.executeJavaScript(
          script(enterBaiduShareCode, code),
        );
      }
      await delay(400, undefined, { signal });
    }
    throw new AppError(
      "SHARE_PAGE_UNREADY",
      "尚未识别到分享目录，请查看内置读取窗口，完成提取码或页面提示后重试。",
    );
  };
  return {
    isOpen: () =>
      busy ||
      [...contexts.values()].some(
        (ctx) => !ctx.window.isDestroyed() && ctx.window.isVisible(),
      ),
    async open() {
      const ctx = contexts.get(workspaceKey());
      if (!ctx || ctx.window.isDestroyed())
        throw new AppError(
          "SHARE_BROWSER_CLOSED",
          "读取会话已结束，请重新读取包内名称。",
        );
      ctx.window.show();
      ctx.window.focus();
    },
    async inspect(source, parentId, page): Promise<ShareInspection> {
      if (busy)
        throw new AppError(
          "SHARE_BROWSER_BUSY",
          "内置读取窗口正被其他任务使用，请稍后重试。",
        );
      const ctx = context();
      busy = true;
      const win = ctx.window;
      const identity = `${source.shareKey}:${source.code}`;
      const controller = new AbortController();
      const signal = controller.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            if (ctx.source !== identity || !win.webContents.getURL()) {
              ctx.source = identity;
              ctx.meta = undefined;
              const url = new URL(source.url);
              if (source.code) url.searchParams.set("pwd", source.code);
              try {
                await win.loadURL(url.href);
              } catch (cause) {
                if (!(
                  cause instanceof Error &&
                  cause.message.includes("ERR_ABORTED")
                ))
                  throw cause;
              }
            }
            signal.throwIfAborted();
            if (
              !ctx.meta ||
              !win.webContents.getURL().startsWith("https://pan.baidu.com/")
            )
              ctx.meta = await metadata(ctx, source.code, signal);
            const raw = await win.webContents.executeJavaScript(
              script(readBaiduShareDirectory, {
                shareId: ctx.meta.shareId,
                uk: ctx.meta.uk,
                parentId,
                page,
              }),
            );
            signal.throwIfAborted();
            const errno = Number(raw?.errno ?? raw?.error_code ?? 0);
            if (errno) {
              ctx.meta = undefined;
              throw new AppError(
                "SHARE_DIRECTORY_ERROR",
                `百度目录读取未完成（${errno}），请查看内置读取窗口后重试。`,
              );
            }
            const parsed = listSchema.safeParse(raw);
            if (!parsed.success)
              throw new AppError(
                "SHARE_DIRECTORY_CHANGED",
                "内置浏览器未取得有效目录数据，请查看读取窗口后重试。",
              );
            return {
              shareKey: source.shareKey,
              title: ctx.meta.title,
              files: parsed.data.list.map((file) => ({
                id: String(file.fs_id),
                name: file.server_filename,
                isDirectory: [true, 1, "1"].includes(file.isdir),
                size: file.size == null ? null : Number(file.size),
                parentId,
                path: file.path,
              })),
              hasMore: parsed.data.list.length === 100,
              page,
              parentId,
            };
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              const error = new AppError(
                "SHARE_BROWSER_TIMEOUT",
                "后台读取超时，页面已保留；可点击“查看异常页面”检查后重试。",
              );
              controller.abort(error);
              if (!win.isDestroyed()) win.webContents.stop();
              reject(error);
            }, 45000);
          }),
        ]);
      } catch (cause) {
        if (cause instanceof AppError) throw cause;
        throw new AppError(
          "SHARE_BROWSER_READ",
          "后台读取未完成，可点击“查看异常页面”检查后重试。",
        );
      } finally {
        clearTimeout(timer);
        busy = false;
      }
    },
    close(force = false) {
      if (busy && !force)
        throw new AppError(
          "SHARE_BROWSER_BUSY",
          "正在读取目录，请先停止或等待读取完成。",
        );
      for (const ctx of contexts.values())
        if (!ctx.window.isDestroyed()) ctx.window.destroy();
      contexts.clear();
    },
  };
}

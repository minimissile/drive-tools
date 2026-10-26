import { BrowserWindow, session, type Session } from "electron";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type {
  WebsiteAccount,
  WebsiteSessionState,
} from "../shared/website-accounts";
import { websiteAccountIdSchema } from "../shared/website-accounts";
import { AppError } from "../core/errors";
import { WeiboPublisher } from "./weibo-publisher";
import type { WeiboEditorPayload } from "../shared/weibo-publishing";
import { weiboReceiptUrl } from "../shared/weibo-marketing";
import {
  readWeiboViewer,
  weiboViewerScript,
  type WeiboViewerResponse,
} from "./weibo-identity";
import {
  isAbortedNavigation,
  websiteNavigationAllowed,
} from "./website-session-policy";

type Identity = { uid: string; nickname: string | null };
type Context = {
  profile: Session;
  window?: BrowserWindow;
  verifier?: BrowserWindow;
  identity: Identity | null;
  knownUid: string | null;
  signature: string | null;
  cookieSignature?: string | null;
  checkedAt: string | null;
  error: string | null;
  expired: boolean;
  loadFailed: boolean;
  revision: number;
  timer?: ReturnType<typeof setTimeout>;
  pending?: Promise<WebsiteSessionState>;
  receipts: Map<string, BrowserWindow>;
};
/** Official website sessions stay in Electron; only the confirmed identity crosses the port. */
export function createWeiboSessions(workspace: () => string, environmentProfile?: (account: WebsiteAccount) => Session) {
  const contexts = new Map<string, Context>();
  const context = (account: WebsiteAccount) => {
    const partition = environmentProfile?.(account);
    const key = createHash("sha256")
      .update(
        `${workspace()}\0weibo\0${websiteAccountIdSchema.parse(account.id)}${partition ? `\0${partition.getStoragePath()}` : ""}`,
      )
      .digest("hex")
      .slice(0, 24);
    const old = contexts.get(key);
    if (old) return old;
    const profile = partition ?? session.fromPartition(`persist:panxu-weibo-${key}`);
    const ctx: Context = {
      profile,
      identity: null,
      knownUid: account.uid,
      signature: null,
      checkedAt: null,
      error: null,
      expired: false,
      loadFailed: false,
      revision: 0,
      receipts: new Map(),
    };
    profile.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    profile.cookies.on("changed", (_event, cookie, cause, removed) => {
      if (
        cookie.name !== "SUB" ||
        !/(^|\.)weibo\.com$/.test(cookie.domain ?? "")
      )
        return;
      // A refresh can emit an overwrite-removal plus an unchanged value; that is not an account switch.
      if (removed && cause === "overwrite") return;
      const next = removed
        ? null
        : createHash("sha256").update(cookie.value).digest("hex");
      if (next === ctx.cookieSignature) return;
      ctx.cookieSignature = next;
      ctx.revision++;
      ctx.identity = null;
      ctx.signature = null;
      if (!environmentProfile) schedule(account, ctx);
    });
    contexts.set(key, ctx);
    return ctx;
  };
  const signature = async (ctx: Context) => {
    const token = (
      await ctx.profile.cookies.get({ url: "https://weibo.com/", name: "SUB" })
    )[0]?.value;
    const value = token
      ? createHash("sha256").update(token).digest("hex")
      : null;
    if (ctx.cookieSignature === undefined) ctx.cookieSignature = value;
    return value;
  };
  const status = async (
    account: WebsiteAccount,
  ): Promise<WebsiteSessionState> => {
    const ctx = context(account),
      auth = await signature(ctx);
    const valid = !!auth && auth === ctx.signature && !!ctx.identity;
    return {
      hasSession: valid,
      uid: valid ? ctx.identity!.uid : null,
      nickname: valid ? ctx.identity!.nickname : null,
      checkedAt: ctx.checkedAt,
      windowOpen: !!ctx.window && !ctx.window.isDestroyed(),
      expired: ctx.expired || (!auth && !!(account.uid || ctx.knownUid)),
      checking: !!ctx.pending,
      error:
        (ctx.loadFailed || auth ? ctx.error : null) ||
        (!valid && auth && !ctx.pending
          ? "请点击检查登录，向微博核实当前账号身份。"
          : null),
    };
  };
  const probeViewer = async (ctx: Context): Promise<WeiboViewerResponse> => {
    // A fresh homepage establishes the current viewer even when website AJAX paths change.
    // Keep the user's visible window, navigation and unsaved text untouched.
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 840,
      webPreferences: {
        session: ctx.profile,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    ctx.verifier = win;
    let httpStatus = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => {
      if (!websiteNavigationAllowed("weibo", event.url)) event.preventDefault();
    });
    win.webContents.on("will-redirect", (event) => {
      if (event.isMainFrame && !websiteNavigationAllowed("weibo", event.url))
        event.preventDefault();
    });
    win.webContents.on("did-navigate", (_event, _url, code) => {
      httpStatus = code;
    });
    try {
      return await Promise.race([
        (async (): Promise<WeiboViewerResponse> => {
          try {
            await win.loadURL("https://weibo.com/", {
              extraHeaders: "Cache-Control: no-cache",
            });
          } catch (error) {
            if (!isAbortedNavigation(error)) throw error;
            if (!win.isDestroyed() && win.webContents.isLoadingMainFrame())
              await once(win.webContents, "did-stop-loading", {
                signal: AbortSignal.timeout(15000),
              });
          }
          if (win.isDestroyed() || httpStatus < 200 || httpStatus >= 400)
            return { status: httpStatus, kind: "unknown" };
          const value =
            await win.webContents.executeJavaScript(weiboViewerScript);
          if (value?.kind === "guest")
            return { status: httpStatus, kind: "guest" };
          const viewer =
            value?.kind === "identity" ? readWeiboViewer(value.identity) : null;
          return viewer?.kind === "identity"
            ? { status: httpStatus, ...viewer }
            : { status: httpStatus, kind: "unknown" };
        })(),
        new Promise<WeiboViewerResponse>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("weibo-viewer-timeout")),
            20000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (!win.isDestroyed()) win.destroy();
      if (ctx.verifier === win) ctx.verifier = undefined;
    }
  };
  const verify = (account: WebsiteAccount): Promise<WebsiteSessionState> => {
    const ctx = context(account);
    if (ctx.pending) return ctx.pending;
    const revision = ctx.revision;
    ctx.pending = (async () => {
      try {
        const auth = await signature(ctx);
        if (revision !== ctx.revision) throw new Error("session-changed");
        if (!auth) {
          ctx.identity = null;
          ctx.signature = null;
          ctx.expired = !!(account.uid || ctx.knownUid);
          ctx.error = null;
          return await status(account);
        }
        const viewer = await probeViewer(ctx);
        if (revision !== ctx.revision || auth !== (await signature(ctx)))
          throw new Error("session-changed");
        if (viewer.kind === "guest") {
          ctx.identity = null;
          ctx.signature = null;
          ctx.expired = !!(account.uid || ctx.knownUid);
          ctx.checkedAt = new Date().toISOString();
          ctx.error = null;
          return await status(account);
        }
        if (viewer.kind !== "identity") {
          console.warn("[微博登录核验] 官网身份响应暂不可识别", {
            httpStatus: viewer.status,
          });
          throw new Error("unrecognized-response");
        }
        const identity = viewer.identity;
        if (revision !== ctx.revision || auth !== (await signature(ctx)))
          throw new Error("session-changed");
        ctx.identity = identity;
        ctx.knownUid = identity.uid;
        ctx.signature = auth;
        ctx.checkedAt = new Date().toISOString();
        ctx.expired = false;
        ctx.error = null;
      } catch {
        if (revision === ctx.revision) {
          ctx.identity = null;
          ctx.signature = null;
          ctx.error =
            "暂时未能识别微博网页会话。请检查网络；如官方页面要求安全验证，请在原窗口完成后重试。现有登录会话已保留，无需移除账号。";
        }
      }
      return status(account);
    })().finally(() => {
      ctx.pending = undefined;
      if (revision !== ctx.revision && ctx.window && !ctx.window.isDestroyed())
        schedule(account, ctx);
    });
    return ctx.pending;
  };
  const schedule = (account: WebsiteAccount, ctx: Context) => {
    if (environmentProfile) return;
    if (ctx.timer) clearTimeout(ctx.timer);
    ctx.timer = setTimeout(() => {
      ctx.timer = undefined;
      if (ctx.window && !ctx.window.isDestroyed() && !ctx.identity)
        void verify(account);
    }, 1200);
  };
  const login = async (account: WebsiteAccount) => {
    const ctx = context(account);
    if (ctx.window && !ctx.window.isDestroyed()) {
      ctx.window.show();
      ctx.window.focus();
      if (ctx.loadFailed) {
        ctx.error = null;
        ctx.loadFailed = false;
        try {
          await ctx.window.loadURL("https://weibo.com/");
        } catch (error) {
          if (!isAbortedNavigation(error))
            throw new AppError(
              "WEIBO_LOGIN_LOAD_FAILED",
              "微博官方页面加载失败，请重试打开。",
            );
        }
      }
      return;
    }
    const win = new BrowserWindow({
      width: 1280,
      height: 840,
      title: `微博 · ${account.alias}`,
      webPreferences: {
        session: ctx.profile,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    ctx.window = win;
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (websiteNavigationAllowed("weibo", url))
        void win.loadURL(url).catch((error) => {
          if (!isAbortedNavigation(error))
            ctx.error = "微博页面未能打开，请重新打开登录窗口。";
        });
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event) => {
      if (!websiteNavigationAllowed("weibo", event.url)) event.preventDefault();
    });
    win.webContents.on("will-redirect", (event) => {
      if (event.isMainFrame && !websiteNavigationAllowed("weibo", event.url))
        event.preventDefault();
    });
    win.webContents.on("did-finish-load", () => {
      if (!websiteNavigationAllowed("weibo", win.webContents.getURL())) return;
      if (ctx.loadFailed) ctx.error = null;
      ctx.loadFailed = false;
      schedule(account, ctx);
    });
    win.webContents.on("did-navigate-in-page", () => schedule(account, ctx));
    win.webContents.on(
      "did-fail-load",
      (_event, code, _description, _url, main) => {
        if (main && code !== -3) {
          ctx.loadFailed = true;
          ctx.error = "微博官方页面加载失败，请检查网络并重新打开登录窗口。";
        }
      },
    );
    win.on("closed", () => {
      if (ctx.window === win) ctx.window = undefined;
      if (ctx.timer) clearTimeout(ctx.timer);
      ctx.timer = undefined;
    });
    ctx.error = null;
    try {
      await win.loadURL("https://weibo.com/");
    } catch (error) {
      if (!isAbortedNavigation(error))
        throw new AppError(
          "WEIBO_LOGIN_LOAD_FAILED",
          ctx.error || "微博官方页面加载失败，请重试打开。",
        );
    }
  };
  const publisher = (account: WebsiteAccount, payload: WeiboEditorPayload) => new WeiboPublisher(
    async () => { await login(account); return context(account).window!; },
    async () => {
      const state = await verify(account);
      if (!state.hasSession || state.uid !== payload.uid) throw new AppError("WEIBO_ACCOUNT_MISMATCH", "当前微博身份与发布任务不一致，请检查登录。");
    },
  );
  return {
    publisher: {
      prepare: (account: WebsiteAccount, payload: WeiboEditorPayload) => publisher(account, payload).prepare(payload),
      submit: (account: WebsiteAccount, payload: WeiboEditorPayload, before: () => Promise<void>) => publisher(account, payload).submit(payload, before),
    },
    isOpen: () =>
      [...contexts.values()].some(
        (ctx) => !!ctx.pending || !!(ctx.window && !ctx.window.isDestroyed()) || [...ctx.receipts.values()].some((window) => !window.isDestroyed()),
      ),
    login,
    status,
    verify,
    async openPost(account: WebsiteAccount, rawUrl: string) {
      const url = weiboReceiptUrl(rawUrl, account.uid!);
      const ctx = context(account);
      const existing = ctx.receipts.get(url);
      if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return; }
      const reader = new BrowserWindow({ width: 1280, height: 840, title: `微博回执 · ${account.alias}`, webPreferences: { session: ctx.profile, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      ctx.receipts.set(url, reader);
      reader.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      reader.webContents.on("will-navigate", (event) => { if (!websiteNavigationAllowed("weibo", event.url)) event.preventDefault(); });
      reader.webContents.on("will-redirect", (event) => { if (event.isMainFrame && !websiteNavigationAllowed("weibo", event.url)) event.preventDefault(); });
      reader.on("closed", () => { if (ctx.receipts.get(url) === reader) ctx.receipts.delete(url); });
      try { await reader.loadURL(url); }
      catch (error) { if (!isAbortedNavigation(error)) throw new AppError("WEIBO_RECEIPT_LOAD_FAILED", "微博回执页面暂时无法打开，请重试。"); }
    },
    async open(account: WebsiteAccount, expectedUid: string) {
      await login(account);
      const state = await verify(account);
      if (!state.hasSession || state.uid !== expectedUid)
        throw new AppError(
          "WEIBO_ACCOUNT_MISMATCH",
          "微博登录已失效或当前账号与图文任务不一致。请返回其他账号检查登录后重试。",
        );
    },
    async clear(account: WebsiteAccount) {
      const ctx = context(account);
      ctx.revision++;
      if (ctx.timer) clearTimeout(ctx.timer);
      ctx.timer = undefined;
      if (ctx.window && !ctx.window.isDestroyed()) ctx.window.destroy();
      if (ctx.verifier && !ctx.verifier.isDestroyed()) ctx.verifier.destroy();
      for (const reader of ctx.receipts.values()) if (!reader.isDestroyed()) reader.destroy();
      ctx.receipts.clear();
      if (ctx.pending) await ctx.pending;
      await ctx.profile.clearStorageData();
      await ctx.profile.clearCache();
      ctx.identity = null;
      ctx.knownUid = null;
      ctx.signature = null;
      ctx.checkedAt = null;
      ctx.error = null;
      ctx.expired = false;
    },
    async invalidate(account: WebsiteAccount) {
      const ctx = context(account);
      ctx.revision++;
      ctx.identity = null;
      ctx.signature = null;
      ctx.expired = true;
    },
  };
}

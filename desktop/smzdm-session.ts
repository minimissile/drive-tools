import { BrowserWindow, session, type Session } from "electron";
import type {
  WebsiteAccount,
  WebsiteSessionState,
} from "../shared/website-accounts";
import {
  smzdmEditorUrl,
  smzdmHosts,
  smzdmSourceSchema,
  wechatArticleUrl,
  type SmzdmPort,
  type SmzdmPayload,
  type SmzdmResultQuery,
  type SmzdmReceipt,
} from "../shared/smzdm";
import { readWechatArticle } from "./wechat-article-page";
import {
  fillSmzdmEditor,
  smzdmSubmitControl,
  smzdmReceipt,
  readSmzdmIdentity,
  smzdmNewArticleUrl,
  readSmzdmArticleRecord,
} from "./smzdm-page";
import { AppError, safeMessage } from "../core/errors";
import { websiteNavigationAllowed } from "./website-session-policy";

type Context = { profile: Session; window?: BrowserWindow };
export function createSmzdmSession(
  context: (account: WebsiteAccount) => Context,
) {
  let articleWindow: BrowserWindow | undefined;
  const states = new WeakMap<Context, WebsiteSessionState>();
  const pending = new WeakMap<Context, Promise<WebsiteSessionState>>();
  const officialReader = (profile: Session) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        session: profile,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => {
      if (!websiteNavigationAllowed("smzdm", e.url)) e.preventDefault();
    });
    win.webContents.on("will-redirect", (e) => {
      if (e.isMainFrame && !websiteNavigationAllowed("smzdm", e.url))
        e.preventDefault();
    });
    return win;
  };
  const status = (account: WebsiteAccount): WebsiteSessionState => {
    const ctx = context(account);
    return {
      ...(states.get(ctx) ?? {
        hasSession: false,
        uid: null,
        error: "请在官方窗口登录后检查身份。",
      }),
      windowOpen: !!ctx.window && !ctx.window.isDestroyed(),
      checking: pending.has(ctx),
    };
  };
  const verify = async (account: WebsiteAccount) => {
    const ctx = context(account);
    if (pending.has(ctx)) return pending.get(ctx)!;
    const promise = (async () => {
      let uid: string | null = null,
        nickname: string | null = null;
      const verifier = officialReader(ctx.profile);
      const timeout = setTimeout(() => {
        if (!verifier.isDestroyed()) verifier.destroy();
      }, 30000);
      try {
        await verifier.loadURL("https://zhiyou.smzdm.com/user/");
        const identity = await evaluate<
          Awaited<ReturnType<typeof readSmzdmIdentity>>
        >(verifier, readSmzdmIdentity);
        uid = identity?.uid ?? null;
        nickname = identity?.nickname ?? null;
        states.set(ctx, {
          hasSession: !!uid,
          uid,
          nickname,
          windowOpen: !!ctx.window && !ctx.window.isDestroyed(),
          checkedAt: new Date().toISOString(),
          error: uid
            ? null
            : "尚未核实什么值得买身份，请在官方窗口完成登录或验证。",
        });
      } catch (error) {
        states.set(ctx, {
          hasSession: false,
          uid: null,
          windowOpen: !!ctx.window && !ctx.window.isDestroyed(),
          error:
            error instanceof AppError
              ? error.message
              : "身份检查未完成，请检查网络并在官方窗口完成登录后重试。",
        });
      } finally {
        clearTimeout(timeout);
        if (!verifier.isDestroyed()) verifier.destroy();
      }
      return status(account);
    })();
    pending.set(ctx, promise);
    try {
      return { ...(await promise), checking: false };
    } finally {
      pending.delete(ctx);
    }
  };
  const identity = async (
    account: WebsiteAccount,
    uid: string,
    force = false,
  ) => {
    const previous = status(account);
    // Account operations already verify their session at entry. Reuse that very
    // recent observation while filling; the final submission always checks again.
    const state =
      !force &&
      previous.hasSession &&
      previous.checkedAt &&
      Date.now() - Date.parse(previous.checkedAt) < 15000
        ? previous
        : await verify(account);
    if (!state.hasSession || state.uid !== uid)
      throw new AppError(
        "SMZDM_ACCOUNT_MISMATCH",
        "官方窗口身份与绑定账号不一致，请重新登录原账号。",
      );
  };
  const evaluate = <T>(
    win: BrowserWindow,
    fn: Function,
    ...args: unknown[]
  ): Promise<T> =>
    win.webContents
      .executeJavaScript(
        `(async()=>{try{return {ok:true,value:await (${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})};}catch(error){return {ok:false,error:String(error?.message??"官方页面处理失败，请检查窗口状态。").slice(0,600)};}})()`,
      )
      .then((result: { ok: boolean; value: T; error?: string }) => {
        if (!result.ok)
          throw new AppError(
            "SMZDM_PAGE",
            result.error ?? "官方页面处理未完成。",
          );
        return result.value;
      });
  const editorArticles = new WeakMap<Context, string>();
  const checkResult = async (
    account: WebsiteAccount,
    query: SmzdmResultQuery,
  ) => {
    const win = officialReader(context(account).profile);
    const timeout = setTimeout(() => {
      if (!win.isDestroyed()) win.destroy();
    }, 25000);
    try {
      await win.loadURL("https://zhiyou.smzdm.com/user/article/");
      const current = await evaluate<
        Awaited<ReturnType<typeof readSmzdmIdentity>>
      >(win, readSmzdmIdentity);
      if (current?.uid !== query.uid)
        throw new AppError(
          "SMZDM_ACCOUNT_MISMATCH",
          "投稿结果页面的账号身份不一致，未更新任务。",
        );
      for (let attempt = 0; attempt < 10; attempt++) {
        const receipt = await evaluate<SmzdmReceipt | null>(
          win,
          readSmzdmArticleRecord,
          query,
        );
        if (receipt) return receipt;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return null;
    } finally {
      clearTimeout(timeout);
      if (!win.isDestroyed()) win.destroy();
    }
  };
  const openEditor = async (
    account: WebsiteAccount,
    fresh = false,
    draftUrl?: string,
  ) => {
    if (draftUrl) {
      const url = new URL(draftUrl);
      if (
        url.origin !== "https://post.smzdm.com" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/edit\/[a-zA-Z0-9]+\/?$/.test(url.pathname)
      )
        throw new AppError(
          "SMZDM_DRAFT",
          "已保存的官方草稿地址无效，未打开或覆盖其他稿件。",
        );
    }
    const ctx = context(account);
    if (!ctx.window || ctx.window.isDestroyed()) {
      const win = new BrowserWindow({
        width: 1280,
        height: 900,
        title: "什么值得买 · 文章发布",
        webPreferences: {
          session: ctx.profile,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      ctx.window = win;
      win.webContents.setWindowOpenHandler(({ url }) => {
        // Official actions such as “去个人中心” open a new tab. Keep them in
        // this account's window while retaining the same navigation allowlist.
        if (websiteNavigationAllowed("smzdm", url))
          void win.loadURL(url).catch(() => {});
        return { action: "deny" };
      });
      win.webContents.on("will-navigate", (event) => {
        if (!websiteNavigationAllowed("smzdm", event.url))
          event.preventDefault();
      });
      win.webContents.on("will-redirect", (event) => {
        if (event.isMainFrame && !websiteNavigationAllowed("smzdm", event.url))
          event.preventDefault();
      });
    }
    const win = ctx.window;
    win.show();
    win.focus();
    const current = new URL(win.webContents.getURL() || "about:blank");
    if (
      (draftUrl ? current.href !== draftUrl : fresh) ||
      current.hostname !== "post.smzdm.com" ||
      !/^\/(?:tougao\/?|edit\/[a-zA-Z0-9]+\/?)$/.test(current.pathname)
    )
      await win.loadURL(draftUrl ?? smzdmEditorUrl);
    if (!smzdmHosts.includes(new URL(win.webContents.getURL()).hostname))
      throw new AppError("SMZDM_EDITOR", "请在什么值得买官方窗口完成登录。");
    if (/^\/tougao\/?$/.test(new URL(win.webContents.getURL()).pathname)) {
      let destination: string | undefined;
      for (let attempt = 0; attempt < 20 && !destination; attempt++) {
        try {
          destination = await evaluate<string>(win, smzdmNewArticleUrl);
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      if (!destination)
        throw new AppError(
          "SMZDM_EDITOR",
          "请在官方创作中心确认新文章入口后继续。",
        );
      await win.loadURL(destination);
    }
    return win;
  };
  const editor = async (
    account: WebsiteAccount,
    payload: SmzdmPayload,
    onDraftOpened: (url: string) => Promise<void>,
  ) => {
    await identity(account, payload.uid);
    const articleKey = payload.key.slice(0, payload.key.lastIndexOf(":"));
    const ctx = context(account);
    const win = await openEditor(
      account,
      editorArticles.get(ctx) !== articleKey,
      payload.draftUrl,
    );
    // Persist the account-bound remote draft before writing, so a restart resumes
    // its uploads and covers instead of silently creating another article.
    await onDraftOpened(win.webContents.getURL());
    // Readiness and read-back can retry; mutating editor state happens exactly once.
    let failure: unknown;
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (win.isDestroyed())
        throw new AppError("SMZDM_WINDOW_CLOSED", "文章窗口已关闭。");
      try {
        await evaluate(win, fillSmzdmEditor, payload, true, "ready");
        ready = true;
        break;
      } catch (error) {
        failure = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw failure;
    await evaluate(win, fillSmzdmEditor, payload, false, "write");
    editorArticles.set(ctx, articleKey);
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (win.isDestroyed())
        throw new AppError(
          "SMZDM_WINDOW_CLOSED",
          "文章窗口已关闭，本地稿件已保留。",
        );
      try {
        await evaluate(win, fillSmzdmEditor, payload, true);
        return win;
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  };
  const port: SmzdmPort = {
    checkResult,
    async open(account) {
      await openEditor(account);
    },
    async readArticle(rawUrl) {
      const url = wechatArticleUrl.parse(rawUrl);
      const previous =
        articleWindow && !articleWindow.isDestroyed()
          ? articleWindow
          : undefined;
      const win =
        previous ??
        new BrowserWindow({
          show: false,
          webPreferences: {
            session: session.fromPartition("panxu-public-wechat"),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
      articleWindow = win;
      if (!previous) {
        win.once("closed", () => {
          if (articleWindow === win) articleWindow = undefined;
        });
        win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        win.webContents.session.setPermissionRequestHandler(
          (_c, _p, callback) => callback(false),
        );
        const allowed = (raw: string) => {
          try {
            return new URL(raw).origin === "https://mp.weixin.qq.com";
          } catch {
            return false;
          }
        };
        win.webContents.on("will-navigate", (e) => {
          if (!allowed(e.url)) e.preventDefault();
        });
        win.webContents.on("will-redirect", (e) => {
          if (e.isMainFrame && !allowed(e.url)) e.preventDefault();
        });
      }
      const timeout = setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
      }, 30000);
      let success = false;
      try {
        await win.loadURL(url);
        const source = smzdmSourceSchema.parse(
          await evaluate(win, readWechatArticle),
        );
        success = true;
        return { ...source, url };
      } catch (error) {
        if (!win.isDestroyed()) {
          win.setTitle("公众号文章 · 请核对页面后重试");
          win.show();
          win.focus();
        }
        throw new AppError(
          "WECHAT_ARTICLE_READ",
          `${safeMessage(error)} 请在已打开的公众号窗口核对文章或处理验证后，再点击“抓取文章”。`,
        );
      } finally {
        clearTimeout(timeout);
        if (success && !win.isDestroyed()) win.destroy();
      }
    },
    async prepare(account, payload, onDraftOpened) {
      const win = await editor(account, payload, onDraftOpened);
      try {
        await evaluate(win, smzdmSubmitControl, false, payload.aiAssisted);
        return {
          ready: true,
          message: "官方正文、配图与发布必填项已核对，可预览后确认提交。",
        };
      } catch (error) {
        return { ready: false, message: `稿件已填写；${safeMessage(error)}` };
      }
    },
    async submit(account, payload, beforeSubmit, onDraftOpened) {
      const win = await editor(account, payload, onDraftOpened);
      const resultQuery: SmzdmResultQuery = {
        uid: payload.uid,
        title: payload.title,
        draftUrl: win.webContents.getURL(),
      };
      await identity(account, payload.uid);
      await evaluate(win, fillSmzdmEditor, payload, true);
      await evaluate(win, smzdmSubmitControl, false, payload.aiAssisted);
      await beforeSubmit();
      // After this point an exception means an uncertain result, not permission to retry.
      await identity(account, payload.uid, true);
      await evaluate(win, fillSmzdmEditor, payload, true);
      await evaluate(win, smzdmSubmitControl, true, payload.aiAssisted);
      for (let attempt = 0; attempt < 30; attempt++) {
        if (win.isDestroyed()) break;
        const receipt = await evaluate<ReturnType<typeof smzdmReceipt>>(
          win,
          smzdmReceipt,
        ).catch(() => null);
        if (receipt) {
          // A success dialog establishes submission. The own-article list is
          // authoritative for the public URL and whether review has completed.
          const latest = await checkResult(account, resultQuery).catch(
            () => null,
          );
          return latest ?? receipt;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const latest = await checkResult(account, resultQuery).catch(() => null);
      if (latest) return latest;
      throw new AppError(
        "SMZDM_RECEIPT_UNKNOWN",
        "未取得可确认的文章回执，请在官方窗口核对提交、审核或验证提示。",
      );
    },
  };
  return {
    isOpen: () => !!articleWindow && !articleWindow.isDestroyed(),
    status,
    verify,
    invalidate(account: WebsiteAccount) {
      states.delete(context(account));
    },
    port,
  };
}

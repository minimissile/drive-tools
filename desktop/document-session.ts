import { BrowserWindow, type Session } from "electron";
import type {
  WebsiteAccount,
  WebsiteSessionState,
} from "../shared/website-accounts";
import {
  documentHostMatches,
  documentPlatformSpecs,
  documentPlatformUrl,
  isDocumentProvider,
} from "../shared/document-platforms";
import { AppError } from "../core/errors";
import {
  isAbortedNavigation,
  websiteNavigationAllowed,
} from "./website-session-policy";

type Context = { profile: Session; window?: BrowserWindow };
type Cache = {
  revision: number;
  state: WebsiteSessionState;
  pending?: Promise<WebsiteSessionState>;
};

/** Web login is kept in the selected local profile. It is not an OAuth/API identity. */
export function createDocumentSessions(
  context: (account: WebsiteAccount) => Context,
  login: (account: WebsiteAccount) => Promise<void>,
) {
  const states = new WeakMap<Context, Cache>();
  const cache = (account: WebsiteAccount) => {
    const ctx = context(account);
    let current = states.get(ctx);
    if (!current) {
      current = {
        revision: 0,
        state: {
          hasSession: false,
          uid: null,
          sessionOnly: true,
          windowOpen: false,
          error:
            "请在官方窗口完成登录，再点击检查登录。本机会话不代表开放平台授权。",
        },
      };
      states.set(ctx, current);
      const entry = current;
      ctx.profile.cookies.on("changed", (_event, cookie) => {
        if (
          !isDocumentProvider(account.provider) ||
          !documentHostMatches(
            (cookie.domain ?? "").replace(/^\./, ""),
            documentPlatformSpecs[account.provider].hosts,
          ) ||
          !/^(?:session|session_list|sessionid|shimo_sid|shimo_session|TOK|DOC_SID|eas_sid)$/i.test(
            cookie.name,
          )
        )
          return;
        entry.revision++;
        entry.state = {
          hasSession: false,
          uid: null,
          sessionOnly: true,
          windowOpen: false,
          error: "文档平台的登录会话已变化，请重新检查登录。",
        };
      });
    }
    return current;
  };
  const status = (account: WebsiteAccount): WebsiteSessionState => {
    const ctx = context(account),
      entry = cache(account);
    return {
      ...entry.state,
      checking: !!entry.pending,
      windowOpen: !!ctx.window && !ctx.window.isDestroyed(),
    };
  };
  const verify = async (
    account: WebsiteAccount,
  ): Promise<WebsiteSessionState> => {
    if (!isDocumentProvider(account.provider))
      throw new AppError("DOCUMENT_PROVIDER_REQUIRED", "请选择文档平台账号。");
    const provider = account.provider,
      ctx = context(account),
      entry = cache(account);
    if (entry.pending) return entry.pending;
    const spec = documentPlatformSpecs[provider];
    entry.pending = (async () => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          session: ctx.profile,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event) => {
        if (!websiteNavigationAllowed(provider, event.url))
          event.preventDefault();
      });
      win.webContents.on("will-redirect", (event) => {
        if (event.isMainFrame && !websiteNavigationAllowed(provider, event.url))
          event.preventDefault();
      });
      const timer = setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
      }, 30000);
      try {
        await win.loadURL(spec.home);
        const revision = entry.revision;
        // Inspect the official workspace, without calling undocumented identity endpoints.
        const workspaceVisible = (await win.webContents.executeJavaScript(`
          new Promise(resolve => {
            const inspect = () => {
              const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
              const controls = [...document.querySelectorAll('button, a, [role="button"], input')].filter(visible);
              const login = controls.some(el => /^(?:登录|立即登录|扫码登录|微信登录|QQ登录|手机号登录|登 录|Log in|Sign in)$/i.test((el.innerText || el.getAttribute('aria-label') || '').trim())) ||
                [...document.querySelectorAll('input[type="password"], [class*="qrcode"], [class*="qr-code"]')].some(visible);
              const text = (document.body?.innerText || '').slice(0, 100000);
              const workspace = /我的文档|我的空间|最近使用|最近访问|与我共享|共享给我|所有文件/.test(text) && /新建|导入|上传|回收站/.test(text);
              resolve(!login && workspace);
            };
            setTimeout(inspect, 1500);
          })
        `)) as boolean;
        const destination = documentPlatformUrl(
          provider,
          win.webContents.getURL(),
        );
        const cookies = await ctx.profile.cookies.get({});
        const cookieNames: Record<typeof provider, RegExp> = {
          feishu: /^(?:session|session_list|sessionid)$/i,
          "tencent-docs": /^(?:TOK|DOC_SID|eas_sid)$/i,
          shimo: /^(?:shimo_sid|shimo_session|session|sessionid)$/i,
        };
        const hasCookie = cookies.some(
          (cookie) =>
            !!cookie.value &&
            documentHostMatches(
              (cookie.domain ?? "").replace(/^\./, ""),
              spec.hosts,
            ) &&
            cookieNames[provider].test(cookie.name),
        );
        if (revision !== entry.revision) return status(account);
        const hasSession = !!destination && workspaceVisible && hasCookie;
        entry.state = {
          hasSession,
          uid: null,
          sessionOnly: true,
          windowOpen: false,
          checkedAt: new Date().toISOString(),
          error: hasSession
            ? null
            : "尚未识别可用的文档工作台会话。请在官方窗口完成登录或安全验证后重试；平台界面变化也可能导致检查暂不可用。",
        };
      } catch {
        entry.state = {
          hasSession: false,
          uid: null,
          sessionOnly: true,
          windowOpen: false,
          error:
            "文档登录检查未完成，请检查网络并在官方窗口处理登录或安全验证后重试。",
        };
      } finally {
        clearTimeout(timer);
        if (!win.isDestroyed()) win.destroy();
      }
      return { ...status(account), checking: false };
    })();
    try {
      return await entry.pending;
    } finally {
      entry.pending = undefined;
    }
  };
  return {
    status,
    verify,
    invalidate(account: WebsiteAccount) {
      const entry = cache(account);
      entry.revision++;
      entry.state = {
        hasSession: false,
        uid: null,
        sessionOnly: true,
        windowOpen: false,
        error: "请在官方窗口完成登录后重新检查。",
      };
    },
    async openDocument(account: WebsiteAccount, value: string) {
      const url = documentPlatformUrl(account.provider, value);
      if (!url)
        throw new AppError(
          "DOCUMENT_URL_BLOCKED",
          "文档地址必须属于所选平台的 HTTPS 官方站点。",
        );
      await login(account);
      const win = context(account).window;
      if (!win || win.isDestroyed())
        throw new AppError(
          "DOCUMENT_WINDOW_UNAVAILABLE",
          "官方文档窗口未打开，请重新登录后重试。",
        );
      try {
        await win.loadURL(url);
      } catch (error) {
        if (!isAbortedNavigation(error))
          throw new AppError(
            "DOCUMENT_OPEN_FAILED",
            "官方文档加载失败，请检查网络后重试。",
          );
      }
      win.show();
      win.focus();
    },
  };
}

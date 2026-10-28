import { BrowserWindow, type Session } from "electron";
import type {
  WebsiteAccount,
  WebsiteSessionState,
} from "../shared/website-accounts";
import { websiteNavigationAllowed } from "./website-session-policy";

type Context = { profile: Session; window?: BrowserWindow };
type CachedIdentity = {
  state: WebsiteSessionState;
  revision: number;
  pending?: Promise<WebsiteSessionState>;
};

/** Native login uses the shared official window; identity is checked only on request. */
export function createZhihuIdentitySession(
  context: (account: WebsiteAccount) => Context,
) {
  const identities = new WeakMap<Context, CachedIdentity>();
  const cache = (ctx: Context) => {
    let cached = identities.get(ctx);
    if (!cached) {
      cached = {
        revision: 0,
        state: {
          hasSession: false,
          uid: null,
          windowOpen: false,
          error: "请完成知乎登录后点击检查登录。",
        },
      };
      identities.set(ctx, cached);
      const identity = cached;
      ctx.profile.cookies.on("changed", (_event, cookie) => {
        if (
          cookie.name !== "z_c0" ||
          !/(^|\.)zhihu\.com$/.test(cookie.domain ?? "")
        )
          return;
        identity.revision++;
        identity.state = {
          hasSession: false,
          uid: null,
          windowOpen: false,
          error: "知乎登录状态已变化，请重新检查登录。",
        };
      });
    }
    return cached;
  };
  const status = (account: WebsiteAccount): WebsiteSessionState => {
    const ctx = context(account),
      cached = cache(ctx);
    return {
      ...cached.state,
      windowOpen: !!ctx.window && !ctx.window.isDestroyed(),
      checking: !!cached.pending,
    };
  };
  const verify = async (account: WebsiteAccount) => {
    const ctx = context(account),
      cached = cache(ctx);
    if (cached.pending) return cached.pending;
    cached.pending = (async () => {
      const verifier = new BrowserWindow({
        show: false,
        webPreferences: {
          session: ctx.profile,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      verifier.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      verifier.webContents.on("will-navigate", (details) => {
        if (!websiteNavigationAllowed("zhihu", details.url))
          details.preventDefault();
      });
      verifier.webContents.on("will-redirect", (details) => {
        if (
          details.isMainFrame &&
          !websiteNavigationAllowed("zhihu", details.url)
        )
          details.preventDefault();
      });
      const timeout = setTimeout(() => {
        if (!verifier.isDestroyed()) verifier.destroy();
      }, 30000);
      try {
        await verifier.loadURL("https://www.zhihu.com/");
        const revision = cached.revision;
        // Read the official viewer endpoint in its own session, never infer UID from a profile URL.
        const identity = (await verifier.webContents.executeJavaScript(`
          (async () => {
            if (location.origin !== 'https://www.zhihu.com') return null;
            const r = await fetch('/api/v4/me', { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(10000) });
            if (!r.ok) return null;
            const text = await r.text();
            if (text.length > 128000) return null;
            const v = JSON.parse(text);
            return typeof v.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v.id) && typeof v.name === 'string'
              ? { uid: v.id, nickname: v.name.slice(0, 100) } : null;
          })()
        `)) as { uid: string; nickname: string } | null;
        if (revision !== cached.revision) return status(account);
        cached.state = {
          hasSession: !!identity,
          uid: identity?.uid ?? null,
          nickname: identity?.nickname ?? null,
          windowOpen: false,
          error: identity
            ? null
            : "未能核实知乎身份，请在内置窗口完成登录或安全验证后重新检查。",
          checkedAt: new Date().toISOString(),
        };
      } catch {
        cached.state = {
          hasSession: false,
          uid: null,
          windowOpen: false,
          error:
            "知乎身份检查未完成，请检查网络并在官方窗口完成登录或安全验证后重试。",
        };
      } finally {
        clearTimeout(timeout);
        if (!verifier.isDestroyed()) verifier.destroy();
      }
      return status(account);
    })();
    try {
      return { ...(await cached.pending), checking: false };
    } finally {
      cached.pending = undefined;
    }
  };
  return {
    status,
    verify,
    invalidate(account: WebsiteAccount) {
      const cached = cache(context(account));
      cached.revision++;
      cached.state = {
        hasSession: false,
        uid: null,
        windowOpen: false,
        expired: true,
        error: "知乎会话需要重新登录并检查。",
      };
    },
  };
}

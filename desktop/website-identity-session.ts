import { BrowserWindow, type Session } from "electron";
import type {
  WebsiteAccount,
  WebsiteProvider,
  WebsiteSessionState,
} from "../shared/website-accounts";
import { websiteNavigationAllowed } from "./website-session-policy";

export type WebsiteIdentityContext = {
  profile: Session;
  window?: BrowserWindow;
};
type CachedIdentity = {
  state: WebsiteSessionState;
  revision: number;
  pending?: Promise<WebsiteSessionState>;
};

/** Native login uses the shared official window; identity is checked only on request. */
export function createWebsiteIdentitySession(
  context: (account: WebsiteAccount) => WebsiteIdentityContext,
  spec: {
    provider: WebsiteProvider;
    label: string;
    home: string;
    cookieDomain: RegExp;
    cookieNames: RegExp;
    script: string;
  },
) {
  const identities = new WeakMap<WebsiteIdentityContext, CachedIdentity>();
  const cache = (ctx: WebsiteIdentityContext) => {
    let cached = identities.get(ctx);
    if (!cached) {
      cached = {
        revision: 0,
        state: {
          hasSession: false,
          uid: null,
          windowOpen: false,
          error: `请完成${spec.label}登录后点击检查登录。`,
        },
      };
      identities.set(ctx, cached);
      const identity = cached;
      ctx.profile.cookies.on("changed", (_event, cookie) => {
        if (
          !spec.cookieNames.test(cookie.name) ||
          !spec.cookieDomain.test(cookie.domain ?? "")
        )
          return;
        identity.revision++;
        identity.state = {
          hasSession: false,
          uid: null,
          windowOpen: false,
          error: `${spec.label}登录状态已变化，请重新检查登录。`,
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
        if (!websiteNavigationAllowed(spec.provider, details.url))
          details.preventDefault();
      });
      verifier.webContents.on("will-redirect", (details) => {
        if (
          details.isMainFrame &&
          !websiteNavigationAllowed(spec.provider, details.url)
        )
          details.preventDefault();
      });
      const timeout = setTimeout(() => {
        if (!verifier.isDestroyed()) verifier.destroy();
      }, 30000);
      try {
        await verifier.loadURL(spec.home);
        const revision = cached.revision;
        // Read the official viewer endpoint in its own session, never infer UID from a profile URL.
        const identity = (await verifier.webContents.executeJavaScript(
          spec.script,
        )) as { uid: string; nickname: string } | null;
        if (revision !== cached.revision) return status(account);
        cached.state = {
          hasSession: !!identity,
          uid: identity?.uid ?? null,
          nickname: identity?.nickname ?? null,
          windowOpen: false,
          error: identity
            ? null
            : `未能核实${spec.label}身份，请在内置窗口完成登录或安全验证后重新检查。`,
          checkedAt: new Date().toISOString(),
        };
      } catch {
        cached.state = {
          hasSession: false,
          uid: null,
          windowOpen: false,
          error: `${spec.label}身份检查未完成，请检查网络并在官方窗口完成登录或安全验证后重试。`,
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
        error: `${spec.label}会话需要重新登录并检查。`,
      };
    },
  };
}

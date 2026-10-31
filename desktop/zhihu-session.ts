import type { WebsiteAccount } from "../shared/website-accounts";
import {
  createWebsiteIdentitySession,
  type WebsiteIdentityContext,
} from "./website-identity-session";

export function createZhihuIdentitySession(
  context: (account: WebsiteAccount) => WebsiteIdentityContext,
) {
  return createWebsiteIdentitySession(context, {
    provider: "zhihu",
    label: "知乎",
    home: "https://www.zhihu.com/",
    cookieNames: /^z_c0$/,
    cookieDomain: /(^|\.)zhihu\.com$/,
    script: `(async () => {
      if (location.origin !== 'https://www.zhihu.com') return null;
      const r = await fetch('/api/v4/me', { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!r.ok) return null;
      const text = await r.text();
      if (text.length > 128000) return null;
      const v = JSON.parse(text);
      return typeof v.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v.id) && typeof v.name === 'string'
        ? { uid: v.id, nickname: v.name.slice(0, 100) } : null;
    })()`,
  });
}

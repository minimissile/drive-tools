import type { WebsiteProvider } from "../shared/website-accounts";

export const websiteLoginSpecs: Record<
  WebsiteProvider,
  { home: string; title: string; hosts: readonly string[] }
> = {
  weibo: {
    home: "https://weibo.com/",
    title: "微博 · 官方登录",
    hosts: ["weibo.com", "www.weibo.com", "passport.weibo.com", "login.sina.com.cn", "passport.sina.cn", "passport.weibo.cn", "m.weibo.cn", "weibo.cn", "security.weibo.com"],
  },
  "baidu-marketing": {
    home: "https://qingge.baidu.com/login",
    title: "百度营销 · 官方登录",
    hosts: [
      "qingge.baidu.com",
      "fengchao.baidu.com",
      "cdp.baidu.com",
      "cas.baidu.com",
      "passport.baidu.com",
      "wappass.baidu.com",
      "uc.baidu.com",
    ],
  },
};
export function websiteNavigationAllowed(
  provider: WebsiteProvider,
  value: string,
) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      websiteLoginSpecs[provider].hosts.includes(url.hostname)
    );
  } catch {
    return false;
  }
}
export function baiduIdentityFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !["qingge.baidu.com", "fengchao.baidu.com"].includes(url.hostname)
    )
      return null;
    const uid =
      url.searchParams.get("userId") ||
      url.searchParams.get("userid") ||
      url.pathname.match(/\/user\/(\d+)(?:\/|$)/)?.[1];
    return uid && /^[1-9]\d{0,19}$/.test(uid) ? uid : null;
  } catch {
    return null;
  }
}
export function isAbortedNavigation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string | number; errno?: number };
  return (
    value.code === "ERR_ABORTED" || value.code === -3 || value.errno === -3
  );
}
/** Initialize the product session after the shared marketing login succeeds. */
export function websitePostLoginUrl(provider: WebsiteProvider, value: string) {
  if (
    provider !== "baidu-marketing" ||
    !websiteNavigationAllowed(provider, value)
  )
    return null;
  const url = new URL(value);
  return url.hostname === "qingge.baidu.com" && url.pathname === "/ad/overview"
    ? "https://qingge.baidu.com/ad/toolsCenter/kr?globalProduct=1"
    : null;
}

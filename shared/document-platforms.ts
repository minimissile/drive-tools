import type { WebsiteProvider } from "./website-accounts";

export const documentProviders = ["feishu", "tencent-docs", "shimo"] as const;
export type DocumentProvider = (typeof documentProviders)[number];
export const isDocumentProvider = (
  provider: string,
): provider is DocumentProvider =>
  (documentProviders as readonly string[]).includes(provider);

export const documentPlatformSpecs: Record<
  DocumentProvider,
  {
    name: string;
    home: string;
    hosts: readonly string[];
    loginHosts: readonly string[];
  }
> = {
  feishu: {
    name: "飞书",
    home: "https://feishu.cn/drive/home/",
    hosts: ["feishu.cn"],
    loginHosts: ["feishu.cn", "larksuite.com"],
  },
  "tencent-docs": {
    name: "腾讯文档",
    home: "https://docs.qq.com/desktop/",
    hosts: ["docs.qq.com"],
    loginHosts: ["docs.qq.com", "qq.com", "weixin.qq.com"],
  },
  shimo: {
    name: "石墨文档",
    home: "https://shimo.im/desktop",
    hosts: ["shimo.im"],
    loginHosts: ["shimo.im", "open.weixin.qq.com"],
  },
};

export function documentHostMatches(host: string, allowed: readonly string[]) {
  return allowed.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

/** The editor handoff stays on the selected platform; login hosts are not document URLs. */
export function documentPlatformUrl(
  provider: WebsiteProvider | string,
  value: string,
): string | null {
  if (!isDocumentProvider(provider)) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !documentHostMatches(url.hostname, documentPlatformSpecs[provider].hosts)
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}

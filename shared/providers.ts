import type { Provider } from "./types";

export const providerIds = [
  "quark",
  "baidu",
  "uc",
  "xunlei",
  "guangya",
  "pikpak",
] as const;
export const providerSpecs = {
  quark: {
    name: "夸克",
    home: "https://pan.quark.cn/",
    shareHost: "pan.quark.cn",
    apiHosts: ["pan.quark.cn", "drive-pc.quark.cn"],
    authDomains: ["quark.cn", "uc.cn"],
  },
  baidu: {
    name: "百度",
    home: "https://pan.baidu.com/disk/main",
    shareHost: "pan.baidu.com",
    apiHosts: ["pan.baidu.com", "d.pcs.baidu.com"],
    authDomains: ["baidu.com"],
  },
  uc: {
    name: "UC",
    home: "https://drive.uc.cn/",
    shareHost: "drive.uc.cn",
    apiHosts: ["drive.uc.cn", "pc-api.uc.cn"],
    authDomains: ["uc.cn"],
  },
  xunlei: {
    name: "迅雷",
    home: "https://pan.xunlei.com/",
    shareHost: "pan.xunlei.com",
    apiHosts: ["api-pan.xunlei.com", "xluser-ssl.xunlei.com"],
    authDomains: ["xunlei.com"],
  },
  guangya: {
    name: "光鸭",
    home: "https://www.guangyapan.com/",
    shareHost: "www.guangyapan.com",
    apiHosts: ["api.guangyapan.com", "account.guangyapan.com"],
    authDomains: ["guangyapan.com"],
  },
  pikpak: {
    name: "PikPak",
    home: "https://mypikpak.com/drive",
    shareHost: "mypikpak.com",
    apiHosts: ["api-drive.mypikpak.com", "user.mypikpak.com"],
    authDomains: ["mypikpak.com"],
  },
} satisfies Record<
  Provider,
  {
    name: string;
    home: string;
    shareHost: string;
    apiHosts: readonly string[];
    authDomains: readonly string[];
  }
>;

export function providerAuthAllowed(provider: Provider, text: string) {
  try {
    const url = new URL(text);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      providerSpecs[provider].authDomains.some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    );
  } catch {
    return false;
  }
}

export function providerApiAllowed(provider: Provider, text: string) {
  try {
    const url = new URL(text);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (providerSpecs[provider].apiHosts as readonly string[]).includes(
        url.hostname,
      )
    );
  } catch {
    return false;
  }
}

/** Unsupported remote metrics must never be replaced with local task counts. */
export const providerStatisticsNotes: Partial<Record<Provider, string>> = {
  guangya: "光鸭暂未确认提供逐分享转存统计；本地任务数不计作平台转存次数。",
  pikpak:
    "PikPak 支持同步官网返回的浏览、转存次数；下载次数暂未提供。字段未返回时显示未知。",
};
export const unsupportedStatisticsProviders: readonly Provider[] = ["guangya"];

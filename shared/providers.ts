import type { Provider } from "./types";

export const providerIds = [
  "quark",
  "baidu",
  "uc",
  "xunlei",
  "guangya",
  "pikpak",
  "cmcc",
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
  cmcc: {
    name: "移动云盘",
    home: "https://yun.139.com/w/",
    shareHost: "yun.139.com",
    apiHosts: [
      "yun.139.com",
      "user-njs.yun.139.com",
      "personal-kd-njs.yun.139.com",
      "share-kd-njs.yun.139.com",
      "orches.yun.139.com",
    ],
    authDomains: [
      "yun.139.com",
      "cmpassport.com",
      "caiyun.feixin.10086.cn",
      "passport.10086.cn",
    ],
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
      ((providerSpecs[provider].apiHosts as readonly string[]).includes(
        url.hostname,
      ) ||
        (provider === "cmcc" &&
          /^(?:personal|user|share)-[a-z0-9-]+\.yun\.139\.com$/.test(
            url.hostname,
          )))
    );
  } catch {
    return false;
  }
}

export function providerDriveName(provider: Provider) {
  const name = providerSpecs[provider].name;
  return /(?:网盘|云盘)$/.test(name) ? name : `${name}网盘`;
}

/** Unsupported remote metrics must never be replaced with local task counts. */
export const providerStatisticsNotes: Partial<Record<Provider, string>> = {
  guangya: "光鸭暂未确认提供逐分享转存统计；本地任务数不计作平台转存次数。",
  pikpak:
    "PikPak 支持同步官网返回的浏览、转存次数；下载次数暂未提供。字段未返回时显示未知。",
  cmcc: "移动云盘逐分享浏览、下载和转存统计尚未完成核验；本地同步数量不代替平台分享统计。",
};
export const unsupportedStatisticsProviders: readonly Provider[] = [
  "guangya",
  "cmcc",
];

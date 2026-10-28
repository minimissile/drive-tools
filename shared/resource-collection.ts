import { providerIds, providerSpecs } from "./providers";
import type { Provider } from "./types";

export const collectionWebSources = ["pansoo", "haisou"] as const;
export type CollectionWebSource = (typeof collectionWebSources)[number];
export const collectionWebSpecs = {
  pansoo: { name: "97盘搜", origin: "https://pansoo.net" },
  haisou: { name: "海搜", origin: "https://haisou.cc" },
} as const;

export const collectionDriveTypes = [
  "baidu",
  "quark",
  "aliyun",
  "xunlei",
  "123",
  "115",
  "tianyi",
  "mobile",
  "uc",
  "guangya",
  "pikpak",
  "other",
] as const;
export type CollectionDriveType = (typeof collectionDriveTypes)[number];
export type CollectionDriveFilter = "all" | "unmatched" | CollectionDriveType;
export const collectionDriveLabels: Record<CollectionDriveType, string> = {
  baidu: "百度网盘",
  quark: "夸克网盘",
  aliyun: "阿里云盘",
  xunlei: "迅雷云盘",
  "123": "123云盘",
  "115": "115网盘",
  tianyi: "天翼云盘",
  mobile: "移动云盘",
  uc: "UC网盘",
  guangya: "光鸭网盘",
  pikpak: "PikPak",
  other: "其他 / 未识别",
};
const driveHosts: Record<string, CollectionDriveType> = {
  ...Object.fromEntries(
    Object.entries(providerSpecs).map(([id, spec]) => [
      spec.shareHost,
      id as Provider,
    ]),
  ),
  "yun.baidu.com": "baidu",
  "pan.uc.cn": "uc",
  "fast.uc.cn": "uc",
  "guangyapan.com": "guangya",
  "www.aliyundrive.com": "aliyun",
  "aliyundrive.com": "aliyun",
  "www.alipan.com": "aliyun",
  "alipan.com": "aliyun",
  "123pan.com": "123",
  "www.123pan.com": "123",
  "123pan.cn": "123",
  "www.123pan.cn": "123",
  "123684.com": "123",
  "www.123684.com": "123",
  "123865.com": "123",
  "www.123865.com": "123",
  "115.com": "115",
  "www.115.com": "115",
  "115cdn.com": "115",
  "cloud.189.cn": "tianyi",
  "yun.139.com": "mobile",
  "caiyun.139.com": "mobile",
};
export function collectionDriveType(link: string): CollectionDriveType {
  try {
    const url = new URL(link);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port
    )
      return "other";
    return driveHosts[url.hostname] ?? "other";
  } catch {
    return "other";
  }
}
export function collectionTransferProvider(link: string): Provider | null {
  const type = collectionDriveType(link);
  return (providerIds as readonly string[]).includes(type)
    ? (type as Provider)
    : null;
}
/** Accept direct official share URLs only; a search result never follows redirect links. */
export function collectionShare(link: string, explicitCode = "") {
  const driveType = collectionDriveType(link);
  if (driveType === "other") return null;
  const url = new URL(link);
  const extendedShare =
    (driveType === "tianyi" || driveType === "mobile") &&
    (url.pathname !== "/" || !!url.search || !!url.hash);
  if (
    !extendedShare &&
    !/^\/s\/[\w.-]+\/?$/.test(url.pathname) &&
    !(
      driveType === "baidu" &&
      url.pathname === "/share/init" &&
      url.searchParams.get("surl")
    )
  )
    return null;
  const code =
    explicitCode.trim() ||
    url.searchParams.get("pwd") ||
    url.searchParams.get("password") ||
    url.searchParams.get("pass_code") ||
    url.searchParams.get("accessCode") ||
    (driveType === "guangya" ? url.searchParams.get("code") : "") ||
    "";
  url.protocol = "https:";
  // Mobile cloud shares can carry their resource identifier in the fragment.
  if (driveType !== "mobile" && driveType !== "tianyi") url.hash = "";
  return { link: url.href, code, driveType };
}
export function collectionLinkKey(link: string) {
  try {
    const url = new URL(link);
    const type = collectionDriveType(link);
    let key = url.pathname.replace(/\/$/, "");
    if (type === "tianyi" || type === "mobile") {
      for (const field of [
        "pwd",
        "password",
        "pass_code",
        "accessCode",
        "utm_source",
        "utm_medium",
        "utm_campaign",
      ])
        url.searchParams.delete(field);
      url.searchParams.sort();
      key += url.search + url.hash;
    }
    if (type === "baidu" && url.pathname === "/share/init") {
      const id = url.searchParams.get("surl") ?? "";
      key = `/s/${id.startsWith("1") ? id : `1${id}`}`;
    }
    return `${type === "other" ? url.hostname : type}${key}`;
  } catch {
    return link;
  }
}
export interface CollectionCandidate {
  name: string;
  link: string;
  code: string;
  sourceName?: string;
  sourceUrl?: string;
  verified?: boolean;
}
export interface CollectionResultSummary {
  driveType: CollectionDriveFilter;
  total: number;
  counts: Partial<Record<CollectionDriveType | "unmatched", number>>;
}

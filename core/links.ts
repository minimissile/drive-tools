import type { Platform, Provider, ShareInput } from "../shared/types";
import { providerSpecs } from "../shared/providers";
import { platformSpecs } from "../shared/platforms";
import { AppError } from "./errors";

const hosts: Record<string, Provider> = {
  "pan.quark.cn": "quark",
  "pan.baidu.com": "baidu",
  "yun.baidu.com": "baidu",
  "drive.uc.cn": "uc",
  "pan.uc.cn": "uc",
  "fast.uc.cn": "uc",
  "pan.xunlei.com": "xunlei",
  "guangyapan.com": "guangya",
  "www.guangyapan.com": "guangya",
  "mypikpak.com": "pikpak",
};
export function parseShare(text: string, explicitCode = ""): ShareInput {
  const candidates = text.match(/https?:\/\/[^\s<>"'，。；）)]+/gi) ?? [];
  for (const candidate of candidates) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    const provider = hosts[url.hostname];
    if (!provider) continue;
    if (url.username || url.password || url.port)
      throw new AppError(
        "INVALID_LINK",
        "分享链接不能包含登录凭据或自定义端口。",
      );
    let shareKey =
      url.pathname.match(/^\/s\/([a-zA-Z0-9_-]+)\/?$/)?.[1] ??
      (provider === "baidu" && url.pathname === "/share/init"
        ? url.searchParams.get("surl")
        : null);
    if (
      shareKey &&
      provider === "baidu" &&
      url.pathname === "/share/init" &&
      !shareKey.startsWith("1")
    )
      shareKey = "1" + shareKey;
    if (!shareKey)
      throw new AppError(
        "INVALID_LINK",
        "无法识别分享ID，请复制网盘的完整分享链接。",
      );
    const code =
      explicitCode.trim() ||
      url.searchParams.get("pwd") ||
      (provider === "guangya" ? url.searchParams.get("code") : "") ||
      text.match(/(?:提取码|访问码|密码)\s*[:：]?\s*([a-zA-Z0-9]{4,8})/)?.[1] ||
      "";
    return {
      provider,
      shareKey,
      url: `https://${providerSpecs[provider].shareHost}/s/${shareKey}`,
      code,
    };
  }
  throw new AppError(
    "INVALID_LINK",
    "支持百度、夸克、UC、迅雷、光鸭和 PikPak 分享链接。",
  );
}
export function validateEditorUrl(platform: Platform, text: string): string {
  const spec = platformSpecs.find((p) => p.id === platform);
  const url = new URL(text);
  if (
    !spec ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !spec.hosts.includes(url.hostname)
  )
    throw new AppError(
      "INVALID_EDITOR_URL",
      "发布入口必须是所选平台允许的 HTTPS 页面。",
    );
  return url.href;
}
export function validateOutgoingLinks(
  text: string,
  ownUrl: string,
  allowLinks: boolean,
): void {
  for (const match of text.match(/https?:\/\/[^\s<>"'，。；）)]+/gi) ?? []) {
    let url: URL;
    try {
      url = new URL(match);
    } catch {
      continue;
    }
    if (!(url.hostname in hosts)) continue;
    if (!allowLinks)
      throw new AppError(
        "CHANNEL_LINK_BLOCKED",
        "当前渠道未获准附加网盘链接，请移除正文内的网址。",
      );
    const normalized = parseShare(url.href);
    if (normalized.url !== ownUrl)
      throw new AppError(
        "FOREIGN_SHARE_BLOCKED",
        "内容包含来源或其他网盘分享。只能使用当前资源副本已核验的本人链接。",
      );
  }
}
export function validateLoopback(text: string, websocket = false): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new AppError(
      "INVALID_LOCAL_URL",
      "请填写比特浏览器设置中的本地接口地址。",
    );
  }
  const protocols = websocket
    ? ["ws:", "wss:", "http:", "https:"]
    : ["http:", "https:"];
  if (
    !protocols.includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new AppError(
      "INVALID_LOCAL_URL",
      "比特接口仅允许本机 localhost、127.0.0.1 或 ::1 地址。",
    );
  return url;
}
export function validatePublicationUrl(
  platform: Platform,
  text: string,
): string {
  const allowed: Record<Platform, string[]> = {
    smzdm: ["post.smzdm.com"],
    xiaohongshu: ["www.xiaohongshu.com", "xiaohongshu.com", "xhslink.com"],
    douyin: ["www.douyin.com", "douyin.com", "v.douyin.com"],
    kuaishou: ["www.kuaishou.com", "kuaishou.com", "v.kuaishou.com"],
    wechat: ["mp.weixin.qq.com"],
    weibo: ["weibo.com", "www.weibo.com", "m.weibo.cn"],
    tieba: ["tieba.baidu.com"],
    douban: ["www.douban.com", "douban.com"],
    x: ["x.com", "twitter.com"],
    zhihu: ["www.zhihu.com", "zhuanlan.zhihu.com"],
    csdn: ["blog.csdn.net"],
    bilibili: ["www.bilibili.com", "bilibili.com", "b23.tv"],
    toutiao: ["www.toutiao.com", "toutiao.com", "m.toutiao.com"],
    baijiahao: ["baijiahao.baidu.com"],
    juejin: ["juejin.cn"],
    "51cto": ["blog.51cto.com"],
    cnblogs: ["www.cnblogs.com", "cnblogs.com"],
    segmentfault: ["segmentfault.com"],
    oschina: ["my.oschina.net", "www.oschina.net"],
    tencent: ["cloud.tencent.com", "developer.cloud.tencent.com"],
    aliyun: ["developer.aliyun.com"],
    jianshu: ["www.jianshu.com", "jianshu.com"],
  };
  const url = new URL(text);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname === "/" ||
    !allowed[platform].includes(url.hostname)
  )
    throw new AppError(
      "INVALID_PUBLICATION_URL",
      "请填写当前平台实际发布后的HTTPS内容链接。",
    );
  return url.href;
}

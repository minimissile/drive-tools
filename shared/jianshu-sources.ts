import { z } from "zod";

/** Parse an attribution URL only; callers must not use it to authorize a request. */
export function parseJianshuSourceReference(raw: string): string | null {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      host.startsWith("[") ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
      !host.includes(".") ||
      host.endsWith(".") ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid|onion|lan|home|arpa)$/.test(
        host,
      )
    )
      return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export const jianshuSourceProvider = z.enum([
  "rss",
  "web",
  "telegram",
  "bangumi",
  "tvmaze",
  "tieba",
]);
export type JianshuSourceProvider = z.infer<typeof jianshuSourceProvider>;
export const jianshuCollectInput = z.object({
  provider: jianshuSourceProvider.optional(),
  url: z.string().trim().max(4000).optional(),
  query: z.string().trim().max(150).optional(),
  presetId: z.string().max(60).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type JianshuCollectInput = z.input<typeof jianshuCollectInput>;
export const jianshuCollectSchema = jianshuCollectInput;
export interface JianshuSourcePreset {
  id: string;
  name: string;
  provider: JianshuSourceProvider;
  url: string;
  description: string;
}
export const jianshuSourcePresets: JianshuSourcePreset[] = [
  {
    id: "sspai",
    name: "少数派 · RSS",
    provider: "rss",
    url: "https://sspai.com/feed",
    description: "工具与效率选题；保留原作者与原文出处。",
  },
  {
    id: "ruanyifeng",
    name: "阮一峰博客 · Atom",
    provider: "rss",
    url: "https://www.ruanyifeng.com/blog/atom.xml",
    description: "技术周刊与学习选题；订阅不代表全文转载许可。",
  },
  {
    id: "shuge",
    name: "书格 · RSS",
    provider: "rss",
    url: "https://www.shuge.org/feed/",
    description: "古籍、书画与版本资料；具体资源用途以原页为准。",
  },
  {
    id: "quark-movies",
    name: "夸克影视资源频道",
    provider: "telegram",
    url: "https://t.me/s/Quark_Movies",
    description: "第三方公开频道，采集资源线索；不是本人分享或官方认证。",
  },
  {
    id: "resource-universe",
    name: "资源宇宙7",
    provider: "telegram",
    url: "https://t.me/s/tgsearchers7",
    description: "第三方公开资源线索；来源规格与链接仍需核实。",
  },
  {
    id: "bangumi",
    name: "Bangumi · 动漫资料",
    provider: "bangumi",
    url: "https://api.bgm.tv/v0/search/subjects",
    description: "按作品名查询公开条目；保留来源及 CC BY-SA 信息。",
  },
  {
    id: "tvmaze",
    name: "TVmaze · 剧集资料",
    provider: "tvmaze",
    url: "https://api.tvmaze.com/search/shows",
    description: "按剧名查询公开条目；数据适用 CC BY-SA，不提供网盘文件。",
  },
];
export interface JianshuSourceMaterial {
  id: string;
  provider: JianshuSourceProvider;
  title: string;
  body: string;
  summary: string;
  url: string;
  sourceName: string;
  author: string;
  publishedAt: string | null;
  collectedAt: string;
  /** Source URLs only: collection does not download or grant image reuse rights. */
  images: { url: string; alt: string }[];
  /** Original, unverified external shares; never mark these as owned resources. */
  externalShares: { url: string; code: string }[];
  warnings: string[];
}
export interface JianshuSourceCollection {
  items: JianshuSourceMaterial[];
  warnings: string[];
  sourceName: string;
  url: string;
  collectedAt: string;
  truncated: boolean;
}

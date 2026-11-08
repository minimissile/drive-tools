import { z } from "zod";
import { wechatArticleUrl } from "./smzdm";

export const wechatDiscoveryStatsLimit = 10;
export const wechatDiscoveryRequestUsd = 0.01;

export const wechatDiscoverySearch = z.object({
  keyword: z
    .string()
    .trim()
    .min(1, "请输入关键词。")
    .max(100, "关键词最多 100 字。"),
  cursor: z.string().min(1).max(20_000).optional(),
  sort: z.enum(["default", "latest", "hot"]).optional(),
  publishTime: z.enum(["all", "day", "week", "half_year"]).optional(),
});

export const wechatDiscoveryStatsInput = z.object({
  urls: z.array(wechatArticleUrl).min(1).max(wechatDiscoveryStatsLimit),
});

export interface WechatDiscoveryArticle {
  url: string;
  title: string;
  accountName: string;
  summary: string;
  publishedAt: string | null;
}

export interface WechatDiscoverySearchResult {
  items: WechatDiscoveryArticle[];
  nextCursor: string | null;
  total: number | null;
}

export interface WechatDiscoveryStats {
  url: string;
  readCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  collectCount: number | null;
  checkedAt: string;
}

export interface WechatDiscoveryStatsResult {
  items: WechatDiscoveryStats[];
  failures: { url: string; message: string }[];
}

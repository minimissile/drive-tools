import { z } from "zod";
import { websiteAccountIdSchema } from "./website-accounts";

export const weiboStatisticsInput = z.object({
  accountId: websiteAccountIdSchema,
  url: z.string().url().max(2000),
});
export const weiboMetric = z.object({
  value: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  display: z.string().min(1).max(60).nullable(),
  approximate: z.boolean(),
});
export const weiboMetricKeys = [
  "reads",
  "reposts",
  "comments",
  "likes",
  "linkClicks",
] as const;
export const weiboMetricLabels = {
  reads: "阅读量",
  reposts: "转发",
  comments: "评论",
  likes: "点赞",
  linkClicks: "链接点击",
};
export const weiboStatisticsReading = z.object({
  uid: z.string().regex(/^[1-9]\d{4,19}$/),
  url: z.string().url(),
  metrics: z.object({
    reads: weiboMetric,
    reposts: weiboMetric,
    comments: weiboMetric,
    likes: weiboMetric,
    linkClicks: weiboMetric,
  }),
});
export type WeiboStatisticsReading = z.infer<typeof weiboStatisticsReading>;
export const weiboStatisticsSample = weiboStatisticsReading.extend({
  id: z.string(),
  accountId: websiteAccountIdSchema,
  observedAt: z.string(),
  source: z.literal("weibo-page"),
});
export type WeiboStatisticsSample = z.infer<typeof weiboStatisticsSample>;
export interface WeiboStatisticsTarget {
  url: string;
  text: string;
}
type Contract<A, V> = { args: A; value: V };
export interface WeiboStatisticsContract {
  "weiboStats.list": Contract<{ accountId: string }, WeiboStatisticsTarget[]>;
  "weiboStats.get": Contract<
    z.infer<typeof weiboStatisticsInput>,
    WeiboStatisticsSample[]
  >;
  "weiboStats.refresh": Contract<
    z.infer<typeof weiboStatisticsInput>,
    WeiboStatisticsSample[]
  >;
}

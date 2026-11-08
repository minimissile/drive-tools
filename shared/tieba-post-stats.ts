import { z } from "zod";
import type { WebsiteAccount } from "./website-accounts";

export const tiebaPostStatsScopeMessage =
  "当前仅统计已核实为本人发布、且首帖正文中包含受支持网盘分享链接的主题帖；标题、回帖和评论中的链接不计入。浏览、回复和获赞仅按官网实际返回记录，首次读取建立基线，不计算增量。";
export interface TiebaPostMetrics {
  views: number | null;
  replies: number | null;
  likes: number | null;
}
export interface TiebaPostStatsReading extends TiebaPostMetrics {
  threadId: string;
  uid: string;
  forumId: string;
  forumName: string;
  title: string;
  url: string;
  links: string[];
  checkedAt: string;
  message: string;
}
export interface TiebaPostStat extends TiebaPostStatsReading {
  id: string;
  accountId: string;
  previousCheckedAt: string | null;
  deltaViews: number | null;
  deltaReplies: number | null;
  deltaLikes: number | null;
  history: (TiebaPostMetrics & { checkedAt: string })[];
}
export interface TiebaPostStatsSnapshot {
  busy: boolean;
  accounts: WebsiteAccount[];
  posts: TiebaPostStat[];
  summary: TiebaPostMetrics & {
    trackedPosts: number;
    deltaViews: number | null;
    deltaReplies: number | null;
    deltaLikes: number | null;
    lastRefreshedAt: string | null;
  };
  scopeMessage: string;
  message: string;
  refreshResult?: {
    succeeded: string[];
    excluded: { threadId: string; message: string }[];
    failed: { threadId: string; message: string }[];
  };
  discoveryResult?: { found: number; nextPage: number | null; message: string };
}
export const tiebaPostStatsRefreshSchema = z.object({
  accountId: z.string().min(1).max(150),
  threadIds: z
    .array(z.string().regex(/^[1-9]\d{0,19}$/))
    .max(20)
    .optional(),
});
export const tiebaPostStatsImportSchema = z.object({
  accountId: z.string().min(1).max(150),
  url: z.string().trim().min(1).max(1000),
});
export const tiebaPostStatsDiscoverSchema = z.object({
  accountId: z.string().min(1).max(150),
  page: z.number().int().min(1).max(100).default(1),
});
type Contract<A> = { args: A; value: TiebaPostStatsSnapshot };
export interface TiebaPostStatsContract {
  "tieba.postStats.snapshot": Contract<undefined>;
  "tieba.postStats.refresh": Contract<
    z.infer<typeof tiebaPostStatsRefreshSchema>
  >;
  "tieba.postStats.import": Contract<
    z.infer<typeof tiebaPostStatsImportSchema>
  >;
  "tieba.postStats.discover": Contract<
    z.input<typeof tiebaPostStatsDiscoverSchema>
  >;
}

import type {
  TiebaAnalysisPage,
  TiebaAnalysisThread,
  TiebaForumExposure,
} from "../../shared/tieba-analysis";
import { tiebaForumHomeUrl } from "../../shared/tieba-forums";

export interface ForumPerformanceRow {
  key: string;
  name: string;
  url: string | null;
  posts: number;
  measured: number;
  views: number | null;
  average: number | null;
  level: number | null;
  exposure: TiebaForumExposure | null;
}

export const forumPerformanceMetrics = [
  "posts",
  "views",
  "average",
  "exposure",
] as const;
export type ForumPerformanceOrder = {
  metric: (typeof forumPerformanceMetrics)[number];
  direction: "asc" | "desc";
};

const names = new Intl.Collator("zh-CN", { numeric: true });

export function forumPerformanceRows(
  threads: readonly Pick<TiebaAnalysisThread, "forumId" | "forum" | "views">[],
  order: ForumPerformanceOrder,
  forums: TiebaAnalysisPage["forums"] = [],
) {
  const groups = new Map<string, ForumPerformanceRow>();
  const context = new Map(forums.map((forum) => [forum.id, forum]));
  for (const thread of threads) {
    const name = thread.forum.trim();
    const key = thread.forumId
      ? `id:${thread.forumId}`
      : `name:${name.normalize("NFKC").toLowerCase()}`;
    let row = groups.get(key);
    if (!row) {
      const stats = context.get(thread.forumId ?? "");
      row = {
        key,
        name: name || "未知贴吧",
        url: tiebaForumHomeUrl(name),
        posts: 0,
        measured: 0,
        views: null,
        average: null,
        level: stats?.level ?? null,
        exposure: stats?.exposure ?? null,
      };
      groups.set(key, row);
    } else if (!row.url && name) {
      row.name = name;
      row.url = tiebaForumHomeUrl(name);
    }
    row.posts++;
    if (thread.views !== null) {
      row.measured++;
      row.views = (row.views ?? 0) + thread.views;
      row.average = row.views / row.measured;
    }
  }
  return [...groups.values()].sort((a, b) => {
    const metric = order.metric;
    const left =
      metric === "exposure" ? (a.exposure?.hourly ?? null) : a[metric];
    const right =
      metric === "exposure" ? (b.exposure?.hourly ?? null) : b[metric];
    if (left === null && right !== null) return 1;
    if (left !== null && right === null) return -1;
    if (left !== null && right !== null && left !== right)
      return order.direction === "asc" ? left - right : right - left;
    return names.compare(a.name, b.name) || a.key.localeCompare(b.key);
  });
}

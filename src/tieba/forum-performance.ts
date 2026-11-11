import type { TiebaAnalysisThread } from "../../shared/tieba-analysis";
import { tiebaForumHomeUrl } from "../../shared/tieba-forums";

export interface ForumPerformanceRow {
  key: string;
  name: string;
  url: string | null;
  posts: number;
  measured: number;
  views: number | null;
  average: number | null;
}

export const forumPerformanceMetrics = ["posts", "views", "average"] as const;
export type ForumPerformanceOrder = {
  metric: (typeof forumPerformanceMetrics)[number];
  direction: "asc" | "desc";
};

const names = new Intl.Collator("zh-CN", { numeric: true });

export function forumPerformanceRows(
  threads: readonly Pick<TiebaAnalysisThread, "forumId" | "forum" | "views">[],
  order: ForumPerformanceOrder,
) {
  const groups = new Map<string, ForumPerformanceRow>();
  for (const thread of threads) {
    const name = thread.forum.trim();
    const key = thread.forumId
      ? `id:${thread.forumId}`
      : `name:${name.normalize("NFKC").toLowerCase()}`;
    let row = groups.get(key);
    if (!row) {
      row = {
        key,
        name: name || "未知贴吧",
        url: tiebaForumHomeUrl(name),
        posts: 0,
        measured: 0,
        views: null,
        average: null,
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
    const left = a[order.metric],
      right = b[order.metric];
    if (left === null && right !== null) return 1;
    if (left !== null && right === null) return -1;
    if (left !== null && right !== null && left !== right)
      return order.direction === "asc" ? left - right : right - left;
    return names.compare(a.name, b.name) || a.key.localeCompare(b.key);
  });
}

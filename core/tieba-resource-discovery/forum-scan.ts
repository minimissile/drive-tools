import type { TiebaAnalysisThread } from "../../shared/tieba-analysis";
import { tiebaForumNoResourceLimit as limit } from "../../shared/tieba-resource-discovery";
import { oldResourceEvidence } from "./old-resource";

export interface ForumResourceScan {
  misses: number;
  recentIds: string[];
}

type Thread = Pick<TiebaAnalysisThread, "id" | "title" | "resource" | "oldResource">;
const netdiskKeywords = new Set(["网盘", "云盘", "提取码", "//pan."]);

function hasNetdiskClue(post: Thread) {
  if (post.resource) return true;
  const evidence = post.oldResource ?? oldResourceEvidence([{ source: "标题", text: post.title }]);
  return evidence.linkSources.length > 0 || evidence.keywords.some((word) => netdiskKeywords.has(word));
}

export function scanForumResourcePage<T extends Thread>(threads: T[], previous?: ForumResourceScan) {
  const seen = new Set(previous?.recentIds);
  let misses = previous?.misses ?? 0;
  let end = 0;
  for (const post of threads) {
    end++;
    const repeated = seen.delete(post.id);
    seen.add(post.id);
    if (repeated) continue;
    misses = hasNetdiskClue(post) ? 0 : misses + 1;
    if (misses >= limit) break;
  }
  return {
    threads: threads.slice(0, end),
    progress: { misses, recentIds: [...seen].slice(-2 * limit) },
    skip: misses >= limit,
  };
}

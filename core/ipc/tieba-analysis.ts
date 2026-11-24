import {
  tiebaAnalysisFollowedInputSchema,
  tiebaAnalysisForumInputSchema,
  tiebaAnalysisInputSchema,
  tiebaAnalysisThreadInputSchema,
  tiebaForumCacheControlSchema,
  tiebaForumCachePageSchema,
} from "../../shared/tieba-analysis";
import {
  queryTiebaAnalysisWithContext,
  queryTiebaAnalysisFollowedForums,
  queryTiebaAnalysisForumPosts,
  queryTiebaAnalysisThread,
} from "../tieba/analysis";
import type { TiebaForumCache } from "../tieba/forum-cache";

export function createTiebaAnalysisHandlers(
  query = queryTiebaAnalysisWithContext,
  thread = queryTiebaAnalysisThread,
) {
  return {
    "tieba.analysis.query": (input: unknown) =>
      query(tiebaAnalysisInputSchema.parse(input)),
    "tieba.analysis.thread": (input: unknown) =>
      thread(tiebaAnalysisThreadInputSchema.parse(input)),
    "tieba.analysis.followedForums": (input: unknown) =>
      queryTiebaAnalysisFollowedForums(
        tiebaAnalysisFollowedInputSchema.parse(input),
        undefined,
        true,
      ),
    "tieba.analysis.forumPosts": (input: unknown) =>
      queryTiebaAnalysisForumPosts({
        ...tiebaAnalysisForumInputSchema.parse(input),
        pageSize: 10,
      }),
  };
}

export function createTiebaForumCacheHandlers({ tiebaForumCache }: { tiebaForumCache: TiebaForumCache }) {
  return {
    "tieba.analysis.forumCache": (input: unknown) => {
      const { name, page, sort } = tiebaForumCachePageSchema.parse(input);
      return tiebaForumCache.page(name, page, sort);
    },
    "tieba.analysis.forumCacheControl": (input: unknown) => {
      const { name, action } = tiebaForumCacheControlSchema.parse(input);
      tiebaForumCache.control(name, action);
    },
  };
}

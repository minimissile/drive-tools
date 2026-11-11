import {
  tiebaAnalysisFollowedInputSchema,
  tiebaAnalysisForumInputSchema,
  tiebaAnalysisInputSchema,
} from "../../shared/tieba-analysis";
import {
  queryTiebaAnalysis,
  queryTiebaAnalysisFollowedForums,
  queryTiebaAnalysisForumPosts,
} from "../tieba/analysis";

export function createTiebaAnalysisHandlers(query = queryTiebaAnalysis) {
  return {
    "tieba.analysis.query": (input: unknown) =>
      query(tiebaAnalysisInputSchema.parse(input)),
    "tieba.analysis.followedForums": (input: unknown) =>
      queryTiebaAnalysisFollowedForums(
        tiebaAnalysisFollowedInputSchema.parse(input),
      ),
    "tieba.analysis.forumPosts": (input: unknown) =>
      queryTiebaAnalysisForumPosts(tiebaAnalysisForumInputSchema.parse(input)),
  };
}

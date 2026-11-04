import { useIpcQuery } from "../api/useIpcQuery";
import { pipixCommentExclusions } from "../../shared/pipix-acquisition";
import type { PipixComment } from "../../shared/pipix";
export function usePipixCommentRules() {
  const query = useIpcQuery("pipix.requestPolicy", undefined, {
    keepPrevious: true,
  });
  return {
    ...query,
    hits: (comment: PipixComment) =>
      pipixCommentExclusions(
        comment,
        query.data?.policy.excludedCommentTerms ?? [],
      ),
  };
}

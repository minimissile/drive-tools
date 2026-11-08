import {
  landingQuality,
  type RemoteLanding,
} from "../../../shared/resource-landing";
import type { LinkRow } from "./types";

export function publishable(link: LinkRow, page: RemoteLanding | null) {
  const doc = page?.document;
  return (
    !!doc &&
    link.enabled === 1 &&
    !!link.target_url &&
    doc.source.resourceTitle === link.title &&
    // Keep already published v1 snapshots readable during the editorial rollout.
    // PUT always uses the stricter current gate; no new metadata-only pages pass.
    (doc.source.documents === undefined && doc.review.dimensions === undefined
      ? doc.review.verdict === "pass" &&
        doc.review.score >= 85 &&
        doc.review.unsupportedClaims.length === 0
      : landingQuality(doc.article, doc.source, doc.review).eligible)
  );
}

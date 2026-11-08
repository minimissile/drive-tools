import type { Database } from "../database";
import { TiebaParticipationStore } from "../tieba-participation/store";
import { TiebaAutocareStore } from "../tieba-autocare/store";
import type { TiebaPublicationRef } from "../../shared/tieba-insights";

export function tiebaReplyPublications(db: Database): TiebaPublicationRef[] {
  const targets = new TiebaAutocareStore(db),
    replies = new TiebaParticipationStore(db);
  return replies.drafts().flatMap((draft) => {
    if (!draft.submittedAt) return [];
    const candidate = replies.candidate(draft.candidateId),
      target = candidate ? targets.target(candidate.targetId) : undefined;
    if (!target || !candidate) return [];
    return [
      {
        id: draft.id,
        kind: "reply" as const,
        accountId: draft.accountId,
        uid: draft.uid,
        forumId: target.forumId,
        forumName: target.name,
        threadId: draft.threadId,
        postId: draft.receipt?.postId ?? null,
        title: draft.title,
        url: draft.receipt?.url ?? draft.url,
        body: draft.body,
        submittedAt: draft.submittedAt,
        submissionStatus:
          draft.status === "verified"
            ? ("verified" as const)
            : ("uncertain" as const),
      },
    ];
  });
}

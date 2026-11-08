import {
  autocareParticipationScope,
  type AutocareState,
} from "../../shared/zhihu-autocare";
import type {
  ZhihuParticipationCandidate,
  ZhihuParticipationSnapshot,
} from "../../shared/zhihu-participation";
import { autocareAccountDomain, matchesAutocareDomain } from "./domain";

export const hasAutocareExchangeRequest = (text: string) =>
  /互关|互粉|互赞|关注必回|有粉必回|回关/.test(text);

export const hasCompleteAutocareRandomContext = (
  candidate: ZhihuParticipationCandidate,
) =>
  !!candidate.document &&
  !candidate.document.truncated &&
  candidate.document.kind === candidate.kind &&
  candidate.document.url === candidate.url &&
  candidate.document.text.length >= 8;

export interface AutocareRandomInteractionOption {
  candidate: ZhihuParticipationCandidate;
  kind: "like" | "comment" | "follow";
}

/** Reading history is deliberately separate from per-kind interaction history. */
export function autocareRandomInteractionOptions(
  state: AutocareState,
  participation: ZhihuParticipationSnapshot,
  accounts: { id: string; uid?: string | null }[],
  accountId: string,
  commentsAllowed: boolean,
): AutocareRandomInteractionOption[] {
  const uid = state.identities[accountId],
    domain = autocareAccountDomain(state.config, accountId),
    accountUids = new Map(accounts.map((account) => [account.id, account.uid])),
    candidates = new Map(
      participation.candidates.map((candidate) => [candidate.id, candidate]),
    ),
    used = new Set<string>();
  for (const activity of participation.activities) {
    if (
      !["like", "comment", "follow"].includes(activity.kind) ||
      !(
        activity.accountId === accountId ||
        (!!uid && accountUids.get(activity.accountId) === uid) ||
        activity.attempts?.some((attempt) => attempt.request.actorUid === uid)
      )
    )
      continue;
    const adoptableLegacy =
      activity.planId === autocareParticipationScope &&
      ["like", "follow"].includes(activity.kind) &&
      ["planned", "needs_review", "prepared"].includes(activity.status) &&
      !activity.attempts?.length &&
      !activity.resolution &&
      !activity.automation &&
      !activity.contentId &&
      activity.accountId === accountId;
    if (adoptableLegacy) continue;
    const url = candidates.get(activity.candidateId)?.url;
    if (url) used.add(`${activity.kind}:${url}`);
    for (const attempt of activity.attempts ?? [])
      used.add(`${attempt.request.kind}:${attempt.request.url}`);
  }
  const generatedComments = new Set(
    state.commentJobs.filter((job) => job.uid === uid).map((job) => job.url),
  );
  const options: AutocareRandomInteractionOption[] = [];
  for (const candidate of participation.candidates) {
    if (
      candidate.accountId !== accountId ||
      !matchesAutocareDomain(
        hasCompleteAutocareRandomContext(candidate)
          ? `${candidate.document!.title}\n${candidate.document!.text}`
          : `${candidate.title}\n${candidate.excerpt}`,
        domain,
      ) ||
      hasAutocareExchangeRequest(candidate.document?.text ?? "")
    )
      continue;
    const content = ["answer", "article"].includes(candidate.kind);
    if (
      content &&
      (state.config.randomLikes || state.config.likeCandidates) &&
      !used.has(`like:${candidate.url}`)
    )
      options.push({ candidate, kind: "like" });
    if (
      content &&
      state.config.randomComments &&
      commentsAllowed &&
      !generatedComments.has(candidate.url) &&
      !used.has(`comment:${candidate.url}`)
    )
      options.push({ candidate, kind: "comment" });
    if (
      state.config.followCandidates &&
      candidate.kind === "author" &&
      !used.has(`follow:${candidate.url}`)
    )
      options.push({ candidate, kind: "follow" });
  }
  return options;
}

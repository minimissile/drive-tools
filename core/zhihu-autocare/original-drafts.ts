import type { AutocareJob, AutocareState } from "../../shared/zhihu-autocare";
import {
  zhihuTaskClaimsContent,
  zhihuWarmingHasPromotion,
  type ZhihuContent,
  type ZhihuSnapshot,
} from "../../shared/zhihu";
import { autocareContentMatchesAccountDomain } from "./domain";
import { fingerprint } from "./state";

type ContentPool = Pick<ZhihuSnapshot, "contents" | "tasks">;

export function autocareOriginalBodyHash(content: Pick<ZhihuContent, "body">) {
  return fingerprint(
    content.body
      .normalize("NFKC")
      .replace(/\n\n参考来源：[\s\S]*$/u, "")
      .replace(/\s+/gu, ""),
  );
}

export function isAutocareOriginalDraft(
  content: ZhihuContent,
  accountId: string,
  uid: string | undefined,
) {
  return (
    !!uid &&
    content.accountId === accountId &&
    content.autocareOriginal?.uid === uid &&
    content.autocareOriginal?.version === content.version &&
    content.reviewed &&
    !content.source &&
    content.kind === "article" &&
    content.purpose === "warming" &&
    !zhihuWarmingHasPromotion(`${content.title}\n${content.body}`)
  );
}

/** Claims are workspace-wide, even when two drafts have different IDs or owners. */
export function hasAutocareOriginalClaim(
  snapshot: ContentPool,
  jobs: readonly AutocareJob[],
  content: ZhihuContent,
  ignoredJob?: AutocareJob,
) {
  const contents = new Map(snapshot.contents.map((entry) => [entry.id, entry]));
  const hash = autocareOriginalBodyHash(content);
  const matches = (id: string) => {
    if (id === content.id) return true;
    const other = contents.get(id);
    return !!other && autocareOriginalBodyHash(other) === hash;
  };
  return (
    snapshot.tasks.some(
      (task) =>
        task.id !== ignoredJob?.taskId &&
        zhihuTaskClaimsContent(task) &&
        matches(task.contentId),
    ) ||
    jobs.some(
      (job) =>
        job.id !== ignoredJob?.id &&
        job.status !== "cancelled" &&
        ((job.contentId && matches(job.contentId)) ||
          (job.sourceId.startsWith("original:") && job.sourceHash === hash)),
    )
  );
}

export function findAutocareOriginalDraft(
  snapshot: ContentPool,
  state: Pick<AutocareState, "config" | "jobs" | "identities">,
  accountId: string,
) {
  return snapshot.contents
    .filter(
      (content) =>
        isAutocareOriginalDraft(
          content,
          accountId,
          state.identities[accountId],
        ) &&
        autocareContentMatchesAccountDomain(state.config, accountId, content),
    )
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
    .find(
      (content) => !hasAutocareOriginalClaim(snapshot, state.jobs, content),
    );
}

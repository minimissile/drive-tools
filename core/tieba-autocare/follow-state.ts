import type { EnvironmentStamp } from "../../shared/browser-environments";
import type { TiebaForumReading } from "../../shared/tieba-autocare";
import { normalizeTiebaForumName } from "../../shared/tieba-forums";
import type { TargetRecord } from "./store";

/** Only official reading fields may overwrite a target; pause/identity/history remain local. */
export const tiebaForumReadingFields = (
  reading: TiebaForumReading,
): TiebaForumReading => ({
  forumId: reading.forumId,
  name: reading.name,
  url: reading.url,
  level: reading.level,
  experience: reading.experience,
  signed: reading.signed,
  canSign: reading.canSign,
  message: reading.message,
  checkedAt: reading.checkedAt,
  ...(reading.followed !== undefined ? { followed: reading.followed } : {}),
  ...(reading.personalStatsMessage !== undefined
    ? { personalStatsMessage: reading.personalStatsMessage }
    : {}),
  ...(reading.memberCount !== undefined
    ? { memberCount: reading.memberCount }
    : {}),
  ...(reading.postCount !== undefined ? { postCount: reading.postCount } : {}),
  ...(reading.threadCount !== undefined
    ? { threadCount: reading.threadCount }
    : {}),
});

/** Caller has verified this request's current UID and environment stamp around the read. */
export function verifiedTiebaFollowState(
  target: TargetRecord,
  reading: TiebaForumReading,
  scope: { uid: string; stamp: EnvironmentStamp },
  now: number,
): Partial<Pick<TargetRecord, "source" | "followIntent">> {
  const at = Date.parse(reading.checkedAt),
    a = target.stamp,
    b = scope.stamp;
  const checkpoint = target.followIntent
    ? Date.parse(target.followIntent.submittedAt)
    : null;
  if (
    reading.followed !== true ||
    target.uid !== scope.uid ||
    reading.forumId !== target.forumId ||
    a.environmentId !== b.environmentId ||
    a.revision !== b.revision ||
    a.identityId !== b.identityId ||
    a.identityRevision !== b.identityRevision ||
    !Number.isFinite(at) ||
    at > now + 5000 ||
    at < now - 10 * 60000 ||
    (checkpoint !== null && (!Number.isFinite(checkpoint) || at < checkpoint))
  )
    return {};
  try {
    if (
      normalizeTiebaForumName(reading.name).toLowerCase() !==
      normalizeTiebaForumName(target.name).toLowerCase()
    )
      return {};
  } catch {
    return {};
  }
  return {
    source: "followed",
    ...(target.followIntent
      ? {
          followIntent: {
            ...target.followIntent,
            status: "verified",
            checkedAt: reading.checkedAt,
            message: "官网已只读核实此账号关注该吧，原关注请求不再执行。",
          },
        }
      : {}),
  };
}

import { autocareRandomFollowScope } from "../../shared/zhihu-autocare";
import type { ZhihuParticipationCandidate } from "../../shared/zhihu-participation";
import { AppError, safeMessage } from "../errors";
import type { AutocareParticipationHost } from "./participation";
import {
  randomInteractionGuard,
  randomInteractionWait,
  recordRandomInteractionResult,
  autocareInteractionRunContext,
} from "./random-interactions";
import { autocareRunGapMinutes } from "./run-window";

/** One exact author per rule cycle; an existing/unknown attempt is never replayed. */
export async function executeAutocareRandomFollow(
  h: AutocareParticipationHost,
  candidate: ZhihuParticipationCandidate,
) {
  const accountId = candidate.accountId;
  const check = randomInteractionGuard(h, accountId, "follow");
  check();
  const text = candidate.document?.text;
  if (
    candidate.kind !== "author" ||
    !text ||
    text.length < 8 ||
    candidate.document?.truncated ||
    /未展示公开简介/.test(text)
  )
    throw new AppError(
      "AUTOCARE_FOLLOW_BLOCKED",
      "自动关注需要准确作者的完整公开简介",
    );
  const wait = randomInteractionWait(h, accountId);
  if (wait) {
    h.log("random_follow.waiting", wait, accountId);
    h.status(accountId, wait);
    return;
  }
  const activity = h.participation.planAutocareRule(
    {
      accountId,
      candidateId: candidate.id,
      version: candidate.version,
      kind: "follow",
      planId: autocareRandomFollowScope,
      reason:
        "按已开启的自动关注规则选择准确作者，公开简介已保存并重新核对；不使用逐项本人确认或AI评分",
    },
    check,
  );
  h.log(
    "random_follow.selected",
    `已选择作者《${candidate.title}》准备关注；${activity.id}`,
    accountId,
  );
  h.status(accountId, `正在自动关注《${candidate.title}》`);
  try {
    const result = await h.participation.executeInteraction(
      {
        id: activity.id,
        version: activity.version,
        decision: {
          source: "rule",
          rule: "autocare_random_follow",
          relevance: null,
          basis:
            "用户已开启自动关注规则；程序选择尚无关注尝试的准确作者，已取得并核对完整公开简介；不是本人逐项确认或AI相关性判断。",
          quote: text.slice(0, 120),
        },
      },
      {
        planId: autocareRandomFollowScope,
        planRevision: h.state.revision,
        rulesAuthorized: true,
        dailyLimit: h.state.config.interactionDailyLimit,
        autocareRun: autocareInteractionRunContext(h),
        gapMinutes: autocareRunGapMinutes,
        excludedUids: [],
        guard: check,
      },
    );
    recordRandomInteractionResult(h, result);
  } catch (error) {
    h.log(
      "random_follow.blocked",
      `${safeMessage(error)}；${activity.id}`,
      accountId,
      "warning",
    );
    throw error;
  }
}

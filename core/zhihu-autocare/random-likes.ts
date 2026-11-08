import { autocareRandomLikeScope } from "../../shared/zhihu-autocare";
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

/** One rule-selected target per due cycle; every failed/unknown attempt is retained. */
export async function executeAutocareRandomLike(
  h: AutocareParticipationHost,
  candidate: ZhihuParticipationCandidate,
) {
  const accountId = candidate.accountId,
    check = randomInteractionGuard(h, accountId, "like");
  check();
  const text = candidate.document?.text;
  if (!text || text.length < 8 || candidate.document?.truncated)
    throw new AppError(
      "AUTOCARE_RANDOM_LIKE_BLOCKED",
      "随机点赞需要完整的准确内容",
    );
  const wait = randomInteractionWait(h, accountId);
  if (wait) {
    h.log("random_like.waiting", wait, accountId);
    h.status(accountId, wait);
    return;
  }
  const activity = h.participation.planAutocareRule(
    {
      accountId,
      candidateId: candidate.id,
      version: candidate.version,
      kind: "like",
      planId: autocareRandomLikeScope,
      reason:
        "按已开启的随机点赞规则，从未有点赞记录的回答或文章中随机选择；未使用AI评分或逐项本人确认",
    },
    check,
  );
  h.log(
    "random_like.selected",
    `随机选择《${candidate.title}》准备点赞；${activity.id}`,
    accountId,
  );
  h.status(accountId, `正在随机点赞《${candidate.title}》`);
  try {
    const result = await h.participation.executeInteraction(
      {
        id: activity.id,
        version: activity.version,
        decision: {
          source: "rule",
          rule: "autocare_random_like",
          relevance: null,
          basis:
            "用户已开启随机点赞规则；本次从尚无点赞记录且已取得完整上下文的回答或文章中随机选择一项，不代表本人逐项确认或AI相关性判断。",
          quote: text.slice(0, 120),
        },
      },
      {
        planId: autocareRandomLikeScope,
        planRevision: h.state.revision,
        rulesAuthorized: true,
        autocareRun: autocareInteractionRunContext(h),
        dailyLimit: h.state.config.interactionDailyLimit,
        gapMinutes: autocareRunGapMinutes,
        excludedUids: [],
        guard: check,
      },
    );
    recordRandomInteractionResult(h, result);
  } catch (error) {
    h.log(
      "random_like.blocked",
      `${safeMessage(error)}；${activity.id}`,
      accountId,
      "warning",
    );
    throw error;
  }
}

import { zhihuTaskNeedsReconciliation } from "../../shared/zhihu";
import type { ZhihuParticipationActivity } from "../../shared/zhihu-participation";
import {
  autocareRandomLikeScope,
  autocareRandomCommentScope,
  autocareRandomFollowScope,
} from "../../shared/zhihu-autocare";
import { AppError, safeMessage } from "../errors";
import type { AutocareParticipationHost } from "./participation";
import {
  autocareRunGapMinutes,
  findAutocareRunSlot,
  withinAutocareRun,
} from "./run-window";

export function autocareInteractionRunContext(h: AutocareParticipationHost) {
  const run = h.state.run;
  if (!run || !withinAutocareRun(h.state))
    throw new AppError(
      "AUTOCARE_INTERACTION_BLOCKED",
      "当前没有可执行的两小时自动养号批次",
    );
  return { startedAt: run.startedAt, deadlineAt: run.deadlineAt };
}

export interface AutocareInteractionWait {
  /** Exhausting an interaction quota ends this action, not the account's other work. */
  status?: "exhausted";
  message: string;
  /** A local scheduling estimate, never permission to bypass submission checks. */
  nextAt: string | null;
}

export function nextRandomInteractionAt(
  h: AutocareParticipationHost,
  accountId: string,
  after: number,
) {
  const participation = h.participation.snapshot();
  const reservations = [
    ...h.zhihu
      .snapshot()
      .tasks.filter((task) => task.attemptedAt || task.status === "queued")
      .map((task) => ({
        at: task.attemptedAt ?? task.scheduledAt,
        accountId: task.accountId,
      })),
    ...participation.activities.flatMap((activity) => [
      ...(activity.attempts ?? []).map((attempt) => ({
        at: attempt.submittedAt ?? attempt.startedAt,
        accountId: activity.accountId,
      })),
      ...(activity.status === "queued" &&
      activity.automation &&
      activity.scheduledAt
        ? [{ at: activity.scheduledAt, accountId: activity.accountId }]
        : []),
    ]),
    ...Object.entries(h.state.cycles)
      .filter(([owner]) => owner !== accountId)
      .map(([owner, cycle]) => ({ at: cycle.at, accountId: owner })),
  ];
  const start = Math.max(Date.now() + 1000, after);
  return findAutocareRunSlot(h.state, start, reservations);
}

/** Local preflight reuses submission quotas; no browser, write or paid request. */
export function randomInteractionAvailability(
  h: AutocareParticipationHost,
  accountId: string,
): AutocareInteractionWait | null {
  try {
    if (!withinAutocareRun(h.state))
      return {
        message: "本批次尚未开始或已到两小时截止，未安排新互动",
        nextAt: null,
      };
    try {
      h.participation.assertInteractionAvailable(
        accountId,
        {
          dailyLimit: h.state.config.interactionDailyLimit,
          gapMinutes: autocareRunGapMinutes,
        },
        {
          planId:
            h.state.config.randomLikes || h.state.config.likeCandidates
              ? autocareRandomLikeScope
              : h.state.config.randomComments
                ? autocareRandomCommentScope
                : autocareRandomFollowScope,
          rulesAuthorized: true,
          autocareRun: autocareInteractionRunContext(h),
        },
      );
    } catch (error) {
      const message = safeMessage(error);
      const exhausted =
        message.includes("互动日额度") ||
        message.includes("本批次跨计划共享的互动上限");
      // Only known time-based gates can be scheduled automatically. Identity,
      // unreadable history and unknown submissions require explicit recovery.
      const after = message.includes("错峰间隔") ? Date.now() : null;
      return {
        ...(exhausted ? { status: "exhausted" as const } : {}),
        message: exhausted ? `${message}；本批次不安排跨日补做` : message,
        nextAt:
          after === null ? null : nextRandomInteractionAt(h, accountId, after),
      };
    }
    const snapshot = h.zhihu.snapshot();
    if (
      snapshot.tasks.some(
        (t) => t.accountId === accountId && zhihuTaskNeedsReconciliation(t),
      )
    )
      return { message: "存在待核对发布结果，随机互动暂停", nextAt: null };
    const gap = autocareRunGapMinutes * 60000;
    if (
      snapshot.tasks.some(
        (t) =>
          t.status === "queued" &&
          Math.abs(Date.parse(t.scheduledAt) - Date.now()) < gap,
      ) ||
      h.participation
        .snapshot()
        .activities.some(
          (a) =>
            a.status === "queued" &&
            a.automation &&
            a.scheduledAt &&
            Math.abs(Date.parse(a.scheduledAt) - Date.now()) < gap,
        )
    )
      return {
        message: "附近已有发布或互动排期，随机互动等待错峰",
        nextAt: nextRandomInteractionAt(h, accountId, Date.now()),
      };
    return null;
  } catch (error) {
    return { message: safeMessage(error), nextAt: null };
  }
}

/** Existing single-action callers only need the blocking reason. */
export function randomInteractionWait(
  h: AutocareParticipationHost,
  accountId: string,
) {
  return randomInteractionAvailability(h, accountId)?.message ?? null;
}

export function randomInteractionGuard(
  h: AutocareParticipationHost,
  accountId: string,
  kind: "like" | "comment" | "follow",
) {
  const revision = h.state.revision;
  return () => {
    h.guard();
    const account = h.zhihu.snapshot().accounts.find((a) => a.id === accountId);
    if (
      h.state.revision !== revision ||
      !(kind === "like"
        ? h.state.config.randomLikes || h.state.config.likeCandidates
        : kind === "comment"
          ? h.state.config.randomComments
          : h.state.config.followCandidates) ||
      !h.state.config.accountIds.includes(accountId) ||
      !account ||
      account.status !== "connected" ||
      account.uid !== h.state.identities[accountId] ||
      h.state.researchStops[accountId] ||
      !withinAutocareRun(h.state)
    )
      throw new AppError(
        "AUTOCARE_INTERACTION_BLOCKED",
        "随机互动权限、账号或运营时段已变化，未继续操作",
      );
    if (
      h.zhihu
        .snapshot()
        .tasks.some(
          (t) => t.accountId === accountId && zhihuTaskNeedsReconciliation(t),
        )
    )
      throw new AppError(
        "AUTOCARE_INTERACTION_BLOCKED",
        "存在待核对发布结果，未继续互动",
      );
  };
}

export function recordRandomInteractionResult(
  h: AutocareParticipationHost,
  result: ZhihuParticipationActivity,
) {
  const label =
    result.kind === "comment"
      ? "随机评论"
      : result.kind === "follow"
        ? "自动关注"
        : "随机点赞";
  const event =
    result.kind === "comment"
      ? "random_comment"
      : result.kind === "follow"
        ? "random_follow"
        : "random_like";
  const title = result.context?.title || "原目标";
  const attempt = result.attempts?.at(-1);
  const message =
    attempt?.receipt?.outcome === "already_present"
      ? `《${title}》原本已有此互动，未重复操作`
      : attempt?.receipt?.outcome === "performed"
        ? `${label}已由官方页面核实：《${title}》`
        : attempt?.error || `${label}未取得成功回执，请查看原记录`;
  h.log(
    `${event}.result`,
    `${message}；${result.id}`,
    result.accountId,
    result.status === "succeeded" ? "info" : "warning",
  );
  h.status(result.accountId, message, result.status === "attention");
  if (result.status === "attention") {
    h.state.researchStops[result.accountId] =
      `${message}；正在保留原提交，核对后自动恢复其他任务`;
    h.state.researchStopDetails[result.accountId] = {
      kind: "interaction",
      uid: h.state.identities[result.accountId],
      at: new Date().toISOString(),
      activityId: result.id,
    };
    h.persist();
  }
}

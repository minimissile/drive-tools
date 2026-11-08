import {
  autocareParticipationScope,
  autocareRandomCommentScope,
  autocareRandomLikeScope,
  autocareRandomFollowScope,
  type AutocareDayPlan,
  type AutocareState,
} from "../../shared/zhihu-autocare";
import type { ZhihuSnapshot } from "../../shared/zhihu";
import type { ZhihuParticipationSnapshot } from "../../shared/zhihu-participation";
import { autocareRunWindow } from "./run-window";
import { zhihuDay, zhihuWeek } from "../zhihu/policy";
import { autocareAccountDomain } from "./domain";

/** Projection of saved rules and real records, not fabricated future task times. */
export function autocareDayPlan(
  state: AutocareState,
  zhihu: ZhihuSnapshot,
  participation: ZhihuParticipationSnapshot,
  at = Date.now(),
): AutocareDayPlan {
  const date = zhihuDay(at),
    week = zhihuWeek(at),
    cfg = state.config;
  const run = autocareRunWindow(state);
  const inRun = (stamp: string) =>
    !!run && Date.parse(stamp) >= run.start && Date.parse(stamp) < run.end;
  const modeScopes = [
    autocareParticipationScope,
    autocareRandomLikeScope,
    autocareRandomCommentScope,
    autocareRandomFollowScope,
  ];
  const actions = [
    ...(cfg.publish ? ["自动发文"] : []),
    ...(cfg.answerRecommended ? ["推荐问题回答"] : []),
    ...(cfg.randomLikes || cfg.likeCandidates ? ["自动点赞"] : []),
    ...(cfg.randomComments ? ["自动评论"] : []),
    ...(cfg.readRecommended ? ["读取推荐内容"] : []),
    ...(cfg.followCandidates ? ["自动关注作者"] : []),
  ];
  return {
    date,
    ...(state.run
      ? {
          startedAt: state.run.startedAt,
          deadlineAt: state.run.deadlineAt,
          runStatus: state.run.status,
        }
      : {}),
    windowStart: cfg.windowStart,
    windowEnd: cfg.windowEnd,
    accounts: cfg.accountIds.map((accountId) => {
      const account = zhihu.accounts.find((entry) => entry.id === accountId);
      const uid = state.identities[accountId];
      const tasks = zhihu.tasks.filter((task) => task.accountId === accountId);
      const publicationAttempts = tasks.filter(
        (task) => task.attemptedAt && zhihuDay(task.attemptedAt) === date,
      );
      const weeklyAttempts = tasks.filter(
        (task) => task.attemptedAt && zhihuWeek(task.attemptedAt) === week,
      ).length;
      const limit = cfg.publish || cfg.answerRecommended ? cfg.dailyLimit : 0;
      const weeklyLimit = cfg.weeklyLimit;
      const answerRemaining =
        !cfg.publish && cfg.answerRecommended
          ? cfg.answersPerDay -
            Math.max(
              publicationAttempts.filter((task) => task.kind === "answer")
                .length,
              tasks.filter(
                (task) =>
                  task.kind === "answer" &&
                  task.attemptedAt &&
                  inRun(task.attemptedAt),
              ).length,
            )
          : Number.POSITIVE_INFINITY;
      const ownedTasks = new Set(
        state.jobs
          .filter((job) => job.accountId === accountId && job.uid === uid)
          .map((job) => job.taskId),
      );
      const attempts = participation.activities
        .filter((activity) => activity.accountId === accountId)
        .flatMap((activity) =>
          (activity.attempts ?? []).map((attempt) => ({ activity, attempt })),
        )
        .filter(
          ({ attempt }) =>
            zhihuDay(attempt.submittedAt ?? attempt.startedAt) === date,
        );
      const interactionLimit =
        cfg.randomLikes ||
        cfg.randomComments ||
        cfg.likeCandidates ||
        cfg.followCandidates
          ? cfg.interactionDailyLimit
          : 0;
      const researchLimit =
        cfg.readRecommended ||
        cfg.answerRecommended ||
        cfg.randomLikes ||
        cfg.randomComments ||
        cfg.likeCandidates ||
        cfg.followCandidates
          ? cfg.researchPerDay
          : 0;
      const reads = state.research.filter(
        (read) => read.accountId === accountId && zhihuDay(read.at) === date,
      ).length;
      const cycle = state.cycles[accountId];
      const domain = autocareAccountDomain(cfg, accountId);
      const weeklyWait =
        limit > 0 && weeklyAttempts >= weeklyLimit
          ? "本周发布额度已用尽，互动仍按独立额度安排"
          : "";
      const officialPublications = publicationAttempts.filter(
        (task) =>
          ownedTasks.has(task.id) &&
          task.uid === uid &&
          task.status === "published" &&
          task.message === "已收到知乎官方发布回执",
      );
      return {
        accountId,
        actions: [
          ...(cfg.publish || cfg.answerRecommended
            ? [
                domain
                  ? `围绕领域“${domain}”持续内容营销`
                  : `提升创作分至Lv.${cfg.targetLevel}，达标后停止创作`,
              ]
            : []),
          ...actions,
        ],
        publication: {
          limit,
          attempts: publicationAttempts.length,
          // The published status also accepts self-reports. Count only the
          // executor's explicit official receipt marker until a typed receipt exists.
          completed: officialPublications.length,
          articleCompleted: officialPublications.filter(
            (task) => task.kind === "article",
          ).length,
          answerCompleted: officialPublications.filter(
            (task) => task.kind === "answer",
          ).length,
          remaining: Math.max(
            0,
            Math.min(
              limit -
                Math.max(
                  publicationAttempts.length,
                  tasks.filter(
                    (task) => task.attemptedAt && inRun(task.attemptedAt),
                  ).length,
                ),
              weeklyLimit - weeklyAttempts,
              answerRemaining,
            ),
          ),
        },
        interaction: {
          limit: interactionLimit,
          attempts: attempts.length,
          completed: attempts.filter(
            ({ activity, attempt }) =>
              modeScopes.includes(activity.planId ?? "") &&
              attempt.request.actorUid === uid &&
              attempt.receipt?.evidence === "official_ui" &&
              attempt.receipt.outcome === "performed",
          ).length,
          remaining: Math.max(
            0,
            interactionLimit -
              Math.max(
                attempts.length,
                participation.activities
                  .filter((activity) => activity.accountId === accountId)
                  .flatMap((activity) => activity.attempts ?? [])
                  .filter((attempt) =>
                    inRun(attempt.submittedAt ?? attempt.startedAt),
                  ).length,
              ),
          ),
        },
        research: {
          limit: researchLimit,
          used: reads,
          remaining: Math.max(
            0,
            researchLimit -
              Math.max(
                reads,
                state.research.filter(
                  (read) => read.accountId === accountId && inRun(read.at),
                ).length,
              ),
          ),
        },
        scheduledPublications: tasks
          .filter(
            (task) =>
              ownedTasks.has(task.id) &&
              task.uid === uid &&
              task.status === "queued" &&
              (run
                ? inRun(task.scheduledAt)
                : zhihuDay(task.scheduledAt) === date),
          )
          .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
          .map((task) => ({
            id: task.id,
            kind: task.kind,
            title: task.title,
            at: task.scheduledAt,
          })),
        next:
          state.enabled &&
          state.run?.status === "running" &&
          cycle?.revision === state.revision &&
          cycle.uid === uid
            ? { kind: cycle.kind, at: cycle.at }
            : null,
        waitingReason: !state.enabled
          ? "总开关已关闭，保留设置与历史安排"
          : [state.accountMessages[accountId], weeklyWait]
              .filter(Boolean)
              .join("；"),
      };
    }),
  };
}

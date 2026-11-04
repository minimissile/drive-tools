import { z } from "zod";
import { websiteAccountIdSchema } from "../../shared/website-accounts";
import {
  zhihuResearchHitSchema,
  zhihuResearchDocumentSchema,
  zhihuParticipationKinds,
  type ZhihuParticipationCandidate,
  type ZhihuParticipationActivity,
} from "../../shared/zhihu-participation";
import type { Database } from "../database";
import {
  zhihuInteractionAttemptSchema,
  zhihuStoredInteractionDecisionSchema,
  zhihuInteractionContinuationSchema,
  isUnsubmittedTechnicalInteractionAttempt,
} from "../../shared/zhihu-interaction";

export const zhihuParticipationStateKey = "zhihuParticipation:v1";
export const participationCandidateSchema: z.ZodType<ZhihuParticipationCandidate> =
  zhihuResearchHitSchema.safeExtend({
    id: z.string().regex(/^zhcandidate_[\w-]+$/),
    accountId: websiteAccountIdSchema,
    version: z.number().int().positive(),
    document: zhihuResearchDocumentSchema.nullable(),
    checkedAt: z.iso.datetime(),
  });
export const participationActivitySchema: z.ZodType<ZhihuParticipationActivity> =
  z.object({
    id: z.string().regex(/^zhactivity_[\w-]+$/),
    accountId: websiteAccountIdSchema,
    planId: z
      .string()
      .regex(/^(?:ioplan|autocare)_[\w-]+$/)
      .nullable(),
    candidateId: z.string().regex(/^zhcandidate_[\w-]+$/),
    candidateVersion: z.number().int().positive(),
    kind: z.enum(zhihuParticipationKinds),
    reason: z.string().max(2000),
    draft: z.string().max(13000),
    createdAt: z.iso.datetime(),
    scheduledAt: z.iso.datetime().nullable(),
    status: z.enum([
      "planned",
      "needs_review",
      "prepared",
      "done",
      "skipped",
      "executing",
      "queued",
      "succeeded",
      "attention",
      "failed",
    ]),
    contentId: z.string().max(150).nullable(),
    version: z.number().int().positive(),
    basis: z.string().max(4000),
    context: zhihuResearchDocumentSchema.nullable(),
    attempts: zhihuInteractionAttemptSchema.array().max(20).optional(),
    automation: z
      .object({
        planRevision: z.number().int().positive(),
        decision: zhihuStoredInteractionDecisionSchema,
        queuedAt: z.iso.datetime(),
        continuation: zhihuInteractionContinuationSchema.optional(),
      })
      .optional(),
    resolution: z
      .object({
        outcome: z.enum(["done", "skipped"]),
        note: z.string().max(2000),
        at: z.iso.datetime(),
        evidence: z.literal("self_report"),
      })
      .nullable(),
  });
export const zhihuParticipationStateSchema = z
  .object({
    version: z.literal(1),
    candidates: participationCandidateSchema.array().max(500),
    activities: participationActivitySchema.array().max(2000),
    discoveryCache: z
      .object({
        accountId: websiteAccountIdSchema,
        query: z.string().max(200),
        source: z.enum(["search", "creator_recommend"]).optional(),
        kind: z.enum(["question", "author"]),
        candidateIds: z.string().array().max(50),
        observedAt: z.iso.datetime(),
      })
      .array()
      .max(500)
      .default([]),
  })
  .superRefine((state, ctx) => {
    const candidates = new Map(state.candidates.map((item) => [item.id, item]));
    if (
      candidates.size !== state.candidates.length ||
      new Set(state.candidates.map((item) => `${item.accountId}:${item.url}`))
        .size !== state.candidates.length
    )
      ctx.addIssue({ code: "custom", message: "候选ID或账号链接重复" });
    if (
      new Set(state.activities.map((item) => item.id)).size !==
      state.activities.length
    )
      ctx.addIssue({ code: "custom", message: "参与任务ID重复" });
    for (const activity of state.activities) {
      if (
        candidates.get(activity.candidateId)?.accountId !== activity.accountId
      )
        ctx.addIssue({
          code: "custom",
          message: "参与任务与候选账号归属不一致",
        });
      if (
        ["done", "skipped"].includes(activity.status) !== !!activity.resolution
      )
        ctx.addIssue({
          code: "custom",
          message: "本人完成记录与任务状态不一致",
        });
      const attempts = activity.attempts ?? [];
      if (
        activity.status === "queued" &&
        (!activity.automation ||
          !activity.scheduledAt ||
          (attempts.length &&
            (!activity.automation.continuation ||
              !attempts.every(isUnsubmittedTechnicalInteractionAttempt) ||
              attempts.at(-1)?.id !==
                activity.automation.continuation.attemptId ||
              attempts.at(-1)?.request.fingerprint !==
                activity.automation.continuation.requestFingerprint)) ||
          !["like", "comment", "follow"].includes(activity.kind))
      )
        ctx.addIssue({
          code: "custom",
          message: "互动排期缺少精确决策、时间或含执行历史",
        });
      if (
        new Set(attempts.map((attempt) => attempt.id)).size !== attempts.length
      )
        ctx.addIssue({ code: "custom", message: "互动尝试ID重复" });
      if (attempts.length && activity.resolution)
        ctx.addIssue({
          code: "custom",
          message: "真实互动尝试不能被本人记录覆盖",
        });
      for (const attempt of attempts) {
        if (
          attempt.planId !== activity.planId ||
          attempt.request.kind !== activity.kind ||
          attempt.request.url !== candidates.get(activity.candidateId)?.url
        )
          ctx.addIssue({
            code: "custom",
            message: "互动尝试与原任务范围不一致",
          });
        if (attempt.status === "succeeded" && !attempt.receipt)
          ctx.addIssue({ code: "custom", message: "互动成功缺少官方页面证据" });
        if (
          attempt.receipt &&
          (attempt.receipt.actorUid !== attempt.request.actorUid ||
            attempt.receipt.url !== attempt.request.url ||
            attempt.receipt.kind !== attempt.request.kind)
        )
          ctx.addIssue({
            code: "custom",
            message: "互动回执与原尝试身份或目标不一致",
          });
        if (attempt.receipt?.outcome === "performed" && !attempt.submittedAt)
          ctx.addIssue({
            code: "custom",
            message: "真实执行回执缺少原提交检查点",
          });
        if (
          attempt.receipt &&
          attempt.request.kind === "comment" &&
          (!attempt.receipt.commentId ||
            attempt.receipt.text !== attempt.request.text)
        )
          ctx.addIssue({
            code: "custom",
            message: "评论回执缺少准确原文或官方评论ID",
          });
      }
      if (
        activity.status === "succeeded" &&
        !attempts.some(
          (attempt) => attempt.status === "succeeded" && !!attempt.receipt,
        )
      )
        ctx.addIssue({ code: "custom", message: "活动成功缺少可核对的原尝试" });
    }
  });
export type ZhihuParticipationState = z.output<
  typeof zhihuParticipationStateSchema
>;
export function readParticipationState(db: Database): ZhihuParticipationState {
  return zhihuParticipationStateSchema.parse(
    db.setting(zhihuParticipationStateKey, {
      version: 1,
      candidates: [],
      activities: [],
    }),
  );
}

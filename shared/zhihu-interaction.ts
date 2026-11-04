import { z } from "zod";
import { canonicalZhihuParticipationUrl } from "./zhihu-participation";

export const zhihuInteractionKinds = ["like", "comment", "follow"] as const;
export const zhihuInteractionKindSchema = z.enum(zhihuInteractionKinds);
export type ZhihuInteractionKind = z.infer<typeof zhihuInteractionKindSchema>;
const url = z
  .string()
  .max(1000)
  .refine(
    (v) => canonicalZhihuParticipationUrl(v) === v,
    "需要规范的知乎官方目标链接",
  );
export const zhihuInteractionDecisionSchema = z.object({
  relevance: z.number().min(0.8).max(1),
  basis: z.string().trim().min(20).max(2000),
  quote: z.string().trim().min(8).max(1000),
});
export const zhihuHumanInteractionDecisionSchema = z.object({
  source: z.literal("human"),
  relevance: z.null(),
  basis: z.string().trim().min(20).max(2000),
  quote: z.string().trim().min(8).max(1000),
});
export const zhihuStoredInteractionDecisionSchema = z.union([
  zhihuInteractionDecisionSchema,
  zhihuHumanInteractionDecisionSchema,
]);
export type ZhihuInteractionDecision = z.infer<
  typeof zhihuStoredInteractionDecisionSchema
>;
export const zhihuInteractionRequestSchema = z.object({
  kind: zhihuInteractionKindSchema,
  url,
  actorUid: z.string().min(1).max(150),
  excludedUids: z.string().min(1).max(150).array().max(100),
  text: z.string().max(1000),
  contextText: z.string().min(1).max(16000),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ZhihuInteractionRequest = z.infer<
  typeof zhihuInteractionRequestSchema
>;
export const zhihuInteractionReceiptSchema = z.object({
  evidence: z.literal("official_ui"),
  kind: zhihuInteractionKindSchema,
  url,
  actorUid: z.string().min(1).max(150),
  targetAuthorUid: z.string().min(1).max(150),
  targetId: z.string().min(1).max(150),
  outcome: z.enum(["performed", "already_present"]),
  state: z.enum(["liked", "commented", "following"]),
  commentId: z.string().min(1).max(150).nullable(),
  text: z.string().max(1000),
  observedAt: z.iso.datetime(),
  summary: z.string().min(1).max(2000),
});
export type ZhihuInteractionReceipt = z.infer<
  typeof zhihuInteractionReceiptSchema
>;
export const zhihuInteractionAttemptSchema = z.object({
  id: z.string().regex(/^zhattempt_[\w-]+$/),
  planId: z.string().regex(/^(?:ioplan|autocare)_[\w-]+$/),
  planRevision: z.number().int().positive(),
  activityVersion: z.number().int().positive(),
  networkKey: z.string().max(200).optional(),
  decision: zhihuStoredInteractionDecisionSchema,
  request: zhihuInteractionRequestSchema,
  startedAt: z.iso.datetime(),
  submittedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  status: z.enum(["running", "succeeded", "failed", "unknown"]),
  receipt: zhihuInteractionReceiptSchema.nullable(),
  error: z.string().max(3000),
});
export type ZhihuInteractionAttempt = z.infer<
  typeof zhihuInteractionAttemptSchema
>;
/** A continuation is possible only for a recorded local DOM failure before the
 * irreversible checkpoint. This whitelist never treats platform/identity stops
 * or an unknown result as a recoverable UI error. */
export function isUnsubmittedTechnicalInteractionAttempt(
  attempt: ZhihuInteractionAttempt,
): boolean {
  return (
    attempt.status === "failed" &&
    attempt.submittedAt === null &&
    attempt.receipt === null &&
    !!attempt.finishedAt &&
    !/验证码|验证|实名|协议|限制|频繁|身份|登录|待核对|结果未知|captcha|verification|login|sign.?in|rate.?limit|forbidden|unauthorized/i.test(
      attempt.error,
    ) &&
    /^locator\.(?:waitFor|fill|click):/.test(attempt.error) &&
    /Timeout|strict mode violation|not attached|not visible/i.test(
      attempt.error,
    )
  );
}
export const zhihuInteractionContinuationSchema = z.object({
  attemptId: z.string().regex(/^zhattempt_[\w-]+$/),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  fromVersion: z.number().int().positive(),
  at: z.iso.datetime(),
  repair: z.string().trim().min(20).max(2000),
});
export type ZhihuInteractionContinuation = z.infer<
  typeof zhihuInteractionContinuationSchema
>;
export interface ZhihuInteractionBrowserPort {
  execute(
    account: import("./website-accounts").WebsiteAccount,
    input: {
      request: ZhihuInteractionRequest;
      guard(): void;
      onSubmitting(): void | Promise<void>;
    },
  ): Promise<ZhihuInteractionReceipt>;
  reconcile(
    account: import("./website-accounts").WebsiteAccount,
    input: {
      request: ZhihuInteractionRequest;
      submittedAt: string;
    },
  ): Promise<ZhihuInteractionReceipt | null>;
}
export const zhihuInteractionExecuteInput = z.object({
  id: z.string().regex(/^zhactivity_[\w-]+$/),
  version: z.number().int().positive(),
  decision: zhihuStoredInteractionDecisionSchema,
});
export const zhihuInteractionReconcileInput = z.object({
  id: z.string().regex(/^zhactivity_[\w-]+$/),
  version: z.number().int().positive(),
});
export const zhihuInteractionQueueInput = zhihuInteractionExecuteInput.extend({
  scheduledAt: z.iso.datetime(),
});
/** Explicit local continuation of the exact original task, not a new action. */
export const zhihuInteractionContinueInput =
  zhihuInteractionReconcileInput.extend({
    attemptId: z.string().regex(/^zhattempt_[\w-]+$/),
    scheduledAt: z.iso.datetime(),
    repair: z.string().trim().min(20).max(2000),
    confirmed: z.literal(true),
  });

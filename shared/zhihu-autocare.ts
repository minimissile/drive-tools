import { z } from "zod";
import type {
  ZhihuParticipationActivity,
  ZhihuParticipationCandidate,
} from "./zhihu-participation";
import type { ZhihuSnapshot } from "./zhihu";
import type { RuntimeLogPage, runtimeLogQuery } from "./runtime-logs";
export const autocareConfigSchema = z
  .object({
    accountIds: z.string().min(1).max(150).array().max(20).default([]),
    accountTargets: z
      .record(
        z.string().min(1).max(150),
        z.object({
          enabled: z.boolean().default(false),
          domain: z.string().trim().max(120).default(""),
        }),
      )
      .default({}),
    publish: z.boolean().default(true),
    answerRecommended: z.boolean().default(false),
    readRecommended: z.boolean().default(false),
    likeCandidates: z.boolean().default(false),
    randomLikes: z.boolean().default(false),
    randomComments: z.boolean().default(false),
    followCandidates: z.boolean().default(false),
    answersPerDay: z.number().int().min(1).max(3).default(2),
    researchPerDay: z.number().int().min(1).max(10).default(4),
    interactionDailyLimit: z.number().int().min(1).max(10).default(4),
    dailyLimit: z.number().int().min(1).max(10).default(3),
    weeklyLimit: z.number().int().min(1).max(70).default(10),
    targetLevel: z.number().int().min(4).max(10).default(5),
    windowStart: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .default("09:00"),
    windowEnd: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .default("21:00"),
    gapMinutes: z.number().int().min(5).max(1440).default(5),
    generationsPerDay: z.number().int().min(1).max(30).default(8),
    includeComments: z.boolean().default(false),
  })
  .refine((v) => v.windowStart < v.windowEnd, {
    message: "结束时间须晚于开始时间",
  })
  .refine((v) => v.dailyLimit <= v.weeklyLimit, {
    message: "周上限不能低于日上限",
  });
export type AutocareConfig = z.output<typeof autocareConfigSchema>;
export const autocareJobSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  uid: z.string(),
  kind: z.enum(["article", "answer"]).default("article"),
  candidateId: z.string().optional(),
  questionUrl: z.string().optional(),
  sourceId: z.string(),
  sourceHash: z.string(),
  status: z.enum([
    "collecting",
    "generating",
    "ready",
    "queued",
    "published",
    "skipped",
    "attention",
    "cancelled",
  ]),
  message: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  generatedAt: z.iso.datetime().optional(),
  model: z.string().default(""),
  templateVersion: z.literal(1).default(1),
  contentId: z.string().optional(),
  fingerprint: z.string().optional(),
  taskId: z.string().optional(),
  scheduledAt: z.iso.datetime().optional(),
  url: z.string().optional(),
  checks: z.string().array().default([]),
});
export type AutocareJob = z.output<typeof autocareJobSchema>;
export const autocareCommentJobSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  uid: z.string(),
  candidateId: z.string(),
  candidateVersion: z.number().int().positive(),
  url: z.string(),
  contextHash: z.string(),
  revision: z.number().int().positive(),
  model: z.string(),
  status: z.enum([
    "generating",
    "ready",
    "skipped",
    "attention",
    "completed",
    "cancelled",
  ]),
  message: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  generatedAt: z.iso.datetime().optional(),
  body: z.string().max(1000).default(""),
  quote: z.string().max(1000).default(""),
  checks: z.string().array().default([]),
  activityId: z.string().optional(),
});
export type AutocareCommentJob = z.output<typeof autocareCommentJobSchema>;
export const autocareStateSchema = z.object({
  version: z.literal(1),
  batchPolicyVersion: z.number().int().min(0).default(0),
  config: autocareConfigSchema,
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  identities: z.record(z.string(), z.string()).default({}),
  model: z.string().default(""),
  run: z
    .object({
      id: z.string(),
      startedAt: z.iso.datetime(),
      deadlineAt: z.iso.datetime(),
      status: z.enum(["running", "completed", "expired"]),
    })
    .nullable()
    .default(null),
  cycles: z
    .record(
      z.string(),
      z.object({
        id: z.string(),
        at: z.iso.datetime(),
        uid: z.string(),
        revision: z.number().int().positive(),
        kind: z.enum(["prepare", "research", "interaction"]),
        targets: z.string().array().default([]),
      }),
    )
    .default({}),
  nextResearchAt: z.record(z.string(), z.iso.datetime()).default({}),
  nextRecommendationAt: z.record(z.string(), z.iso.datetime()).default({}),
  recommendationUids: z.record(z.string(), z.string()).default({}),
  recommendationAttemptUids: z.record(z.string(), z.string()).default({}),
  interactionDiscovery: z
    .record(
      z.string(),
      z.object({ runId: z.string(), followChecked: z.boolean() }),
    )
    .default({}),
  researchStops: z.record(z.string(), z.string()).default({}),
  researchStopDetails: z
    .record(
      z.string(),
      z.object({
        kind: z.enum([
          "authentication",
          "verification",
          "interaction",
          "other",
        ]),
        uid: z.string(),
        at: z.iso.datetime(),
        activityId: z.string().optional(),
      }),
    )
    .default({}),
  research: z
    .object({
      id: z.string(),
      accountId: z.string(),
      uid: z.string(),
      candidateId: z.string(),
      at: z.iso.datetime(),
      status: z.enum(["reading", "saved", "failed"]),
      message: z.string(),
    })
    .array()
    .max(2000)
    .default([]),
  jobs: autocareJobSchema.array().max(5000),
  commentJobs: autocareCommentJobSchema.array().max(2000).default([]),
  blockedAccountIds: z.string().array().default([]),
  accountMessages: z.record(z.string(), z.string()).default({}),
  message: z.string(),
  lastHeartbeatAt: z.iso.datetime().nullable(),
  nextCheckAt: z.iso.datetime().nullable(),
});
export type AutocareState = z.output<typeof autocareStateSchema>;
export interface AutocareDayPlan {
  startedAt?: string;
  deadlineAt?: string;
  runStatus?: "running" | "completed" | "expired";
  date: string;
  windowStart: string;
  windowEnd: string;
  accounts: {
    accountId: string;
    actions: string[];
    publication: {
      limit: number;
      attempts: number;
      completed: number;
      articleCompleted?: number;
      answerCompleted?: number;
      remaining: number;
    };
    interaction: {
      limit: number;
      attempts: number;
      completed: number;
      remaining: number;
    };
    research: { limit: number; used: number; remaining: number };
    scheduledPublications: {
      id: string;
      kind: "article" | "answer";
      title: string;
      at: string;
    }[];
    next: { kind: "prepare" | "research" | "interaction"; at: string } | null;
    waitingReason: string;
  }[];
}
export interface AutocareBlocker {
  accountId: string;
  kind:
    | "account"
    | "publication"
    | "interaction"
    | "generation"
    | "restriction"
    | "configuration";
  message: string;
  blocking: boolean;
  taskId?: string;
  activityId?: string;
  jobId?: string;
  recoverable?: boolean;
}
export interface AutocareSnapshot extends AutocareState {
  blockers?: AutocareBlocker[];
  todayPlan?: AutocareDayPlan;
  busy: boolean;
  accounts: ZhihuSnapshot["accounts"];
  modelName: string;
  generationCount: number;
  requestsRemaining: number;
  requestsLimit: number;
  listPagesPerRun: number;
  needsAttention: boolean;
  globalAiBudgetMicros: number | null;
  participation: {
    candidates: ZhihuParticipationCandidate[];
    activities: ZhihuParticipationActivity[];
  };
}
export const autocareParticipationScope = "autocare_rules";
export const autocareRandomLikeScope = "autocare_random_likes";
export const autocareRandomCommentScope = "autocare_random_comments";
export const autocareRandomFollowScope = "autocare_random_follows";
export const autocareInteractionInput = z.object({
  id: z.string().regex(/^zhactivity_[\w-]+$/),
  version: z.number().int().positive(),
  revision: z.number().int().positive(),
  basis: z.string().trim().min(20).max(2000),
  quote: z.string().trim().min(8).max(1000),
  confirmed: z.literal(true),
});
type Contract<A, V> = { args: A; value: V };
export interface AutocareContract {
  "zhihu.autocare.snapshot": Contract<undefined, AutocareSnapshot>;
  "zhihu.autocare.save": Contract<
    { config: z.input<typeof autocareConfigSchema>; revision: number },
    AutocareSnapshot
  >;
  "zhihu.autocare.toggle": Contract<
    { enabled: boolean; revision: number; confirmed: true },
    AutocareSnapshot
  >;
  "zhihu.autocare.recheck": Contract<{ revision: number }, AutocareSnapshot>;
  "zhihu.autocare.interact": Contract<
    z.input<typeof autocareInteractionInput>,
    AutocareSnapshot
  >;
  "zhihu.autocare.refreshInteraction": Contract<
    { id: string; version: number },
    AutocareSnapshot
  >;
  "zhihu.autocare.reconcile": Contract<
    { id: string; version: number },
    AutocareSnapshot
  >;
  "zhihu.autocare.logs": Contract<
    z.input<typeof runtimeLogQuery>,
    RuntimeLogPage
  >;
}

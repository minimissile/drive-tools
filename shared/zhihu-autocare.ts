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
    publish: z.boolean().default(true),
    answerRecommended: z.boolean().default(false),
    readRecommended: z.boolean().default(false),
    likeCandidates: z.boolean().default(false),
    followCandidates: z.boolean().default(false),
    answersPerDay: z.number().int().min(1).max(2).default(1),
    researchPerDay: z.number().int().min(1).max(10).default(3),
    interactionDailyLimit: z.number().int().min(1).max(10).default(3),
    dailyLimit: z.number().int().min(1).max(10).default(2),
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
    gapMinutes: z.number().int().min(60).max(1440).default(60),
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
export const autocareStateSchema = z.object({
  version: z.literal(1),
  config: autocareConfigSchema,
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  identities: z.record(z.string(), z.string()).default({}),
  model: z.string().default(""),
  cycles: z
    .record(
      z.string(),
      z.object({
        id: z.string(),
        at: z.iso.datetime(),
        uid: z.string(),
        revision: z.number().int().positive(),
        kind: z.enum(["prepare", "research"]),
        targets: z.string().array().default([]),
      }),
    )
    .default({}),
  nextResearchAt: z.record(z.string(), z.iso.datetime()).default({}),
  nextRecommendationAt: z.record(z.string(), z.iso.datetime()).default({}),
  recommendationUids: z.record(z.string(), z.string()).default({}),
  recommendationAttemptUids: z.record(z.string(), z.string()).default({}),
  researchStops: z.record(z.string(), z.string()).default({}),
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
  blockedAccountIds: z.string().array().default([]),
  accountMessages: z.record(z.string(), z.string()).default({}),
  message: z.string(),
  lastHeartbeatAt: z.iso.datetime().nullable(),
  nextCheckAt: z.iso.datetime().nullable(),
});
export type AutocareState = z.output<typeof autocareStateSchema>;
export interface AutocareSnapshot extends AutocareState {
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

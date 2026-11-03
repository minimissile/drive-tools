import { z } from "zod";

export const operationsBrainPermissions = z.object({
  read: z.boolean().default(false),
  create: z.boolean().default(false),
  reviewOwn: z.boolean().default(false),
  publish: z.boolean().default(false),
});
export type OperationsBrainPermissions = z.output<
  typeof operationsBrainPermissions
>;
export const operationsBrainConfig = z
  .object({
    wakeMinutes: z.number().int().min(15).max(1440).default(60),
    maxCyclesPerDay: z.number().int().min(1).max(48).default(4),
    maxStepsPerCycle: z.number().int().min(1).max(12).default(6),
    cycleBudgetMicros: z
      .number()
      .int()
      .min(1000)
      .max(100_000_000)
      .default(200_000),
    dailyBudgetMicros: z
      .number()
      .int()
      .min(1000)
      .max(1_000_000_000)
      .default(1_000_000),
    maxCycleMinutes: z.number().int().min(1).max(20).default(5),
    permissions: operationsBrainPermissions.default(() => ({
      read: false,
      create: false,
      reviewOwn: false,
      publish: false,
    })),
  })
  .refine((v) => v.cycleBudgetMicros <= v.dailyBudgetMicros, {
    message: "每轮预算不能高于每日预算",
    path: ["cycleBudgetMicros"],
  });
export type OperationsBrainConfig = z.output<typeof operationsBrainConfig>;
export const operationsBrainCycleStatus = z.enum([
  "running",
  "completed",
  "stopped",
  "failed",
  "budget",
  "uncertain",
]);
export interface OperationsBrainStep {
  id: string;
  index: number;
  createdAt: string;
  kind: "decision" | "tool";
  tool: string | null;
  summary: string;
  success: boolean;
  costMicros: number | null;
}
export interface OperationsBrainCycle {
  id: string;
  planId: string;
  planRevision: number;
  status: z.infer<typeof operationsBrainCycleStatus>;
  model: string;
  startedAt: string;
  finishedAt: string | null;
  nextWakeAt: string | null;
  summary: string;
  costMicros: number;
  costKnown: boolean;
  steps: OperationsBrainStep[];
}
export interface OperationsBrainMemory {
  id: string;
  planId: string;
  cycleId: string;
  createdAt: string;
  text: string;
}
export interface OperationsBrainProvenance {
  id: string;
  planId: string;
  cycleId: string;
  toolCallId: string;
  materialId: string;
  accountId: string;
  fingerprint: string;
  createdAt: string;
  reviewedFingerprint: string | null;
  reviewReason: string | null;
  reviewedAt: string | null;
}
export interface OperationsBrainPlanRuntime {
  planId: string;
  authorized: boolean;
  running: boolean;
  permissions: OperationsBrainPermissions;
  nextWakeAt: string | null;
  cyclesToday: number;
  costTodayMicros: number;
  costKnown: boolean;
  message: string;
}
export interface OperationsBrainSnapshot {
  plans: OperationsBrainPlanRuntime[];
  toolsSupported: boolean | null;
  configured: boolean;
  configurationMessage: string;
  model: string;
  memory: OperationsBrainMemory[];
}
export const operationsBrainCycleQuery = z.object({
  planId: z.string().max(150).default(""),
  page: z.number().int().min(1).max(100000).default(1),
});
export interface OperationsBrainCyclePage {
  items: OperationsBrainCycle[];
  total: number;
  page: number;
  pageSize: number;
}
type Contract<A, V> = { args: A; value: V };
export interface OperationsBrainContract {
  "intelligentOps.brain.snapshot": Contract<undefined, OperationsBrainSnapshot>;
  "intelligentOps.brain.cycles": Contract<
    z.input<typeof operationsBrainCycleQuery>,
    OperationsBrainCyclePage
  >;
  "intelligentOps.brain.activate": Contract<
    {
      planId: string;
      planRevision?: number;
      active: boolean;
      permissions: OperationsBrainPermissions;
      confirmed: true;
    },
    OperationsBrainSnapshot
  >;
  "intelligentOps.brain.wake": Contract<
    { planId: string; confirmed: true },
    OperationsBrainSnapshot
  >;
}

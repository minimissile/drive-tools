import { z } from "zod";
import type { RuntimeLogPage } from "./runtime-logs";
import {
  operationsBrainConfig,
  type OperationsBrainContract,
} from "./operations-brain";

export const operationsChannels = ["zhihu", "weibo", "wechat"] as const;
export type OperationsChannel = (typeof operationsChannels)[number];
export const operationsChannelLabels: Record<OperationsChannel, string> = {
  zhihu: "知乎",
  weibo: "微博",
  wechat: "公众号",
};
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const operationsChannelPolicy = z
  .object({
    channel: z.enum(operationsChannels),
    enabled: z.boolean().default(false),
    purpose: z.enum(["warming", "regular"]).default("warming"),
    dailyLimit: z.number().int().min(1).max(10).default(2),
    gapMinutes: z.number().int().min(60).max(1440).default(60),
    windowStart: clock.default("09:00"),
    windowEnd: clock.default("21:00"),
    checkHours: z.number().int().min(1).max(168).default(24),
  })
  .refine((v) => v.windowStart < v.windowEnd, {
    message: "执行时段结束须晚于开始时间",
    path: ["windowEnd"],
  });
export const operationsAccountPolicy = z.object({
  accountId: z.string().min(1).max(150),
  channel: z.enum(operationsChannels),
  paused: z.boolean().default(false),
  dailyLimit: z.number().int().min(1).max(10).nullable().default(null),
  gapMinutes: z.number().int().min(60).max(1440).nullable().default(null),
  positioning: z.string().trim().max(1000).default(""),
  windowStart: clock.nullable().default(null),
  windowEnd: clock.nullable().default(null),
});
export const operationsPlanInput = z
  .object({
    id: z
      .string()
      .regex(/^ioplan_[\w-]+$/)
      .optional(),
    name: z.string().trim().min(1).max(100),
    goal: z.string().trim().min(1).max(2000),
    audience: z.string().trim().max(1000).default(""),
    direction: z.string().trim().max(2000).default(""),
    knowledge: z.string().trim().max(12000).default(""),
    channels: operationsChannelPolicy.array().max(3),
    accounts: operationsAccountPolicy.array().max(100),
    materialIds: z.string().min(1).max(180).array().max(500).default([]),
    mode: z.enum(["rules", "autonomous"]).default("rules"),
    brain: operationsBrainConfig.default(() => operationsBrainConfig.parse({})),
  })
  .superRefine((v, ctx) => {
    if (new Set(v.channels.map((c) => c.channel)).size !== v.channels.length)
      ctx.addIssue({
        code: "custom",
        message: "平台策略不能重复",
        path: ["channels"],
      });
    if (new Set(v.accounts.map((c) => c.accountId)).size !== v.accounts.length)
      ctx.addIssue({
        code: "custom",
        message: "账号不能重复",
        path: ["accounts"],
      });
  });
export type OperationsPlanInput = z.input<typeof operationsPlanInput>;
export interface OperationsAdvice {
  summary: string;
  suggestions: string[];
  cautions: string[];
  createdAt: string;
  model: string;
}
export interface OperationsPlan extends z.output<typeof operationsPlanInput> {
  id: string;
  revision: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  advice: OperationsAdvice | null;
}
export const operationsTaskStatuses = [
  "planned",
  "blocked",
  "review",
  "running",
  "delegated",
  "completed",
  "attention",
  "cancelled",
  "handoff",
] as const;
export type OperationsTaskStatus = (typeof operationsTaskStatuses)[number];
export interface OperationsTask {
  id: string;
  key: string;
  planId: string;
  planRevision: number;
  channel: OperationsChannel;
  accountId: string;
  accountLabel: string;
  kind:
    "publish" | "progress" | "statistics" | "reconcile" | "handoff" | "supply";
  title: string;
  reason: string;
  status: OperationsTaskStatus;
  scheduledAt: string | null;
  manualScheduledAt?: string | null;
  brainCycleId?: string | null;
  cancelOrigin?: "user" | "policy" | "restart" | "system";
  createdAt: string;
  updatedAt: string;
  materialId: string | null;
  fingerprint: string | null;
  approvedFingerprint: string | null;
  linkedTaskId: string | null;
  attemptedAt: string | null;
  submittedAt: string | null;
  url: string | null;
}
export interface OperationsAccount {
  id: string;
  channel: OperationsChannel;
  label: string;
  environmentName: string;
  connected: boolean;
  message: string;
}
export interface OperationsMaterial {
  id: string;
  channel: OperationsChannel;
  accountId: string | null;
  title: string;
  purpose: "warming" | "regular";
  reviewed: boolean;
  preview: string;
  visibility?: string;
  imageCount?: number;
  fingerprint?: string;
  images?: { name: string; sha256: string }[];
}
export interface OperationsSnapshot {
  plans: OperationsPlan[];
  accounts: OperationsAccount[];
  materials: OperationsMaterial[];
  runtime: {
    running: boolean;
    busy: boolean;
    lastHeartbeatAt: string | null;
    message: string;
  };
  capabilities: {
    channel: OperationsChannel;
    automatic: boolean;
    description: string;
  }[];
  aiDefaults: {
    model: string;
    configured: boolean;
    dailyBudgetMicros: number | null;
  };
  logFolder: string;
}
export const operationsTaskQuery = z.object({
  page: z.number().int().min(1).max(100000).default(1),
  planId: z.string().max(150).default(""),
  channel: z.enum(["all", ...operationsChannels]).default("all"),
  status: z.enum(["all", ...operationsTaskStatuses]).default("all"),
  horizon: z.enum(["today", "week", "all"]).default("week"),
  accountId: z.string().max(150).default(""),
  kind: z
    .enum([
      "all",
      "publish",
      "progress",
      "statistics",
      "reconcile",
      "handoff",
      "supply",
    ])
    .default("all"),
});
export interface OperationsTaskPage {
  items: OperationsTask[];
  total: number;
  page: number;
  pageSize: number;
}
export const operationsLogQuery = z.object({
  page: z.number().int().min(1).default(1),
  planId: z.string().max(150).default(""),
  level: z.enum(["all", "info", "warning", "error"]).default("all"),
});
type Contract<A, V> = { args: A; value: V };
export interface IntelligentOperationsContract extends OperationsBrainContract {
  "intelligentOps.snapshot": Contract<undefined, OperationsSnapshot>;
  "intelligentOps.plan.save": Contract<OperationsPlanInput, OperationsPlan>;
  "intelligentOps.plan.active": Contract<
    { id: string; active: boolean; confirmed: true },
    OperationsPlan
  >;
  "intelligentOps.replan": Contract<{ planId?: string }, OperationsTaskPage>;
  "intelligentOps.scheduler": Contract<
    { running: boolean; confirmed: true },
    boolean
  >;
  "intelligentOps.tasks": Contract<
    z.input<typeof operationsTaskQuery>,
    OperationsTaskPage
  >;
  "intelligentOps.task.cancel": Contract<{ id: string }, OperationsTask>;
  "intelligentOps.task.schedule": Contract<
    { id: string; scheduledAt: string },
    OperationsTask
  >;
  "intelligentOps.task.review": Contract<
    { id: string; fingerprint: string; confirmed: true },
    OperationsTask
  >;
  "intelligentOps.task.handoff": Contract<
    { id: string; url?: string; confirmed: true },
    OperationsTask
  >;
  "intelligentOps.logs": Contract<
    z.input<typeof operationsLogQuery>,
    RuntimeLogPage
  >;
  "intelligentOps.advice": Contract<
    { planId: string; confirmed: true },
    OperationsAdvice
  >;
}

/** Restore keeps editable intent, never execution or content approval authorization. */
export const intelligentOperationsStateKey = "intelligentOperations:v1";
export const operationsPlanSchema = operationsPlanInput.safeExtend({
  id: z.string().regex(/^ioplan_[\w-]+$/),
  revision: z.number().int().positive(),
  active: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  advice: z
    .object({
      summary: z.string(),
      suggestions: z.string().array(),
      cautions: z.string().array(),
      createdAt: z.iso.datetime(),
      model: z.string(),
    })
    .nullable(),
});

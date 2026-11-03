import { z } from "zod";
import {
  operationsPlanSchema,
  operationsTaskStatuses,
  operationsChannels,
  type OperationsTask,
  type OperationsPlan,
} from "../../shared/intelligent-operations";
import {
  operationsBrainStateSchema,
  type OperationsBrainState,
  emptyOperationsBrainState,
} from "./brain-state";

export const operationsTaskSchema: z.ZodType<OperationsTask> = z.object({
  id: z.string().regex(/^iotask_[a-f0-9]+$/),
  key: z.string().max(1000),
  planId: z.string().regex(/^ioplan_[\w-]+$/),
  planRevision: z.number().int().positive(),
  channel: z.enum(operationsChannels),
  accountId: z.string().max(150),
  accountLabel: z.string().max(300),
  kind: z.enum([
    "publish",
    "progress",
    "statistics",
    "reconcile",
    "handoff",
    "supply",
  ]),
  title: z.string().max(1000),
  reason: z.string().max(4000),
  status: z.enum(operationsTaskStatuses),
  scheduledAt: z.iso.datetime().nullable(),
  manualScheduledAt: z.iso.datetime().nullable().optional(),
  brainCycleId: z.string().max(150).nullable().optional(),
  cancelOrigin: z.enum(["user", "policy", "restart", "system"]).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  materialId: z.string().max(180).nullable(),
  fingerprint: z.string().max(128).nullable(),
  approvedFingerprint: z.string().max(128).nullable(),
  linkedTaskId: z.string().max(150).nullable(),
  attemptedAt: z.iso.datetime().nullable(),
  submittedAt: z.iso.datetime().nullable(),
  url: z.string().max(2000).nullable(),
});
export const intelligentOperationsStateSchema = z.object({
  version: z.literal(1),
  plans: operationsPlanSchema.array().max(500),
  tasks: operationsTaskSchema.array().max(50000),
  brain: operationsBrainStateSchema.default(emptyOperationsBrainState),
});
export interface IntelligentOperationsState {
  version: 1;
  plans: OperationsPlan[];
  tasks: OperationsTask[];
  brain: OperationsBrainState;
}
export function restoreIntelligentOperationsState(
  raw: unknown,
): IntelligentOperationsState {
  const state = intelligentOperationsStateSchema.parse(raw);
  return {
    version: 1,
    plans: state.plans.map((p) => ({
      ...p,
      active: false,
      brain: {
        ...p.brain,
        permissions: {
          read: false,
          create: false,
          reviewOwn: false,
          publish: false,
        },
      },
    })),
    brain: {
      ...state.brain,
      cycles: state.brain.cycles.map((c) =>
        c.status === "running"
          ? {
              ...c,
              status: "stopped",
              finishedAt: new Date().toISOString(),
              nextWakeAt: null,
              summary: "应用重启或恢复中断此轮；不回放工具，不恢复自主授权",
            }
          : c,
      ),
      provenance: state.brain.provenance.map((p) => ({
        ...p,
        reviewedFingerprint: null,
        reviewedAt: null,
        reviewReason: null,
      })),
    },
    tasks: state.tasks.map((t) => ({
      ...t,
      approvedFingerprint: null,
      status: (["running", "delegated"].includes(t.status)
        ? "attention"
        : t.status === "planned" || t.status === "review"
          ? "blocked"
          : t.status) as OperationsTask["status"],
      reason: ["running", "delegated"].includes(t.status)
        ? "上次执行中断，保留原任务与提交记录，请核对结果；不自动重发"
        : ["planned", "review"].includes(t.status)
          ? "重启或恢复后需重新启用计划，并重新审核待发内容"
          : t.reason,
    })),
  };
}

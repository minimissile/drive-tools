import { z } from "zod";
import {
  operationsBrainCycleStatus,
  type OperationsBrainCycle,
  type OperationsBrainMemory,
  type OperationsBrainProvenance,
} from "../../shared/operations-brain";
export const brainDraftSchema = z.object({
  id: z.string().regex(/^iobdraft_[\w-]+$/),
  planId: z.string().max(150),
  accountId: z.string().max(150),
  title: z.string().max(100),
  body: z.string().max(15000),
  createdAt: z.iso.datetime(),
  reviewed: z.boolean(),
  aiAssisted: z.literal(true),
});
export type BrainDraft = z.output<typeof brainDraftSchema>;
export const brainCycleSchema: z.ZodType<OperationsBrainCycle> = z.object({
  id: z.string().regex(/^iocycle_[\w-]+$/),
  planId: z.string().max(150),
  planRevision: z.number().int().positive(),
  status: operationsBrainCycleStatus,
  model: z.string().max(200),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  nextWakeAt: z.iso.datetime().nullable(),
  summary: z.string().max(4000),
  costMicros: z.number().int().nonnegative(),
  costKnown: z.boolean(),
  steps: z
    .object({
      id: z.string().max(200),
      index: z.number().int().nonnegative(),
      createdAt: z.iso.datetime(),
      kind: z.enum(["decision", "tool"]),
      tool: z.string().max(100).nullable(),
      summary: z.string().max(4000),
      success: z.boolean(),
      costMicros: z.number().int().nonnegative().nullable(),
    })
    .array()
    .max(100),
});
export const brainMemorySchema: z.ZodType<OperationsBrainMemory> = z.object({
  id: z.string().max(150),
  planId: z.string().max(150),
  cycleId: z.string().max(150),
  createdAt: z.iso.datetime(),
  text: z.string().max(1500),
});
export const brainProvenanceSchema: z.ZodType<OperationsBrainProvenance> =
  z.object({
    id: z.string().max(150),
    planId: z.string().max(150),
    cycleId: z.string().max(150),
    toolCallId: z.string().max(200),
    materialId: z.string().max(180),
    accountId: z.string().max(150),
    fingerprint: z.string().max(128),
    createdAt: z.iso.datetime(),
    reviewedFingerprint: z.string().max(128).nullable(),
    reviewReason: z.string().max(2000).nullable(),
    reviewedAt: z.iso.datetime().nullable(),
  });
export const operationsBrainStateSchema = z.object({
  cycles: brainCycleSchema.array().max(20000).default([]),
  memory: brainMemorySchema.array().max(30000).default([]),
  provenance: brainProvenanceSchema.array().max(100000).default([]),
  drafts: brainDraftSchema.array().max(20000).default([]),
});
export type OperationsBrainState = z.output<typeof operationsBrainStateSchema>;
export const emptyOperationsBrainState = () =>
  operationsBrainStateSchema.parse({});

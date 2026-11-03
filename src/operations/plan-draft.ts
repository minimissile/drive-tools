import { z } from "zod";
import {
  operationsAccountPolicy,
  operationsChannelPolicy,
  operationsPlanInput,
} from "../../shared/intelligent-operations";
import { operationsBrainConfig } from "../../shared/operations-brain";

// Incomplete numeric/time edits must survive navigation. Business limits and
// cross-field relations are checked by operationsPlanInput only when saving.
const channelDraft = z.object({
  ...operationsChannelPolicy.shape,
  dailyLimit: z.number(),
  gapMinutes: z.number(),
  checkHours: z.number(),
  windowStart: z.string().max(10),
  windowEnd: z.string().max(10),
});
const accountDraft = z.object({
  ...operationsAccountPolicy.shape,
  dailyLimit: z.number().nullable(),
  gapMinutes: z.number().nullable(),
  windowStart: z.string().max(10).nullable(),
  windowEnd: z.string().max(10).nullable(),
});
const brainDraft = z.object({
  ...operationsBrainConfig.shape,
  wakeMinutes: z.number(),
  maxCyclesPerDay: z.number(),
  maxStepsPerCycle: z.number(),
  maxCycleMinutes: z.number(),
  cycleBudgetMicros: z.number(),
  dailyBudgetMicros: z.number(),
});
export const operationsPlanDraftSchema = z.object({
  ...operationsPlanInput.shape,
  name: z.string().max(100),
  goal: z.string().max(2000),
  channels: channelDraft.array().max(3),
  accounts: accountDraft.array().max(100),
  brain: brainDraft.default(() => operationsBrainConfig.parse({})),
});

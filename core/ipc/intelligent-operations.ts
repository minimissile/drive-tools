import { z } from "zod";
import type { HandlerMap, HandlerServices } from "./types";
import {
  operationsPlanInput,
  operationsTaskQuery,
  operationsLogQuery,
} from "../../shared/intelligent-operations";
import {
  operationsBrainCycleQuery,
  operationsBrainPermissions,
} from "../../shared/operations-brain";
const identifier = z.object({ id: z.string().min(1).max(150) });
const confirmed = identifier.extend({ confirmed: z.literal(true) });
export function createIntelligentOperationsHandlers({
  intelligentOps,
}: Pick<HandlerServices, "intelligentOps">) {
  return {
    "intelligentOps.brain.snapshot": () => intelligentOps.brainSnapshot(),
    "intelligentOps.brain.cycles": (raw: unknown) =>
      intelligentOps.brainCycles(operationsBrainCycleQuery.parse(raw)),
    "intelligentOps.brain.activate": (raw: unknown) => {
      const v = z
        .object({
          planId: z.string().min(1).max(150),
          planRevision: z.number().int().positive().optional(),
          active: z.boolean(),
          permissions: operationsBrainPermissions,
          confirmed: z.literal(true),
        })
        .parse(raw);
      return intelligentOps.brainActivate(
        v.planId,
        v.active,
        v.permissions,
        v.planRevision,
      );
    },
    "intelligentOps.brain.wake": (raw: unknown) =>
      intelligentOps.brainWake(
        z
          .object({
            planId: z.string().min(1).max(150),
            confirmed: z.literal(true),
          })
          .parse(raw).planId,
      ),
    "intelligentOps.snapshot": () => intelligentOps.snapshot(),
    "intelligentOps.plan.save": (raw: unknown) =>
      intelligentOps.save(operationsPlanInput.parse(raw)),
    "intelligentOps.plan.active": (raw: unknown) => {
      const v = confirmed.extend({ active: z.boolean() }).parse(raw);
      return intelligentOps.activate(v.id, v.active);
    },
    "intelligentOps.replan": (raw: unknown) =>
      intelligentOps.replan(
        z.object({ planId: z.string().max(150).optional() }).parse(raw),
      ),
    "intelligentOps.scheduler": (raw: unknown) =>
      intelligentOps.scheduler(
        z
          .object({ running: z.boolean(), confirmed: z.literal(true) })
          .parse(raw).running,
      ),
    "intelligentOps.tasks": (raw: unknown) =>
      intelligentOps.tasks(operationsTaskQuery.parse(raw)),
    "intelligentOps.task.cancel": (raw: unknown) =>
      intelligentOps.cancel(identifier.parse(raw).id),
    "intelligentOps.task.schedule": (raw: unknown) => {
      const v = identifier
        .extend({ scheduledAt: z.iso.datetime({ offset: true }) })
        .parse(raw);
      return intelligentOps.schedule(v.id, v.scheduledAt);
    },
    "intelligentOps.task.review": (raw: unknown) => {
      const v = confirmed
        .extend({ fingerprint: z.string().min(1).max(128) })
        .parse(raw);
      return intelligentOps.review(v.id, v.fingerprint);
    },
    "intelligentOps.task.handoff": (raw: unknown) => {
      const v = confirmed
        .extend({ url: z.string().max(2000).optional() })
        .parse(raw);
      return intelligentOps.handoff(v.id, v.url);
    },
    "intelligentOps.logs": (raw: unknown) =>
      intelligentOps.readLogs(operationsLogQuery.parse(raw)),
    "intelligentOps.advice": (raw: unknown) =>
      intelligentOps.advice(
        z
          .object({
            planId: z.string().min(1).max(150),
            confirmed: z.literal(true),
          })
          .parse(raw).planId,
      ),
  } satisfies HandlerMap;
}

import { z } from "zod";
import {
  preparePublishingSchema,
  publishingIdSchema,
  savePublishingRowsSchema,
  publishingResourceLimit,
  publishingResourceSchema,
  publishingLinkTypeSchema,
} from "../../shared/zhidao-workflow";
import type { HandlerMap, HandlerServices } from "./types";
import { zhidaoTaskNameLimit } from "../../shared/zhidao-publishing";

export function createZhidaoWorkflowHandlers({
  zhidaoWorkflow,
}: Pick<HandlerServices, "zhidaoWorkflow">) {
  const ids = z.object({
    ids: z
      .array(z.string().uuid())
      .min(1)
      .max(publishingResourceLimit)
      .refine((v) => new Set(v).size === v.length),
  });
  const output = ids.extend({
    linkType: publishingLinkTypeSchema.default("drive"),
    linkRevision: z.string().max(2000).optional(),
  });
  return {
    "zhidao.workflow.linkOptions": (raw) =>
      zhidaoWorkflow.linkOptions(ids.parse(raw).ids),
    "zhidao.workflow.publish": (raw) => {
      const input = output
        .extend({
          accountId: z.string().min(1).max(100),
          taskName: z.string().trim().min(1).max(zhidaoTaskNameLimit),
          selectionRevision: z.string().min(1).max(12000),
          authorized: z.literal(true),
        })
        .parse(raw);
      return zhidaoWorkflow.publish(
        input.ids,
        input.accountId,
        input.taskName,
        input.selectionRevision,
        input.linkType,
        input.linkRevision,
      );
    },
    "zhidao.workflow.planMany": (raw) =>
      zhidaoWorkflow.planMany(
        z
          .object({
            resources: z
              .array(publishingResourceSchema)
              .min(1)
              .max(publishingResourceLimit)
              .refine(
                (rows) =>
                  new Set(rows.map((row) => row.key)).size === rows.length,
              ),
          })
          .parse(raw).resources,
      ),
    "zhidao.workflow.pause": (raw) =>
      zhidaoWorkflow.pause(publishingIdSchema.parse(raw).id),
    "zhidao.workflow.resources": (raw) =>
      zhidaoWorkflow.resources(
        z.object({ query: z.string().max(200) }).parse(raw).query,
      ),
    "zhidao.workflow.prepare": (raw) => {
      const v = preparePublishingSchema.parse(raw);
      return zhidaoWorkflow.prepare(v.resource, v.accountId);
    },
    "zhidao.workflow.get": (raw) => zhidaoWorkflow.getMany(ids.parse(raw).ids),
    "zhidao.workflow.shares": (raw) =>
      zhidaoWorkflow.shares(
        publishingIdSchema.extend({ authorized: z.literal(true) }).parse(raw)
          .id,
      ),
    "zhidao.workflow.generate": (raw) => {
      const { id, upgradeLegacy, optimize } = publishingIdSchema
        .extend({
          upgradeLegacy: z.literal(true).optional(),
          optimize: z.literal(true).optional(),
        })
        .parse(raw);
      return zhidaoWorkflow.generate(id, upgradeLegacy, optimize);
    },
    "zhidao.workflow.generateMany": (raw) =>
      zhidaoWorkflow.generateMany(ids.parse(raw).ids),
    "zhidao.workflow.saveRows": (raw) => {
      const v = savePublishingRowsSchema.parse(raw);
      return zhidaoWorkflow.saveRows(v.id, v.rows, v.generationId ?? "");
    },
    "zhidao.workflow.export": (raw) => {
      const input = output.parse(raw);
      return zhidaoWorkflow.export(
        input.ids,
        input.linkType,
        input.linkRevision,
      );
    },
  } satisfies HandlerMap;
}

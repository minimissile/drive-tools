import { z } from "zod";
import {
  catalogIdSchema,
  catalogSaveSchema,
  catalogPrepareSchema,
  catalogConfirmSchema,
  catalogSitePublishSchema,
  catalogSiteWithdrawSchema,
  catalogAiStartSchema,
  catalogResourcesSchema,
  catalogRemoveItemsSchema,
} from "../../shared/resource-catalog";
import type { ResourceCatalogs } from "../resource-catalog";

/** Validate every transport input before entering the catalog domain. */
export function createResourceCatalogHandlers(services: {
  resourceCatalogs: ResourceCatalogs;
}) {
  const catalog = z.object({ id: catalogIdSchema });
  const revision = z.number().int().positive();
  const handoff = catalog.extend({ preparationId: z.string().min(1).max(120) });
  const aiJob = z.object({ id: z.string().uuid() });
  return {
    "resourceCatalog.resourceDetails": (input: unknown) =>
      services.resourceCatalogs.resourceDetails(
        z
          .object({ ids: z.array(z.string().min(1).max(128)).max(30) })
          .parse(input).ids,
      ),
    "resourceCatalog.resources": (input: unknown) =>
      services.resourceCatalogs.resources(catalogResourcesSchema.parse(input)),
    "resourceCatalog.aiStart": (input: unknown) =>
      services.resourceCatalogs.aiStart(catalogAiStartSchema.parse(input)),
    "resourceCatalog.aiGet": (input: unknown) =>
      services.resourceCatalogs.aiGet(aiJob.parse(input).id),
    "resourceCatalog.aiStep": (input: unknown) => {
      const value = aiJob
        .extend({ retryUncertain: z.literal(true).optional() })
        .parse(input);
      return services.resourceCatalogs.aiStep(value.id, value.retryUncertain);
    },
    "resourceCatalog.list": () => services.resourceCatalogs.list(),
    "resourceCatalog.sitePublish": (input: unknown) =>
      services.resourceCatalogs.sitePublish(
        catalogSitePublishSchema.parse(input),
      ),
    "resourceCatalog.siteWithdraw": (input: unknown) => {
      const value = catalogSiteWithdrawSchema.parse(input);
      return services.resourceCatalogs.siteWithdraw(
        value.id,
        value.expectedVersion,
      );
    },
    "resourceCatalog.siteRefresh": (input: unknown) =>
      services.resourceCatalogs.siteRead(catalog.parse(input).id),
    "resourceCatalog.siteRetry": (input: unknown) =>
      services.resourceCatalogs.siteRead(catalog.parse(input).id, true),
    "resourceCatalog.get": (input: unknown) =>
      services.resourceCatalogs.get(catalog.parse(input).id),
    "resourceCatalog.save": (input: unknown) =>
      services.resourceCatalogs.save(catalogSaveSchema.parse(input)),
    "resourceCatalog.removeItems": (input: unknown) =>
      services.resourceCatalogs.removeItems(
        catalogRemoveItemsSchema.parse(input),
      ),
    "resourceCatalog.saveManual": (input: unknown) =>
      services.resourceCatalogs.save(
        catalogSaveSchema
          .extend({ selectionMode: z.literal("manual") })
          .parse(input),
      ),
    "resourceCatalog.archive": (input: unknown) => {
      const value = catalog
        .extend({ expectedRevision: revision, archived: z.boolean() })
        .parse(input);
      return services.resourceCatalogs.archive(
        value.id,
        value.expectedRevision,
        value.archived,
      );
    },
    "resourceCatalog.remove": (input: unknown) => {
      const value = catalog
        .extend({ expectedRevision: revision, confirmed: z.literal(true) })
        .parse(input);
      return services.resourceCatalogs.remove(value.id, value.expectedRevision);
    },
    "resourceCatalog.prepare": (input: unknown) =>
      services.resourceCatalogs.prepare(catalogPrepareSchema.parse(input)),
    "resourceCatalog.copy": (input: unknown) => {
      const value = handoff.parse(input);
      return services.resourceCatalogs.copy(value.id, value.preparationId);
    },
    "resourceCatalog.open": (input: unknown) => {
      const value = handoff.parse(input);
      return services.resourceCatalogs.open(value.id, value.preparationId);
    },
    "resourceCatalog.confirm": (input: unknown) =>
      services.resourceCatalogs.confirm(catalogConfirmSchema.parse(input)),
    "resourceCatalog.export": (input: unknown) => {
      const value = catalog
        .extend({
          preparationId: z.string().min(1).max(120).optional(),
          format: z.enum(["xlsx", "md"]),
        })
        .parse(input);
      return services.resourceCatalogs.export(
        value.id,
        value.preparationId,
        value.format,
      );
    },
  };
}

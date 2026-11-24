import { z } from "zod";
import {
  tiebaDiscoveryPotentialPageSchema,
  tiebaDiscoveryPotentialFilterSchema,
  tiebaDiscoveryRulesSchema,
  tiebaDiscoveryRefreshSchema,
  tiebaDiscoveryImportSchema,
  tiebaOldTrafficPageSchema,
  tiebaTrafficPostsPageSchema,
  tiebaTrafficResourceMarkSchema,
  tiebaFilterAuditPageSchema,
  tiebaRecycledPageSchema,
  tiebaOldResourceDeleteSchema,
  tiebaResourceSeedsSchema,
} from "../../shared/tieba-resource-discovery";
import type { TiebaResourceDiscovery } from "../tieba-resource-discovery/service";
import type { HandlerMap } from "./types";

const autoInput = z.object({ enabled: z.boolean() });
const startFilterAuditInput = z.strictObject({});

export function createTiebaResourceDiscoveryHandlers({
  tiebaResourceDiscovery,
}: {
  tiebaResourceDiscovery: TiebaResourceDiscovery;
}) {
  return {
    "tieba.discovery.snapshot": () => tiebaResourceDiscovery.snapshot(),
    "tieba.discovery.import": (input) =>
      tiebaResourceDiscovery.importPost(tiebaDiscoveryImportSchema.parse(input).id),
    "tieba.discovery.refresh": (input) =>
      tiebaResourceDiscovery.refresh(tiebaDiscoveryRefreshSchema.parse(input)),
    "tieba.discovery.rules": (input) =>
      tiebaResourceDiscovery.saveRules(tiebaDiscoveryRulesSchema.parse(input)),
    "tieba.discovery.potential": (input) => {
      const { page, grew } = tiebaDiscoveryPotentialFilterSchema.parse(input);
      return tiebaResourceDiscovery.potential(page, grew);
    },
    "tieba.discovery.pending": (input) =>
      tiebaResourceDiscovery.pending(
        tiebaDiscoveryPotentialPageSchema.parse(input).page,
      ),
    "tieba.discovery.traffic": (input) =>
      tiebaResourceDiscovery.traffic(
        tiebaDiscoveryPotentialPageSchema.parse(input).page,
      ),
    "tieba.discovery.oldTraffic": (input) => {
      const { page, view, resource } = tiebaOldTrafficPageSchema.parse(input);
      return tiebaResourceDiscovery.oldTraffic(page, view, resource);
    },
    "tieba.discovery.trafficPosts": (input) => {
      const { page, view, resource, sort, direction } = tiebaTrafficPostsPageSchema.parse(input);
      return tiebaResourceDiscovery.trafficPosts(page, view, resource, sort, direction);
    },
    "tieba.discovery.setResourceRecorded": (input) => {
      const { id, recorded } = tiebaTrafficResourceMarkSchema.parse(input);
      return tiebaResourceDiscovery.setResourceRecorded(id, recorded);
    },
    "tieba.discovery.filterAudit": (input) => {
      const { page, sort, direction } = tiebaFilterAuditPageSchema.parse(input);
      return tiebaResourceDiscovery.filterAuditPage(page, sort, direction);
    },
    "tieba.discovery.startFilterAudit": (input) => {
      startFilterAuditInput.parse(input);
      return tiebaResourceDiscovery.startFilterAudit();
    },
    "tieba.discovery.recycled": (input) => {
      const { page, ...filters } = tiebaRecycledPageSchema.parse(input);
      return tiebaResourceDiscovery.recycledPage(page, filters);
    },
    "tieba.discovery.deleteOldResource": (input) =>
      tiebaResourceDiscovery.deleteOldResource(tiebaOldResourceDeleteSchema.parse(input).id),
    "tieba.discovery.seeds": (input) =>
      tiebaResourceDiscovery.saveSeeds(
        tiebaResourceSeedsSchema.parse(input).seeds,
      ),
    "tieba.discovery.scan": () => tiebaResourceDiscovery.scan(),
    "tieba.discovery.scanOldForum": () => tiebaResourceDiscovery.scanOldForum(),
    "tieba.discovery.auto": (input) =>
      tiebaResourceDiscovery.setAuto(autoInput.parse(input).enabled),
  } satisfies HandlerMap;
}

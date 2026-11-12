import { z } from "zod";
import {
  tiebaDiscoveryPotentialPageSchema,
  tiebaResourceSeedsSchema,
} from "../../shared/tieba-resource-discovery";
import type { TiebaResourceDiscovery } from "../tieba-resource-discovery/service";
import type { HandlerMap } from "./types";

const autoInput = z.object({ enabled: z.boolean() });

export function createTiebaResourceDiscoveryHandlers({
  tiebaResourceDiscovery,
}: {
  tiebaResourceDiscovery: TiebaResourceDiscovery;
}) {
  return {
    "tieba.discovery.snapshot": () => tiebaResourceDiscovery.snapshot(),
    "tieba.discovery.potential": (input) =>
      tiebaResourceDiscovery.potential(
        tiebaDiscoveryPotentialPageSchema.parse(input).page,
      ),
    "tieba.discovery.seeds": (input) =>
      tiebaResourceDiscovery.saveSeeds(
        tiebaResourceSeedsSchema.parse(input).seeds,
      ),
    "tieba.discovery.scan": () => tiebaResourceDiscovery.scan(),
    "tieba.discovery.auto": (input) =>
      tiebaResourceDiscovery.setAuto(autoInput.parse(input).enabled),
  } satisfies HandlerMap;
}

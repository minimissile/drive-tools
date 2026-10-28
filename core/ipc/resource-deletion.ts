import { z } from "zod";
import type { HandlerMap, HandlerServices } from "./types";

export function createResourceDeletionHandlers(
  services: Pick<HandlerServices, "resourceDeletion">,
) {
  return {
    "resource.deletePreview": (input) =>
      services.resourceDeletion.preview(
        z.object({ resourceId: z.string().min(1).max(100) }).parse(input)
          .resourceId,
      ),
    "resource.remove": (input) =>
      services.resourceDeletion.remove(
        z
          .object({
            token: z.string().uuid(),
            mode: z.enum(["local", "remote"]),
            confirmed: z.literal(true),
          })
          .parse(input),
      ),
    "resource.deleteRecheck": (input) =>
      services.resourceDeletion.recheck(
        z.object({ operationId: z.string().uuid() }).parse(input).operationId,
      ),
  } satisfies HandlerMap;
}

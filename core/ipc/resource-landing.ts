import { z } from "zod";
import {
  landingDraftSchema,
  landingEditableDraftSchema,
} from "../../shared/resource-landing";
import type { HandlerMap, HandlerServices } from "./types";
import { landingTrafficSchema } from "../../shared/landing-traffic";
export function createResourceLandingHandlers(
  services: Pick<HandlerServices, "resourceLanding" | "resourceLinks">,
) {
  const resource = z.object({ resourceId: z.string().min(1).max(100) });
  const version = resource.extend({
    expectedDraftVersion: z.number().int().nonnegative(),
  });
  return {
    "resourceLanding.traffic": async (input) =>
      landingTrafficSchema.parse(await services.resourceLinks.landingTraffic(resource.parse(input).resourceId)),
    "resourceLanding.readDocument": (input) => {
      const v = resource
        .extend({
          fileEvidenceId: z.string().regex(/^file-\d+$/),
          local: z.boolean().optional(),
        })
        .parse(input);
      return services.resourceLanding.readDocument(
        v.resourceId,
        v.fileEvidenceId,
        v.local,
      );
    },
    "resourceLanding.get": (input) =>
      services.resourceLanding.get(resource.parse(input).resourceId),
    "resourceLanding.generate": (input) => {
      const v = resource
        .extend({ requestId: z.string().uuid(), notes: z.string().max(8000) })
        .parse(input);
      return services.resourceLanding.generate(
        v.resourceId,
        v.requestId,
        v.notes,
      );
    },
    "resourceLanding.optimize": (input) => {
      const v = version
        .extend({
          requestId: z.string().uuid(),
          notes: z.string().max(8000),
          draft: landingEditableDraftSchema,
        })
        .parse(input);
      return services.resourceLanding.optimize(
        v.resourceId,
        v.requestId,
        v.expectedDraftVersion,
        v.notes,
        v.draft,
      );
    },
    "resourceLanding.saveDraft": (input) => {
      const v = version.extend({ draft: landingDraftSchema }).parse(input);
      return services.resourceLanding.saveDraft(
        v.resourceId,
        v.expectedDraftVersion,
        v.draft,
      );
    },
    "resourceLanding.publish": (input) => {
      const v = version.parse(input);
      return services.resourceLanding.publish(
        v.resourceId,
        v.expectedDraftVersion,
      );
    },
    "resourceLanding.unpublish": (input) =>
      services.resourceLanding.unpublish(resource.parse(input).resourceId),
    "resourceLanding.refresh": (input) =>
      services.resourceLanding.refresh(resource.parse(input).resourceId),
    "resourceLanding.retry": (input) =>
      services.resourceLanding.retry(resource.parse(input).resourceId),
  } satisfies HandlerMap;
}

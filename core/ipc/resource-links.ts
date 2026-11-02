import { z } from "zod";
import type { HandlerMap, HandlerServices } from "./types";

export function createResourceLinksHandlers(
  services: Pick<HandlerServices, "resourceLinks">,
) {
  const resource = z.object({ resourceId: z.string().min(1).max(100) });
  const configuration = z.object({
    enabled: z.boolean(),
    baseUrl: z.string().max(500),
    token: z.string().max(512).optional(),
  });
  return {
    "resourceLinks.settings": () => services.resourceLinks.settings(),
    "resourceLinks.configure": (input) =>
      services.resourceLinks.configure(configuration.parse(input)),
    "resourceLinks.migrateService": (input) =>
      services.resourceLinks.migrateService(
        configuration.omit({ token: true }).parse(input),
      ),
    "resourceLinks.checkConnection": () =>
      services.resourceLinks.checkConnection(),
    "resourceLinks.get": (input) =>
      services.resourceLinks.context(resource.parse(input).resourceId),
    "resourceLinks.ensure": (input) =>
      services.resourceLinks.ensure(resource.parse(input).resourceId),
    "resourceLinks.useCurrent": (input) =>
      services.resourceLinks.useCurrent(resource.parse(input).resourceId),
    "resourceLinks.setTarget": (input) => {
      const value = resource
        .extend({
          text: z.string().min(1).max(8000),
          code: z.string().trim().max(128).optional(),
        })
        .parse(input);
      return services.resourceLinks.setTarget(
        value.resourceId,
        value.text,
        value.code,
      );
    },
    "resourceLinks.setEnabled": (input) => {
      const value = resource.extend({ enabled: z.boolean() }).parse(input);
      return services.resourceLinks.setEnabled(value.resourceId, value.enabled);
    },
    "resourceLinks.retry": (input) =>
      services.resourceLinks.retry(resource.parse(input).resourceId),
    "resourceLinks.refresh": (input) =>
      services.resourceLinks.refresh(resource.parse(input).resourceId),
    "resourceLinks.recover": (input) =>
      services.resourceLinks.recover(resource.parse(input).resourceId),
    "resourceLinks.copy": (input) => {
      const value = resource
        .extend({ kind: z.enum(["landing", "redirect"]).optional() })
        .parse(input);
      return services.resourceLinks.copy(value.resourceId, value.kind);
    },
  } satisfies HandlerMap;
}

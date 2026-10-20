import { z } from "zod";

import type { HandlerServices, HandlerMap } from "./types";

export function createAiHandlers(
  services: Pick<HandlerServices, "ai" | "db" | "ideas">,
) {
  return {
    "ai.connection": async () => {
      return services.ai.connection();
    },
    "ai.models": async () => {
      return services.ai.models();
    },
    "ai.modelCatalog": async () => {
      return {
        text: services.db.setting("modelCatalog", []),
        media: services.db.setting("studio:modelCatalog", []),
      };
    },
    "ai.keywords": async (object) => {
      const { resourceId } = z.object({ resourceId: z.string() }).parse(object);
      return services.ai.extract(resourceId);
    },
    "ai.ideas.preview": async (object) => {
      return services.ideas.preview(object);
    },
    "ai.ideas.generate": async (object) => {
      return services.ideas.generate(object);
    },
    "ai.ideas.history": async () => {
      return services.ideas.history();
    },
    "ai.ideas.save": async (object) => {
      const input = z
        .object({
          runId: z.string().max(100),
          selected: z.array(z.string().max(100)).min(1).max(20),
          name: z.string().trim().min(1).max(100),
        })
        .parse(object);
      return services.ideas.save(input.runId, input.selected, input.name);
    },
  } satisfies HandlerMap;
}

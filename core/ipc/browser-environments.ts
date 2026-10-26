import { z } from "zod";
import {
  environmentAccountSchema,
  environmentIdSchema,
  environmentSaveSchema,
} from "../../shared/browser-environments";
import type { HandlerMap, HandlerServices } from "./types";
export function createBrowserEnvironmentHandlers(
  s: Pick<HandlerServices, "environments" | "environmentQueue" | "bit">,
) {
  return {
    "environments.list": () => s.environments.list(),
    "environments.jobs": () => s.environmentQueue.list(),
    "environments.cancelJob": (input) =>
      s.environmentQueue.cancel(
        z.object({ id: z.string().regex(/^envjob_[\w-]+$/) }).parse(input).id,
      ),
    "environments.checkNetwork": (input) =>
      s.environments.checkNetwork(
        z.object({ id: environmentIdSchema }).parse(input).id,
      ),
    "environments.save": (input) =>
      s.environments.save(environmentSaveSchema.parse(input)),
    "environments.bind": (input) => {
      const v = environmentAccountSchema
        .extend({
          environmentId: environmentIdSchema,
          confirmed: z.literal(true),
        })
        .parse(input);
      return s.environments.bind({ kind: v.kind, id: v.id }, v.environmentId);
    },
    "environments.remove": (input) => {
      const v = z
        .object({ id: environmentIdSchema, confirmed: z.literal(true) })
        .parse(input);
      return s.environments.remove(v.id);
    },
    "environments.open": async (input) => {
      const env = s.environments.get(
        z.object({ id: environmentIdSchema }).parse(input).id,
      );
      if (env.engine === "bitbrowser")
        await s.environments.runEnvironment(env.id, "environment:open", () =>
          s.bit.withProfile(env.profileId, async () => {}),
        );
      return true;
    },
  } satisfies HandlerMap;
}

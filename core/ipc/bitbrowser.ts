import { z } from "zod";
import { bitProfileCommandSchema } from "../../shared/bitbrowser";
import { environmentAccountSchema } from "../../shared/browser-environments";
import type { HandlerMap, HandlerServices } from "./types";

export function createBitBrowserHandlers(
  s: Pick<HandlerServices, "bitManagement">,
) {
  return {
    "bit.profiles": () => s.bitManagement.list(),
    "bit.diagnose": (input) =>
      s.bitManagement.diagnose(bitProfileCommandSchema.parse(input)),
    "bit.openProfile": (input) =>
      s.bitManagement.open(bitProfileCommandSchema.parse(input)),
    "bit.closeProfile": (input) =>
      s.bitManagement.close(
        bitProfileCommandSchema
          .extend({
            confirmed: z.literal(true),
            expectedRevision: z.number().int().positive().optional(),
          })
          .parse(input),
      ),
    "bit.openAccount": (input) =>
      s.bitManagement.openAccount(
        bitProfileCommandSchema
          .extend({
            account: environmentAccountSchema,
          })
          .parse(input),
      ),
  } satisfies HandlerMap;
}

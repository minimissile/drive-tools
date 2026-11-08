import { z } from "zod";
import {
  autocareConfigSchema,
  autocareInteractionInput,
} from "../../shared/zhihu-autocare";
import { runtimeLogQuery } from "../../shared/runtime-logs";
import type { HandlerServices, HandlerMap } from "./types";
export function createZhihuAutocareHandlers({
  zhihuAutocare,
}: Pick<HandlerServices, "zhihuAutocare">) {
  return {
    "zhihu.autocare.snapshot": () => zhihuAutocare.snapshot(),
    "zhihu.autocare.save": (raw) => {
      const v = z
        .object({
          config: autocareConfigSchema,
          revision: z.number().int().positive(),
        })
        .parse(raw);
      return zhihuAutocare.save(v.config, v.revision);
    },
    "zhihu.autocare.toggle": (raw) => {
      const v = z
        .object({
          enabled: z.boolean(),
          revision: z.number().int().positive(),
          confirmed: z.literal(true),
        })
        .parse(raw);
      return zhihuAutocare.toggle(v.enabled, v.revision);
    },
    "zhihu.autocare.recheck": (raw) => {
      const v = z.object({ revision: z.number().int().positive() }).parse(raw);
      return zhihuAutocare.recheck(v.revision);
    },
    "zhihu.autocare.interact": (raw) =>
      zhihuAutocare.interact(autocareInteractionInput.parse(raw)),
    "zhihu.autocare.refreshInteraction": (raw) =>
      zhihuAutocare.refreshInteraction(
        z
          .object({
            id: z.string().regex(/^zhactivity_[\w-]+$/),
            version: z.number().int().positive(),
          })
          .parse(raw),
      ),
    "zhihu.autocare.reconcile": (raw) =>
      zhihuAutocare.reconcileInteraction(
        z
          .object({
            id: z.string().regex(/^zhactivity_[\w-]+$/),
            version: z.number().int().positive(),
          })
          .parse(raw),
      ),
    "zhihu.autocare.logs": (raw) =>
      zhihuAutocare.logs.read(runtimeLogQuery.parse(raw)),
  } satisfies HandlerMap;
}

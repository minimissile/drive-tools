import { z } from "zod";
import { AppError } from "../errors";
import {
  environmentAccountSchema,
  environmentIdSchema,
  environmentSaveSchema,
} from "../../shared/browser-environments";
import type { HandlerMap, HandlerServices } from "./types";
export function createBrowserEnvironmentHandlers(
  s: Pick<HandlerServices, "environments" | "environmentQueue" | "bit" | "driveBrowsers">,
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
          environmentId: environmentIdSchema.optional(),
          confirmed: z.literal(true),
        })
        .parse(input);
      if (v.kind === "drive") throw new AppError("DRIVE_BINDING_REQUIRED", "百度网盘请在账号管理中读取并关联环境，以核实 UID 和后台运行方式。");
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
      const drive = s.environments.list().find((e) => e.id === env.id)?.accounts.find((a) => a.kind === "drive");
      if (env.engine === "bitbrowser" && drive) {
        await s.driveBrowsers.open(drive.id);
        return true;
      }
      if (env.engine === "bitbrowser")
        await s.environments.runEnvironment(env.id, "environment:open", () =>
          s.bit.withProfile(env.profileId, async () => {}),
        );
      return true;
    },
  } satisfies HandlerMap;
}

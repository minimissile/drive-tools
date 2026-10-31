import { z } from "zod";
import type { HandlerMap, HandlerServices } from "./types";
export function createDriveBrowserHandlers(
  s: Pick<HandlerServices, "driveBrowsers">,
) {
  return {
    "driveBrowser.previewNew": (input) =>
      s.driveBrowsers.previewNew(
        z
          .object({
            profileId: z.string().min(1).max(200),
            connectorKey: z.string().min(1).max(300),
            requireProxy: z.boolean(),
          })
          .parse(input),
      ),
    "driveBrowser.background": (input) =>
      s.driveBrowsers.background(
        z
          .object({
            accountId: z.string().min(1).max(150),
            confirmed: z.literal(true),
          })
          .parse(input).accountId,
      ),
    "driveBrowser.preview": (input) =>
      s.driveBrowsers.preview(
        z
          .object({
            accountId: z.string().min(1).max(150),
            profileId: z.string().min(1).max(200),
            connectorKey: z.string().min(1).max(300),
            requireProxy: z.boolean(),
          })
          .parse(input),
      ),
    "driveBrowser.bind": (input) =>
      s.driveBrowsers.bind(
        z.object({ token: z.string().uuid() }).parse(input).token,
      ),
    "driveBrowser.unbind": async (input) => {
      await s.driveBrowsers.unbind(
        z.object({ accountId: z.string().min(1).max(150) }).parse(input)
          .accountId,
      );
      return { backgroundStopped: false };
    },
  } satisfies HandlerMap;
}

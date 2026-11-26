import { z } from "zod";
import type { HandlerMap, HandlerServices } from "./types";
const account = z.object({ accountId: z.string().min(1).max(100) });
const syncMode = account.extend({ autoRegister: z.boolean().optional() });
export function createDriveSyncHandlers(s: Pick<HandlerServices, "driveSync">) {
  return {
    "driveSync.index": (raw) =>
      s.driveSync.index(
        account
          .extend({
            parentId: z.string().max(500).optional(),
            search: z.string().max(200).optional(),
            state: z
              .enum(["all", "recorded", "unrecorded", "review"])
              .optional(),
            page: z.number().int().min(1).max(2000000).optional(),
            foldersOnly: z.boolean().optional(),
          })
          .parse(raw),
      ),
    "driveSync.logs": (raw) => s.driveSync.logs(account.parse(raw).accountId),
    "driveSync.start": (raw) => {
      const input = syncMode
        .extend({ restart: z.boolean().optional() })
        .parse(raw);
      return s.driveSync.start(
        input.accountId,
        input.restart,
        input.autoRegister,
      );
    },
    "driveSync.pause": (raw) => s.driveSync.pause(account.parse(raw).accountId),
    "driveSync.resume": (raw) => {
      const input = syncMode.parse(raw);
      return s.driveSync.resume(input.accountId, input.autoRegister);
    },
    "driveSync.register": (raw) =>
      s.driveSync.register(
        account
          .extend({
            entries: z
              .array(
                z.object({
                  fileId: z.string().min(1).max(500),
                  title: z.string().trim().min(1).max(200),
                }),
              )
              .min(1)
              .max(50),
          })
          .parse(raw),
      ),
  } satisfies HandlerMap;
}

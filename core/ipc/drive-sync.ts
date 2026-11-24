import { z } from "zod";
import type { HandlerMap, HandlerServices } from "./types";
const account = z.object({ accountId: z.string().min(1).max(100) });
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
    "driveSync.start": (raw) => {
      const input = account
        .extend({ restart: z.boolean().optional() })
        .parse(raw);
      return s.driveSync.start(input.accountId, input.restart);
    },
    "driveSync.pause": (raw) => s.driveSync.pause(account.parse(raw).accountId),
    "driveSync.resume": (raw) =>
      s.driveSync.resume(account.parse(raw).accountId),
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

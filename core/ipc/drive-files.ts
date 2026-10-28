import { z } from "zod";
import { fileSchema } from "../../shared/schemas";
import { insertionName } from "../../shared/insertion";
import type { HandlerMap, HandlerServices } from "./types";
export function createDriveFilesHandlers(
  s: Pick<HandlerServices, "driveFiles">,
) {
  const location = z.object({
    accountId: z.string().min(1).max(100),
    path: z.string().min(1).max(500),
  });
  const operation = location.extend({
    operationId: z.string().uuid(),
    confirmed: z.literal(true),
  });
  return {
    "drive.adoptCopy": (input) =>
      s.driveFiles.management.adoptCopy(
        location
          .extend({
            copyId: z.string().min(1).max(100),
            files: z.array(fileSchema).min(1).max(100),
            confirmed: z.literal(true),
          })
          .parse(input),
      ),
    "drive.directory": (input) => {
      const v = location.parse(input);
      return s.driveFiles.management.browse(v.accountId, v.path);
    },
    "drive.write": (input) =>
      s.driveFiles.management.manage(
        operation
          .extend({
            action: z.enum(["mkdir", "rename", "delete"]),
            files: z.array(fileSchema).max(100),
            name: insertionName.optional(),
          })
          .parse(input),
      ),
    "drive.material": (input) =>
      s.driveFiles.management.material(
        operation
          .extend({
            materialId: z.string().min(1).max(150),
            replace: fileSchema.optional(),
          })
          .parse(input),
      ),
    "drive.recheck": (input) => {
      const v = location.parse(input);
      return s.driveFiles.management.recheck(v.accountId, v.path);
    },
    "drive.resolve": (input) => {
      const v = operation.parse(input);
      return s.driveFiles.management.resolve(
        v.accountId,
        v.path,
        v.operationId,
      );
    },
  } satisfies HandlerMap;
}

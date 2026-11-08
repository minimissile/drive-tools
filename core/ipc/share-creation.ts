import { z } from "zod";
import type { HandlerMap, HandlerServices } from "./types";
import { AppError } from "../errors";

export function createShareCreationHandlers(
  services: Pick<HandlerServices, "shareCreation" | "baiduDiscoveryQuestions">,
) {
  const copy = z.object({ copyId: z.string().min(1).max(100) });
  return {
    "share.creationOptions": (input) =>
      services.shareCreation.options(copy.parse(input).copyId),
    "share.creationResult": (input) =>
      services.shareCreation.result(
        z.object({ operationId: z.string().uuid() }).parse(input).operationId,
      ),
    "share.create": (input) => {
      if (services.baiduDiscoveryQuestions.isBusy)
        throw new AppError(
          "QUESTION_IMPORT_BUSY",
          "正在为长尾词创建分享，请等待本轮完成后再单独建链。",
        );
      return services.shareCreation.create(
        copy
          .extend({
            operationId: z.string().uuid(),
            expiresInDays: z.number().int().min(0).max(3650),
            extractionCode: z.string().trim().max(30).optional(),
          })
          .parse(input),
      );
    },
    "share.recheckCreation": (input) =>
      services.shareCreation.recheck(
        z.object({ operationId: z.string().uuid() }).parse(input).operationId,
      ),
    "share.resolveCreation": (input) => {
      const value = z
        .object({
          operationId: z.string().uuid(),
          outcome: z.enum(["not_created", "handled"]),
        })
        .parse(input);
      return services.shareCreation.resolve(value.operationId, value.outcome);
    },
  } satisfies HandlerMap;
}

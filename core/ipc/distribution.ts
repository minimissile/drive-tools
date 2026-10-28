import { z } from "zod";
import {
  distributionListInput,
  distributionPlatformId,
  distributionResolveInput,
} from "../../shared/distribution";
import { AppError } from "../errors";
import type { HandlerMap, HandlerServices } from "./types";
const platformInput = z.object({ platformId: distributionPlatformId });
export function createDistributionHandlers(
  services: Pick<HandlerServices, "distribution" | "ports" | "db" | "changed">,
) {
  return {
    "distribution.overview": () => services.distribution.overview(),
    "distribution.list": (object) =>
      services.distribution.list(distributionListInput.parse(object)),
    "distribution.prepare": (object) =>
      services.distribution.prepare(platformInput.parse(object).platformId),
    "distribution.start": (object) =>
      services.distribution.start(
        platformInput.extend({ rightsConfirmed: z.literal(true) }).parse(object)
          .platformId,
      ),
    "distribution.pause": (object) =>
      services.distribution.pause(platformInput.parse(object).platformId),
    "distribution.retry": (object) =>
      services.distribution.retry(platformInput.parse(object).platformId),
    "distribution.resolve": (object) =>
      services.distribution.resolve(distributionResolveInput.parse(object)),
    "distribution.history": (object) => {
      const input = z
        .object({
          taskId: z.string().min(1).max(100),
          page: z.number().int().min(1).default(1),
        })
        .parse(object);
      return services.distribution.history(input.taskId, input.page);
    },
    "distribution.batches": (object) => {
      const input = platformInput
        .extend({ page: z.number().int().min(1).default(1) })
        .parse(object);
      return services.distribution.batches(input.platformId, input.page);
    },
    "distribution.open": async (object) => {
      const input = platformInput
        .extend({ page: z.enum(["submit", "login"]) })
        .parse(object);
      if (!services.ports.distributionSessions)
        throw new AppError("UNAVAILABLE", "当前环境不能打开分发窗口。");
      await services.ports.distributionSessions.open(
        input.platformId,
        input.page,
      );
      return true;
    },
    "distribution.configure": (object) => {
      const input = platformInput
        .extend({
          alias: z.string().trim().max(100),
          note: z.string().trim().max(2000),
        })
        .parse(object);
      services.db.setSetting(`distribution:${input.platformId}`, {
        alias: input.alias,
        note: input.note,
      });
      services.changed();
      return true;
    },
  } satisfies HandlerMap;
}

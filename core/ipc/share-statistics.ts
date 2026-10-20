import { z } from "zod";
import { shareStatsFilterSchema } from "../share-statistics";

import type { HandlerServices, HandlerMap } from "./types";

export function createShareStatisticsHandlers(
  services: Pick<HandlerServices, "ports" | "shareStatistics">,
) {
  return {
    "shareStats.list": async (object) => {
      return services.shareStatistics.list(
        shareStatsFilterSchema.parse(object),
      );
    },
    "shareStats.refresh": async (object) => {
      const { accountIds } = z
        .object({
          accountIds: z
            .array(z.string().min(1).max(100))
            .min(1)
            .max(100)
            .optional(),
        })
        .parse(object);
      return services.shareStatistics.refresh(accountIds);
    },
    "shareStats.export": async (object) => {
      return services.ports.saveFile(
        "盘序-网盘分享统计.csv",
        Buffer.from(
          services.shareStatistics.export(shareStatsFilterSchema.parse(object)),
          "utf8",
        ),
      );
    },
  } satisfies HandlerMap;
}

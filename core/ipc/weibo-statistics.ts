import { z } from "zod";
import { websiteAccountIdSchema } from "../../shared/website-accounts";
import { weiboStatisticsInput } from "../../shared/weibo-statistics";
import type { HandlerMap, HandlerServices } from "./types";
export function createWeiboStatisticsHandlers({
  weiboStatistics,
}: Pick<HandlerServices, "weiboStatistics">) {
  return {
    "weiboStats.list": (raw) =>
      weiboStatistics.list(
        z.object({ accountId: websiteAccountIdSchema }).parse(raw).accountId,
      ),
    "weiboStats.get": (raw) => {
      const value = weiboStatisticsInput.parse(raw);
      return weiboStatistics.get(value.accountId, value.url);
    },
    "weiboStats.refresh": (raw) => {
      const value = weiboStatisticsInput.parse(raw);
      return weiboStatistics.refresh(value.accountId, value.url);
    },
  } satisfies HandlerMap;
}

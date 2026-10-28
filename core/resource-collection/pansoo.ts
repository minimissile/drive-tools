import { z } from "zod";
import { AppError } from "../errors";
import type { AppPorts } from "../ports";
import { collectionWebSearch } from "./web-request";
import {
  collectionShare,
  type CollectionCandidate,
} from "../../shared/resource-collection";

const searchResponse = z.object({
  total: z.number().int().nonnegative(),
  results: z.array(
    z.object({
      resource_id: z.union([z.string(), z.number()]),
      file_name: z.string().nullish(),
      title: z.string().nullish(),
      share_url: z.string().nullish(),
      original_url: z.string().nullish(),
      share_pwd: z.string().nullish(),
    }),
  ),
});
export class Pansoo {
  constructor(private session?: AppPorts["collectionWebSession"]) {}
  async search(keyword: string, page: number, signal: AbortSignal) {
    const response = await collectionWebSearch(
      this.session,
      "pansoo",
      keyword,
      page,
      signal,
    );
    if (
      response.status === "maintenance" ||
      response.code === "SEARCH_MAINTENANCE"
    )
      throw new AppError(
        "PANSOO_MAINTENANCE",
        "97盘搜网页搜索维护中，请稍后继续任务。",
      );
    if (
      ["error", "failed"].includes(String(response.status)) ||
      response.success === false
    )
      throw new AppError(
        "PANSOO_WEB_FAILED",
        "97盘搜网页搜索未完成，请打开97盘搜网页完成一次搜索或验证，再继续任务。",
      );
    const parsed = searchResponse.safeParse(response);
    if (!parsed.success)
      throw new AppError(
        "PANSOO_RESPONSE",
        "97盘搜网页结果格式已变化，未记作搜索无结果。",
      );
    const rows: CollectionCandidate[] = [];
    for (const item of parsed.data.results) {
      const share =
        collectionShare(item.original_url ?? "", item.share_pwd ?? "") ??
        collectionShare(item.share_url ?? "", item.share_pwd ?? "");
      if (!share) continue;
      rows.push({
        ...share,
        name: (item.file_name || item.title || keyword).trim().slice(0, 200),
        sourceName: "97盘搜",
        sourceUrl: `https://pansoo.net/resources/${encodeURIComponent(String(item.resource_id))}`,
        verified: false,
      });
    }
    return {
      rows,
      hasMore: page * 20 < parsed.data.total && parsed.data.results.length > 0,
    };
  }
}

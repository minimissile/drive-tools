import { z } from "zod";
import { AppError } from "../errors";
import type { AppPorts } from "../ports";
import { collectionWebSearch } from "./web-request";
import {
  collectionShare,
  type CollectionCandidate,
} from "../../shared/resource-collection";

const resultSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(
      z.object({
        hsid: z.string(),
        platform: z.string(),
        share_name: z.string().nullish(),
        share_code: z.string(),
        share_pwd: z.string().nullish(),
        share_url: z.string().nullish(),
      }),
    ),
    pagination: z.object({
      page: z.number().int().positive(),
      has_next: z.boolean(),
    }),
  }),
});
const shareBases: Record<string, string> = {
  ali: "https://www.alipan.com/s/",
  baidu: "https://pan.baidu.com/s/",
  quark: "https://pan.quark.cn/s/",
  xunlei: "https://pan.xunlei.com/s/",
  tianyi: "https://cloud.189.cn/t/",
  yidong: "https://yun.139.com/shareweb/#/w/i/",
  "115": "https://115.com/s/",
  "123": "https://www.123pan.com/s/",
  uc: "https://drive.uc.cn/s/",
  guangya: "https://www.guangyapan.com/s/",
};
export class Haisou {
  constructor(private session?: AppPorts["collectionWebSession"]) {}
  async search(keyword: string, page: number, signal: AbortSignal) {
    const response = await collectionWebSearch(
      this.session,
      "haisou",
      keyword,
      page,
      signal,
    );
    if (response.success === false) {
      const code = (response.error as { code?: unknown } | undefined)?.code;
      const limited = code === "RATE_LIMIT_EXCEEDED";
      throw new AppError(
        "HAISOU_WEB_FAILED",
        limited
          ? "海搜网页请求被限流，请稍后再继续任务。"
          : "海搜网页搜索未完成，请打开海搜网页核对登录、验证或站点搜索额度后继续任务。",
      );
    }
    const parsed = resultSchema.safeParse(response);
    if (!parsed.success || parsed.data.data.pagination.page !== page)
      throw new AppError(
        "HAISOU_RESPONSE",
        "海搜网页结果或分页格式已变化，未记作搜索无结果。",
      );
    const rows: CollectionCandidate[] = [];
    for (const item of parsed.data.data.items) {
      const base = shareBases[item.platform];
      const url =
        item.share_url ||
        (/^https?:\/\//.test(item.share_code)
          ? item.share_code
          : base && /^[\w.-]{1,256}$/.test(item.share_code)
            ? base + item.share_code
            : "");
      const share = collectionShare(url || "", item.share_pwd ?? "");
      if (!share) continue;
      rows.push({
        ...share,
        name: (item.share_name || keyword).trim().slice(0, 200),
        sourceName: "海搜",
        sourceUrl: `https://haisou.cc/s/${encodeURIComponent(item.hsid)}`,
        verified: false,
      });
    }
    return {
      rows,
      hasMore:
        parsed.data.data.pagination.has_next &&
        parsed.data.data.items.length > 0,
    };
  }
}

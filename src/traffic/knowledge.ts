import { baiduKeywordColumns } from "../../shared/baidu-keywords";
import type { Keyword } from "../../shared/types";

/** Historical API payloads may contain nested objects; pool metrics are scalar. */
export function keywordMetrics(
  raw: Record<string, unknown>,
): Keyword["metrics"] {
  const metrics: Keyword["metrics"] = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      value === null ||
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      metrics[key] = value;
  }
  return metrics;
}

export const keywordMetricNames: Record<string, string> = {
  ...Object.fromEntries(baiduKeywordColumns),
  index: "百度PC指数",
  mobile_index: "百度移动指数",
  douyin_index: "抖音指数",
  toutiao_index: "头条指数",
  kuaishou_index: "快手指数",
  weibo_index: "微博指数",
  haosou_index: "360指数",
  bidword_pcpv: "百度PC搜索量",
  bidword_wisepv: "百度移动搜索量",
  long_keyword_count: "长尾词数",
  sem_price: "竞价参考",
  event_hot_exp: "事件热度",
  baidu_pc_exp: "百度PC热度",
  baidu_move_exp: "百度移动热度",
};

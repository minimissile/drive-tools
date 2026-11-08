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
  averageMonthPvSource: "月均搜索量依据",
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

export const knowledgeSources = [
  { value: "", label: "全部来源" },
  { value: "baidu-discovery", label: "百度批量扩词" },
  { value: "baidu-keywords", label: "百度关键词规划师" },
  { value: "longtail", label: "5118长尾词" },
  { value: "suggest", label: "5118下拉词" },
  { value: "metrics", label: "5118搜索量" },
  { value: "radar", label: "5118热点" },
];
export const knowledgePlatforms = [
  { value: "", label: "全部平台" },
  { value: "baidu", label: "百度" },
  { value: "baidumobile", label: "百度移动" },
  { value: "xiaohongshu", label: "小红书" },
  { value: "douyin", label: "抖音" },
  { value: "kuaishou", label: "快手" },
  { value: "zhihu", label: "知乎" },
  { value: "weibo", label: "微博" },
  { value: "toutiao", label: "今日头条" },
  { value: "taobao", label: "淘宝" },
  { value: "tmall", label: "天猫" },
  { value: "jingdong", label: "京东" },
  { value: "pinduoduo", label: "拼多多" },
  { value: "360", label: "360搜索" },
  { value: "360mobile", label: "360移动" },
  { value: "sogou", label: "搜狗" },
  { value: "sogoumobile", label: "搜狗移动" },
  { value: "shenma", label: "神马" },
  { value: "amazon", label: "亚马逊" },
];
export function knowledgePlatformName(platform: string | null) {
  if (!platform) return "未限定平台";
  return (
    knowledgePlatforms.find((item) => item.value === platform)?.label ??
    platform
  );
}
export function knowledgeEndpointName(endpoint: string) {
  return (
    knowledgeSources.find((item) => item.value === endpoint)?.label ?? endpoint
  );
}
export const knowledgeStatusNames: Record<string, string> = {
  requested: "请求中",
  received: "已归档",
  pending: "分析中",
  success: "成功",
  uncertain: "结果或费用待核",
  recovered: "旧记录恢复",
};
export function primaryKeywordMetric(metrics: Record<string, unknown>) {
  for (const key of [
    "averageMonthPv",
    "bidword_pcpv",
    "index",
    "douyin_index",
    "event_hot_exp",
    "baidu_pc_exp",
  ]) {
    const value = metrics[key];
    if (value === undefined || value === null || value === "") continue;
    return {
      label: keywordMetricNames[key] ?? key,
      value:
        typeof value === "number"
          ? value.toLocaleString("zh-CN")
          : String(value),
      note:
        key === "averageMonthPv" &&
        String(metrics.averageMonthPvSource ?? "").includes("默认")
          ? "默认值 · 非实测"
          : "",
    };
  }
  return { label: "流量指标", value: "未提供", note: "" };
}

import type { Provider } from "./types";

export type MetricName = "views" | "saves" | "downloads";
export interface ShareMetric {
  value: number | null;
  precision: "exact" | "at_least" | "unknown";
  reason?: string;
}
export type ShareMetrics = Record<MetricName, ShareMetric>;
export type ShareState = "active" | "expired" | "unavailable" | "unknown";
export interface ProviderShareStatistic {
  shareId: string;
  title: string;
  url: string | null;
  state: ShareState;
  createdAt: string | null;
  expiresAt: string | null;
  metrics: ShareMetrics;
}
export interface ProviderShareStatsPage {
  items: ProviderShareStatistic[];
  hasMore: boolean;
  nextCursor?: string;
  total: number | null;
}
export interface ShareStatistic extends ProviderShareStatistic {
  accountId: string;
  accountAlias: string;
  provider: Provider;
  ownerUid: string;
  present: boolean;
  syncedAt: string;
  previousAt: string | null;
  previousMetrics: ShareMetrics | null;
  resourceId: string | null;
  copyId: string | null;
  splitItemId: string | null;
  resourceTitle: string | null;
  targetPath: string | null;
}
export interface ShareStatsSync {
  accountId: string;
  status: "never" | "running" | "success" | "failed";
  attemptedAt: string | null;
  succeededAt: string | null;
  count: number;
  error: string | null;
}
export interface ShareStatsFilter {
  provider?: Provider;
  accountId?: string;
  query: string;
  scope: "all" | "managed";
  state: "all" | ShareState | "missing";
  sort: MetricName | "createdAt";
  page: number;
  pageSize: number;
}
export interface MetricTotal {
  value: number | null;
  atLeast: boolean;
  known: number;
  unknown: number;
}
export interface ShareStatsResult {
  items: ShareStatistic[];
  total: number;
  page: number;
  pageSize: number;
  summary: Record<MetricName, MetricTotal>;
  syncs: ShareStatsSync[];
}
export interface ShareStatsRefreshResult {
  accountId: string;
  status: "success" | "failed" | "skipped";
  count: number;
  message: string;
}

export const metricNames: MetricName[] = ["views", "saves", "downloads"];
export const metricLabels: Record<MetricName, string> = {
  views: "浏览次数",
  saves: "保存 / 转存次数",
  downloads: "下载次数",
};
export const shareStateLabels: Record<ShareState, string> = {
  active: "有效",
  expired: "已过期",
  unavailable: "已失效 / 受限",
  unknown: "状态未返回",
};
export function formatShareMetric(metric: ShareMetric) {
  return metric.value == null
    ? "未返回"
    : `${metric.value.toLocaleString("zh-CN")}${metric.precision === "at_least" ? "+" : ""}`;
}
export function shareMetricDelta(current: ShareMetric, previous?: ShareMetric) {
  if (
    current.precision !== "exact" ||
    previous?.precision !== "exact" ||
    current.value == null ||
    previous.value == null ||
    current.value < previous.value
  )
    return null;
  return current.value - previous.value;
}

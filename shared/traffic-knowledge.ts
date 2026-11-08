import { z } from "zod";
/** Stable feed identifiers are data identity; these labels are presentation only. */
export const trafficSourceLabels = {
  "baidu-discovery": "百度批量扩词",
  "baidu-keywords": "百度营销 · 关键词规划师",
  longtail: "5118 长尾词 v2",
  suggest: "5118 下拉联想词",
  metrics: "5118 搜索量 v2",
  radar: "5118 热点雷达",
} as const;
/** A source-defined working set; underlying entries remain ordinary keywords. */
export const longtailKnowledgeEndpoints = [
  "baidu-discovery",
  "longtail",
] as const;
export const knowledgeFilter = z.object({
  search: z.string().trim().max(200).default(""),
  endpoint: z
    .enum([
      "",
      "longtail",
      "suggest",
      "metrics",
      "radar",
      "baidu-keywords",
      "baidu-discovery",
    ])
    .default(""),
  platform: z.string().trim().max(50).default(""),
  page: z.number().int().min(1).max(1000000).default(1),
  view: z.enum(["items", "queries"]).default("items"),
  kind: z.enum(["", "word", "hotspot", "longtail"]).default(""),
  sort: z.enum(["recent", "monthly", "word"]).default("recent"),
  volume: z.enum(["", "measured", "default", "unknown"]).default(""),
  cursor: z.string().max(2048).nullable().optional(),
});
export type KnowledgeFilter = z.infer<typeof knowledgeFilter>;
export interface KnowledgeQuery {
  id: string;
  endpoint: string;
  phase: string;
  request: Record<string, unknown>;
  seeds: string[];
  platform: string | null;
  status: string;
  startedAt: string | null;
  receivedAt: string | null;
  httpStatus: number | null;
  message: string;
  legacy: boolean;
  count: number;
}
export interface KnowledgeItem {
  id: string;
  entryId: string;
  queryId: string;
  kind: string;
  word: string;
  platform: string | null;
  source: string;
  metrics: Record<string, unknown>;
  observedAt: string | null;
  firstObservedAt: string | null;
  sourceUpdatedAt: string | null;
  observations: number;
  sourceKey?: string;
  endpoint?: string;
}
export interface KnowledgeOverview {
  revision: number;
  summary: {
    queries: number;
    responses: number;
    words: number;
    hotspots: number;
    observations: number;
    legacy: number;
  };
  seeds: { word: string; queries: number; results: number }[];
  patterns: { name: string; count: number }[];
}
export interface KnowledgePage {
  total: number;
  page: number;
  pageSize: number;
  items: KnowledgeItem[];
  queries: KnowledgeQuery[];
  nextCursor: string | null;
  /** Older UI fixtures may include these; ordinary page reads never compute them. */
  summary?: KnowledgeOverview["summary"];
  seeds?: KnowledgeOverview["seeds"];
  patterns?: KnowledgeOverview["patterns"];
}
export interface KnowledgeDetail {
  query: KnowledgeQuery;
  response: string | null;
  recoveredObservations?: string;
}
export const knowledgeHistoryInput = z.object({
  entryId: z.string().min(1).max(200),
  page: z.number().int().min(1).max(1000000).default(1),
});
export interface KnowledgeHistory {
  entry: Pick<
    KnowledgeItem,
    "entryId" | "word" | "kind" | "platform" | "source"
  >;
  items: KnowledgeItem[];
  total: number;
  page: number;
  pageSize: number;
}
export interface KnowledgeContract {
  "traffic.knowledge.overview": {
    args: undefined;
    value: KnowledgeOverview;
  };
  "traffic.knowledge.resolve": {
    args: { observationIds: string[] };
    value: { items: KnowledgeItem[]; missingIds: string[] };
  };
  "traffic.knowledge.history": {
    args: { entryId: string; page?: number };
    value: KnowledgeHistory;
  };
}

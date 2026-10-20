import { z } from "zod";
export const knowledgeFilter = z.object({
  search: z.string().trim().max(200).default(""),
  endpoint: z
    .enum(["", "longtail", "suggest", "metrics", "radar", "baidu-keywords"])
    .default(""),
  platform: z.string().trim().max(50).default(""),
  page: z.number().int().min(1).max(1000000).default(1),
  view: z.enum(["items", "queries"]).default("items"),
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
}
export interface KnowledgePage {
  total: number;
  page: number;
  pageSize: number;
  items: KnowledgeItem[];
  queries: KnowledgeQuery[];
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
export interface KnowledgeDetail {
  query: KnowledgeQuery;
  response: string | null;
}

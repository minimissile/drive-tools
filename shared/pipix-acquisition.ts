import { z } from "zod";
import type { PipixComment } from "./pipix";
import type { SupplyDraft } from "./content-supply";

export const pipixRequestPolicy = z.object({
  dailyRequests: z.number().int().min(0).max(10000).default(20),
  requestsPerRun: z.number().int().min(1).max(100).default(4),
  listPagesPerRun: z.number().int().min(0).max(20).default(1),
  commentPagesPerItem: z.number().int().min(0).max(20).default(1),
  itemsPerRun: z.number().int().min(1).max(20).default(2),
  excludedCommentTerms: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .array()
    .max(100)
    .default(["皮皮虾", "皮友", "皮皮", "虾友", "皮一下"]),
});
export type PipixRequestPolicy = z.output<typeof pipixRequestPolicy>;
export interface PipixRequestUsage {
  policy: PipixRequestPolicy;
  usedToday: number;
  remainingToday: number;
}
export const pipixCommentsRead = z.object({
  sourceId: z.string().regex(/^\d{8,30}$/),
  page: z.number().int().min(1).max(1000000).default(1),
  labeledOnly: z.boolean().default(false),
});
export const pipixCommentsFetch = z.object({
  sourceId: z.string().regex(/^\d{8,30}$/),
  refresh: z.boolean().default(false),
  confirmed: z.literal(true),
});
export interface PipixCommentsPage {
  sourceId: string;
  items: PipixComment[];
  total: number;
  labeled: number;
  page: number;
  pageSize: number;
  responses: number;
  latestAt: string | null;
  hasMore: boolean;
  nextCursor: string | null;
  issue: string;
  needsAttention: boolean;
  usableTotal: number;
  excluded: number;
}
export interface PipixCommentResponse {
  items: PipixComment[];
  nextCursor: string | null;
  hasMore: boolean;
  warnings: string[];
  responseId: string;
  cached: boolean;
}
export const supplyAcquireInput = z.object({
  planId: z.string().max(150).default(""),
  accountId: z.string().max(150).default(""),
  direction: z.string().trim().min(1).max(1000),
  audience: z.string().trim().max(1000).default(""),
  keyword: z.string().trim().min(1).max(200),
  comments: z.boolean().default(true),
  confirmed: z.literal(true),
});
export type SupplyAcquireInput = z.output<typeof supplyAcquireInput>;
export interface SupplyAcquireRun {
  id: string;
  status: "running" | "paused" | "completed" | "attention";
  phase: "local" | "lists" | "comments" | "collection" | "done";
  context: Omit<SupplyAcquireInput, "confirmed">;
  policy: PipixRequestPolicy;
  queries: string[];
  queryIndex: number;
  listPages: number;
  sourceIds: string[];
  commentsDone: string[];
  commentPages: Record<string, number>;
  draftIds: string[];
  requestsUsed: number;
  reason: string;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}
type Contract<A, V> = { args: A; value: V };
export interface PipixAcquisitionContract {
  "pipix.checkConnection": Contract<undefined, { status: number }>;
  "pipix.requestPolicy": Contract<undefined, PipixRequestUsage>;
  "pipix.saveRequestPolicy": Contract<
    z.input<typeof pipixRequestPolicy>,
    PipixRequestUsage
  >;
  "pipix.comments": Contract<
    z.input<typeof pipixCommentsRead>,
    PipixCommentsPage
  >;
  "pipix.fetchComments": Contract<
    z.input<typeof pipixCommentsFetch>,
    PipixCommentsPage
  >;
  "pipix.reindexComments": Contract<{ sourceId: string }, PipixCommentsPage>;
  "contentSupply.acquisition": Contract<
    undefined,
    { runs: SupplyAcquireRun[]; busy: boolean; usage: PipixRequestUsage }
  >;
  "contentSupply.acquire": Contract<
    z.input<typeof supplyAcquireInput>,
    SupplyAcquireRun
  >;
  "contentSupply.acquirePause": Contract<undefined, boolean>;
  "contentSupply.acquireResume": Contract<
    { id: string; confirmed: true },
    SupplyAcquireRun
  >;
  "contentSupply.attachComments": Contract<
    { id: string; version: number; commentIds: string[] },
    SupplyDraft
  >;
}

export function pipixCommentExclusions(
  comment: { text: string; author: string },
  terms: readonly string[],
) {
  const normalize = (value: string) =>
    value
      .normalize("NFKC")
      .replace(/[\s\u200b-\u200d\ufeff]/g, "")
      .toLocaleLowerCase();
  const fields = [normalize(comment.text), normalize(comment.author)];
  return terms.filter((term) => {
    const value = normalize(term);
    return !!value && fields.some((field) => field.includes(value));
  });
}

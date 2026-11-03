import { z } from "zod";
import type { PipixCandidate, PipixItem } from "./pipix";
import type { RuntimeLogPage, runtimeLogQuery } from "./runtime-logs";

export const supplyContextSchema = z.object({
  planId: z.string().max(150).default(""),
  accountId: z.string().max(150).default(""),
  direction: z.string().trim().max(1000).default(""),
  audience: z.string().trim().max(1000).default(""),
});
export const supplyEditorialSchema = supplyContextSchema.extend({
  purpose: z.enum(["warming", "regular"]).default("warming"),
  angle: z.string().trim().max(2000).default(""),
  contribution: z.string().trim().max(8000).default(""),
  checks: z.string().trim().max(8000).default(""),
  title: z.string().trim().max(100).default(""),
  body: z.string().trim().max(45000).default(""),
  imageIds: z.string().max(100).array().max(9).default([]),
  commentIds: z.string().max(100).array().max(50).default([]),
  textBasis: z
    .enum([
      "unknown",
      "reference",
      "own",
      "authorized",
      "license",
      "public-domain",
      "quotation",
    ])
    .default("unknown"),
  textEvidence: z.string().trim().max(2000).default(""),
  imageBasis: z
    .enum([
      "unknown",
      "own",
      "authorized",
      "license",
      "public-domain",
      "quotation",
    ])
    .default("unknown"),
  imageEvidence: z.string().trim().max(2000).default(""),
  commentBasis: z
    .enum([
      "unknown",
      "own",
      "authorized",
      "license",
      "public-domain",
      "quotation",
    ])
    .default("unknown"),
  commentEvidence: z.string().trim().max(2000).default(""),
  aiAssisted: z.boolean().default(false),
});
export type SupplyEditorial = z.output<typeof supplyEditorialSchema>;
export type SupplyStage =
  "queued" | "collecting" | "blocked" | "editing" | "held" | "delivered";
export interface SupplyDelivery {
  channel: "zhihu" | "weibo";
  accountId: string;
  targetId: string;
  title: string;
  fingerprint: string;
  createdAt: string;
  planLinked: boolean;
  linkError: string;
}
export interface SupplyDraft {
  id: string;
  sourceId: string;
  version: number;
  stage: SupplyStage;
  reason: string;
  source: PipixItem | null;
  editorial: SupplyEditorial;
  deliveries: SupplyDelivery[];
  createdAt: string;
  updatedAt: string;
}
export interface SupplyCandidate extends PipixCandidate {
  matched: string[];
  reason: string;
  draftId: string | null;
  stage: SupplyStage | null;
}
export const supplyCandidateInput = z.object({
  keyword: z.string().trim().max(200).default(""),
  page: z.number().int().min(1).max(1000000).default(1),
});
export const supplyStartInput = supplyContextSchema.extend({
  sourceIds: z
    .string()
    .regex(/^\d{8,30}$/)
    .array()
    .min(1)
    .max(20),
});
export const supplySaveInput = z.object({
  id: z.string().max(150),
  version: z.number().int().positive(),
  editorial: supplyEditorialSchema,
});
export const supplyActionInput = z.object({
  id: z.string().max(150),
  version: z.number().int().positive(),
});
export const supplyDeliverInput = supplyActionInput.extend({
  channel: z.enum(["zhihu", "weibo"]),
  accountId: z.string().max(150).default(""),
  confirmed: z.literal(true),
});
type Contract<A, V> = { args: A; value: V };
export interface ContentSupplyContract {
  "contentSupply.image": Contract<{ id: string; imageId: string; sha256: string }, string>;
  "contentSupply.candidates": Contract<
    z.input<typeof supplyCandidateInput>,
    {
      items: SupplyCandidate[];
      total: number;
      page: number;
      pageSize: number;
      allPosts: number;
    }
  >;
  "contentSupply.snapshot": Contract<
    undefined,
    {
      drafts: SupplyDraft[];
      busy: boolean;
      collecting: boolean;
      logFolder: string;
      ai: { configured: boolean; model: string };
    }
  >;
  "contentSupply.start": Contract<
    z.input<typeof supplyStartInput>,
    { ids: string[]; reused: number }
  >;
  "contentSupply.pause": Contract<undefined, { stopping: boolean }>;
  "contentSupply.resume": Contract<{ ids: string[] }, { started: number }>;
  "contentSupply.save": Contract<z.input<typeof supplySaveInput>, SupplyDraft>;
  "contentSupply.hold": Contract<
    z.input<typeof supplyActionInput> & { reason: string },
    SupplyDraft
  >;
  "contentSupply.reopen": Contract<
    z.input<typeof supplyActionInput>,
    SupplyDraft
  >;
  "contentSupply.refreshSource": Contract<
    z.input<typeof supplyActionInput>,
    SupplyDraft
  >;
  "contentSupply.generate": Contract<
    z.input<typeof supplyActionInput> & { confirmed: true },
    SupplyDraft
  >;
  "contentSupply.deliver": Contract<
    z.input<typeof supplyDeliverInput>,
    { draft: SupplyDraft; existing: boolean }
  >;
  "contentSupply.linkPlan": Contract<
    z.input<typeof supplyActionInput> & { channel: "zhihu" | "weibo" },
    SupplyDraft
  >;
  "contentSupply.logs": Contract<
    z.input<typeof runtimeLogQuery>,
    RuntimeLogPage
  >;
}

export function supplyBody(source: PipixItem, editorial: SupplyEditorial) {
  const comments = editorial.commentIds
    .map((id) => source.comments.find((c) => c.id === id))
    .filter((c) => !!c);
  return [
    editorial.body,
    ...comments.map((c) => `引用评论（${c.author}）：\n${c.text}`),
    editorial.purpose === "warming"
      ? `参考来源：皮皮虾 · ${source.author}（原帖 ${source.id}）`
      : `参考来源：皮皮虾 · ${source.author}\n${source.url}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

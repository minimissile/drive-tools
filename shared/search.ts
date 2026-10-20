import { z } from "zod";
import { platformSchema } from "./schemas";
import type { Draft, Platform, Publication, SplitItem } from "./types";

export type TopicStage = "unbound" | "writing" | "published";
export interface SearchTopic {
  id: string;
  keyword: string;
  intent: string;
  platform: Platform;
  poolId: string | null;
  keywordId: string | null;
  copyId: string | null;
  splitItemId: string | null;
  resourceId: string | null;
  resourceTitle: string | null;
  targetPath: string | null;
  softwareVersion: string;
  operatingSystem: string;
  evidence: string;
  draftId: string | null;
  draftTitle: string | null;
  reviewed: boolean;
  publicationId: string | null;
  publicationUrl: string | null;
  stage: TopicStage;
  attention: string[];
  createdAt: string;
  updatedAt: string;
}
export interface EffectRecord {
  id: string;
  topicId: string | null;
  publicationId: string;
  bindingId: string;
  scope: "article" | "account";
  periodStart: string;
  periodEnd: string;
  views: number | null;
  saves: number | null;
  newUsers: number | null;
  revenueCents: number | null;
  source: string;
  createdAt: string;
}
export interface SearchPage {
  items: SearchTopic[];
  total: number;
  page: number;
  counts: Record<TopicStage, number>;
}
export interface SearchDetail {
  topic: SearchTopic;
  draft: Draft | null;
  publications: Publication[];
  effects: EffectRecord[];
}
export interface SearchTargets {
  copyId: string;
  wholeReady: boolean;
  items: SplitItem[];
  total: number;
  page: number;
}
export const topicInput = z.object({
  keyword: z.string().trim().min(1).max(200),
  intent: z.string().trim().max(100).default(""),
  platform: platformSchema.default("csdn"),
  poolId: z.string().nullable().default(null),
  keywordId: z.string().nullable().default(null),
  copyId: z.string().nullable().default(null),
  splitItemId: z.string().nullable().default(null),
});
export const topicFacts = z.object({
  softwareVersion: z.string().trim().max(100),
  operatingSystem: z.string().trim().max(100),
  evidence: z.string().trim().max(10000),
});
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      !Number.isNaN(Date.parse(s)) &&
      new Date(s).toISOString().slice(0, 10) === s,
    "请填写有效日期",
  );
const count = z.number().int().nonnegative().max(1_000_000_000).nullable();
export const effectInput = z
  .object({
    publicationId: z.string().min(1),
    scope: z.enum(["article", "account"]),
    periodStart: day,
    periodEnd: day,
    views: count,
    saves: count,
    newUsers: count,
    revenueCents: z
      .number()
      .int()
      .nonnegative()
      .max(1_000_000_000_000)
      .nullable(),
    source: z.string().trim().min(1).max(500),
  })
  .refine((i) => i.periodEnd >= i.periodStart, "结束日期不能早于开始日期")
  .refine(
    (i) =>
      [i.views, i.saves, i.newUsers, i.revenueCents].some((v) => v !== null),
    "请至少录入一项已知数据",
  );

import { z } from "zod";
import type { RuntimeLogPage } from "./runtime-logs";

export type TiebaVisibility =
  "visible" | "pending_review" | "unavailable" | "unknown";
export interface TiebaMetricPoint {
  checkedAt: string;
  level: number | null;
  experience: number | null;
}
export interface TiebaMetricTarget extends TiebaMetricPoint {
  targetId: string;
  accountId: string;
  name: string;
  deltaLevel: number | null;
  deltaExperience: number | null;
  history: TiebaMetricPoint[];
}
export interface TiebaPublicationRef {
  id: string;
  kind: "reply" | "topic";
  accountId: string;
  uid: string;
  forumId: string;
  forumName: string;
  threadId: string | null;
  postId: string | null;
  title: string;
  url: string | null;
  body: string;
  submittedAt: string;
  submissionStatus: "verified" | "uncertain" | "pending_review";
}
export interface TiebaVisibilityReading {
  visibility: TiebaVisibility;
  checkedAt: string;
  message: string;
}
export interface TiebaPublicationView
  extends
    Omit<TiebaPublicationRef, "uid" | "body" | "forumId" | "postId">,
    Omit<TiebaVisibilityReading, "checkedAt"> {
  checkedAt: string | null;
  nextCheckAt: string | null;
}
export type TiebaStrategyPreset = "conservative" | "standard";
export interface TiebaStrategyRecommendation {
  id: string;
  title: string;
  reason: string;
  preset: TiebaStrategyPreset | null;
}
export interface TiebaInsightsSnapshot {
  refreshResult?: {
    succeeded: string[];
    failed: { id: string; message: string }[];
  };
  busy: boolean;
  settings: { revision: number; autoReview: boolean };
  targets: TiebaMetricTarget[];
  publications: TiebaPublicationView[];
  recommendations: TiebaStrategyRecommendation[];
  logs: RuntimeLogPage;
  message: string;
}
export const tiebaInsightsRefreshSchema = z.object({
  targetIds: z
    .array(z.string().regex(/^tiebatarget_[\w-]+$/))
    .max(5)
    .optional(),
  publicationIds: z.array(z.string().min(1).max(150)).max(5).optional(),
});
export const tiebaInsightsSaveSchema = z.object({
  revision: z.number().int().positive(),
  autoReview: z.boolean(),
});
export const tiebaInsightsPresetSchema = z.object({
  preset: z.enum(["conservative", "standard"]),
  automationRevision: z.number().int().positive(),
});
type Contract<A> = { args: A; value: TiebaInsightsSnapshot };
export interface TiebaInsightsContract {
  "tieba.insights.snapshot": Contract<undefined>;
  "tieba.insights.refresh": Contract<
    z.infer<typeof tiebaInsightsRefreshSchema>
  >;
  "tieba.insights.save": Contract<z.infer<typeof tiebaInsightsSaveSchema>>;
  "tieba.insights.applyPreset": Contract<
    z.infer<typeof tiebaInsightsPresetSchema>
  >;
}

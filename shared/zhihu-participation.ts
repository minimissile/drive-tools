import { z } from "zod";
import {
  websiteAccountIdSchema,
  type WebsiteAccount,
} from "./website-accounts";
import type {
  ZhihuInteractionAttempt,
  ZhihuInteractionDecision,
  ZhihuInteractionContinuation,
} from "./zhihu-interaction";
import type { runtimeLogQuery, RuntimeLogPage } from "./runtime-logs";

export const zhihuResearchKinds = [
  "question",
  "answer",
  "article",
  "author",
] as const;
export type ZhihuResearchKind = (typeof zhihuResearchKinds)[number];
export const zhihuRecommendedQuestionsUrl =
  "https://www.zhihu.com/creator/featured-question/recommend";
export const zhihuRecommendedMinimumViews = 10000;
export const zhihuQuestionRecommendationSchema = z.object({
  sourceUrl: z.literal(zhihuRecommendedQuestionsUrl),
  views: z.number().int().safe().gt(zhihuRecommendedMinimumViews),
  viewText: z.string().trim().min(1).max(100),
  observedAt: z.iso.datetime(),
});
/** Strict official content locations only. No redirects, tracking queries, or credentials. */
export function canonicalZhihuParticipationUrl(value: string): string | null {
  try {
    if (
      value.trim() !== value ||
      /[\\?#]/.test(value) ||
      /%2e|\/\.\.?\//i.test(value) ||
      (!/^https:\/\/(?:www\.)?zhihu\.com\//i.test(value) &&
        !/^https:\/\/zhuanlan\.zhihu\.com\//i.test(value))
    )
      return null;
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return null;
    const host = url.hostname.toLowerCase(),
      path = url.pathname.replace(/\/$/, "");
    if (
      ["zhihu.com", "www.zhihu.com"].includes(host) &&
      (/^\/question\/[1-9]\d{0,29}$/.test(path) ||
        /^\/question\/[1-9]\d{0,29}\/answer\/[1-9]\d{0,29}$/.test(path) ||
        /^\/people\/[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(path))
    )
      return `https://www.zhihu.com${path}`;
    if (host === "zhuanlan.zhihu.com" && /^\/p\/[1-9]\d{0,29}$/.test(path))
      return `https://zhuanlan.zhihu.com${path}`;
  } catch {
    /* Invalid URLs stay invalid; never guess an external target. */
  }
  return null;
}
export function zhihuParticipationUrlKind(
  value: string,
): ZhihuResearchKind | null {
  const canonical = canonicalZhihuParticipationUrl(value);
  if (!canonical) return null;
  if (canonical.includes("/answer/")) return "answer";
  if (canonical.includes("/question/")) return "question";
  return canonical.includes("/people/") ? "author" : "article";
}
const officialUrl = z
  .string()
  .max(1000)
  .transform((value, ctx) => {
    const canonical = canonicalZhihuParticipationUrl(value);
    if (!canonical) {
      ctx.addIssue({
        code: "custom",
        message: "仅支持无参数的知乎官方问题、回答、文章或作者链接",
      });
      return z.NEVER;
    }
    return canonical;
  });
export const zhihuResearchHitSchema = z
  .object({
    kind: z.enum(zhihuResearchKinds),
    url: officialUrl,
    title: z.string().trim().min(1).max(300),
    excerpt: z.string().max(2000),
    author: z.string().max(300).optional(),
    recommendation: zhihuQuestionRecommendationSchema.optional(),
  })
  .refine((value) => zhihuParticipationUrlKind(value.url) === value.kind, {
    message: "内容类型与官方链接路径不符",
    path: ["url"],
  });
export type ZhihuResearchHit = z.output<typeof zhihuResearchHitSchema>;
export const zhihuResearchDocumentSchema = z
  .object({
    kind: z.enum(zhihuResearchKinds),
    url: officialUrl,
    title: z.string().trim().min(1).max(300),
    text: z.string().trim().min(1).max(16000),
    observedAt: z.iso.datetime(),
    truncated: z.boolean().optional(),
    related: zhihuResearchHitSchema.array().max(10),
  })
  .refine((value) => zhihuParticipationUrlKind(value.url) === value.kind, {
    message: "上下文类型与官方链接路径不符",
    path: ["url"],
  });
export type ZhihuResearchDocument = z.output<
  typeof zhihuResearchDocumentSchema
>;
export interface ZhihuParticipationBrowserPort {
  discover(
    account: WebsiteAccount,
    input: {
      query: string;
      kind: "question" | "author";
      limit: number;
      source?: "search" | "creator_recommend";
    },
  ): Promise<ZhihuResearchHit[]>;
  inspect(
    account: WebsiteAccount,
    input: { url: string },
  ): Promise<ZhihuResearchDocument>;
}
export interface ZhihuParticipationCandidate extends ZhihuResearchHit {
  id: string;
  accountId: string;
  version: number;
  document: ZhihuResearchDocument | null;
  checkedAt: string;
}
export const zhihuParticipationKinds = [
  "read",
  "answer",
  "comment",
  "like",
  "follow",
] as const;
export type ZhihuParticipationKind = (typeof zhihuParticipationKinds)[number];
export type ZhihuParticipationStatus =
  | "planned"
  | "needs_review"
  | "prepared"
  | "done"
  | "skipped"
  | "executing"
  | "queued"
  | "succeeded"
  | "attention"
  | "failed";
export interface ZhihuParticipationActivity {
  id: string;
  accountId: string;
  planId: string | null;
  candidateId: string;
  candidateVersion: number;
  kind: ZhihuParticipationKind;
  reason: string;
  draft: string;
  createdAt: string;
  scheduledAt: string | null;
  status: ZhihuParticipationStatus;
  contentId: string | null;
  version: number;
  basis: string;
  /** Immutable context used when preparing this activity, not a claim of having read it. */
  context: ZhihuResearchDocument | null;
  /** Remote attempts are separate from the person's self-reported completion. */
  attempts?: ZhihuInteractionAttempt[];
  automation?: {
    planRevision: number;
    decision: ZhihuInteractionDecision;
    queuedAt: string;
    continuation?: ZhihuInteractionContinuation;
  };
  resolution: {
    outcome: "done" | "skipped";
    note: string;
    at: string;
    evidence: "self_report";
  } | null;
}
export interface ZhihuParticipationSnapshot {
  candidates: ZhihuParticipationCandidate[];
  activities: ZhihuParticipationActivity[];
  busy: boolean;
  logFolder: string;
}
export const zhihuParticipationDiscoverInput = z
  .object({
    accountId: websiteAccountIdSchema,
    query: z.string().trim().max(200).default(""),
    kind: z.enum(["question", "author"]),
    source: z.enum(["search", "creator_recommend"]).default("search"),
    refresh: z.boolean().default(false),
  })
  .refine(
    (v) =>
      v.source === "creator_recommend" ? v.kind === "question" : !!v.query,
    { message: "关键词搜索需要关键词；创作者推荐仅支持问题" },
  );
export const zhihuParticipationInspectInput = z.object({
  accountId: websiteAccountIdSchema,
  candidateId: z.string().max(150),
  version: z.number().int().positive(),
});
export const zhihuParticipationPlanInput =
  zhihuParticipationInspectInput.extend({
    kind: z.enum(zhihuParticipationKinds),
    reason: z.string().trim().min(5).max(2000),
    draft: z.string().trim().max(12000).default(""),
    scheduledAt: z.iso.datetime({ offset: true }).nullable().default(null),
    planId: z
      .string()
      .regex(/^(?:ioplan|autocare)_[\w-]+$/)
      .nullable()
      .default(null),
  });
export const zhihuParticipationSaveInput = z.object({
  id: z.string().max(150),
  version: z.number().int().positive(),
  reason: z.string().trim().min(5).max(2000),
  draft: z.string().trim().max(12000),
});
export const zhihuParticipationResolveInput = z.object({
  id: z.string().max(150),
  version: z.number().int().positive(),
  outcome: z.enum(["done", "skipped"]),
  note: z.string().trim().min(5).max(2000),
  confirmed: z.literal(true),
});
export const zhihuParticipationAnswerInput = z.object({
  id: z.string().max(150),
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(100),
  body: z.string().trim().min(30).max(12000),
  basis: z.string().trim().min(10).max(4000),
  confirmed: z.literal(true),
});
type Contract<A, V> = { args: A; value: V };
export interface ZhihuParticipationContract {
  "zhihu.participation.logs": Contract<
    z.input<typeof runtimeLogQuery>,
    RuntimeLogPage
  >;
  "zhihu.participation.reconcile": Contract<
    { id: string; version: number },
    ZhihuParticipationActivity
  >;
  "zhihu.participation.snapshot": Contract<
    undefined,
    ZhihuParticipationSnapshot
  >;
  "zhihu.participation.discover": Contract<
    z.input<typeof zhihuParticipationDiscoverInput>,
    ZhihuParticipationCandidate[]
  >;
  "zhihu.participation.inspect": Contract<
    z.input<typeof zhihuParticipationInspectInput>,
    ZhihuParticipationCandidate
  >;
  "zhihu.participation.plan": Contract<
    z.input<typeof zhihuParticipationPlanInput>,
    ZhihuParticipationActivity
  >;
  "zhihu.participation.save": Contract<
    z.input<typeof zhihuParticipationSaveInput>,
    ZhihuParticipationActivity
  >;
  "zhihu.participation.resolve": Contract<
    z.input<typeof zhihuParticipationResolveInput>,
    ZhihuParticipationActivity
  >;
  "zhihu.participation.answer": Contract<
    z.input<typeof zhihuParticipationAnswerInput>,
    { activity: ZhihuParticipationActivity; contentId: string }
  >;
}

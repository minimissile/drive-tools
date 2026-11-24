import { z } from "zod";
import { tiebaForumNameSchema } from "./tieba-forums";
import type { TiebaForumExposure } from "./tieba-analysis";

export const tiebaResourceSeedsSchema = z.object({
  seeds: z
    .array(tiebaForumNameSchema)
    .min(1, "至少填写一个种子贴吧。")
    .max(5, "最多填写五个种子贴吧。"),
});

export interface TiebaDiscoveryEvidence {
  keys: string[];
  linked: boolean;
}

export interface TiebaDiscoveryGrowth {
  from: number;
  to: number;
  delta: number;
  hourly: number;
}

export interface TiebaDiscoveryRank {
  place: number;
  sample: number;
}

export interface TiebaDiscoveryMetrics {
  views: number | null;
  replies: number | null;
  likes: number | null;
  shares: number | null;
}

export interface TiebaDiscoveryPotentialEvidence extends TiebaDiscoveryMetrics {
  at: number;
  hourlyViews?: number;
  recentGrowth?: TiebaDiscoveryGrowth;
}

export interface TiebaDiscoveryCandidate {
  id: string;
  title: string;
  url: string;
  forum: string;
  author: string;
  publishedAt: string;
  linked: boolean;
  views: number | null;
  growth: TiebaDiscoveryGrowth | null;
  rank: TiebaDiscoveryRank | null;
  streak: number;
  copies: number;
  resource?: TiebaOldResourceEvidence;
}

export interface TiebaDiscoveryReadingPost extends TiebaDiscoveryMetrics {
  id: string;
  title: string;
  url: string;
  forum: string;
  author: string;
  publishedAt: string;
  checkedAt: number;
  resource?: TiebaOldResourceEvidence;
}

export interface TiebaDiscoveryPotentialPost extends TiebaDiscoveryReadingPost {
  first: TiebaDiscoveryPotentialEvidence;
  confirmedGrowth?: TiebaDiscoveryGrowth;
  confirmedAt: number | null;
  active: boolean;
  awaitingMatureReading?: boolean;
}

export interface TiebaDiscoveryPendingPost extends TiebaDiscoveryReadingPost {
  queuedAt: number;
  dueAt: number;
}

export interface TiebaDiscoveryTrafficPost extends TiebaDiscoveryReadingPost {
  views: number;
  fromPotential: boolean;
  archivedAt?: number;
}

export const defaultOldTrafficThreshold = 30;
export const tiebaCumulativeTrafficDays = 30;
export const defaultRecentGrowthDailyViews = 48;
export const recentGrowthMaxReadingHours = 24;
export const oldTrafficMinimumAgeDays = 7;
export const oldTrafficObservationDays = 3;
export const defaultPendingObservationHours = 24;
export const pendingObservationMultiplier = 2;
export const tiebaDiscoveryLogLimit = 50;

export const tiebaOldResourceSources = ["标题", "正文", "回复"] as const;
export interface TiebaOldResourceEvidence {
  linkSources: (typeof tiebaOldResourceSources)[number][];
  keywords: string[];
}

export interface TiebaOldTrafficPost {
  id: string;
  title: string;
  url: string;
  forum: string;
  publishedAt: string;
  views: number;
  checkedAt: number;
  observationAt?: number;
  lifetimeDailyViews: number;
  baselineAt: number | null;
  addedViews: number | null;
  dailyAddedViews: number | null;
  sustained: boolean;
  resource?: TiebaOldResourceEvidence & { checked: boolean };
}

export const tiebaDiscoveryRulesSchema = z.object({
  lookbackHours: z.number().int().min(1).max(720),
  minHourlyViews: z.number().min(0).max(Number.MAX_SAFE_INTEGER),
  recentGrowthMinDailyViews: z.number().min(1).max(Number.MAX_SAFE_INTEGER).default(defaultRecentGrowthDailyViews),
  trafficThreshold: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  oldTrafficMinTotalViews: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1000),
  oldTrafficMinLifetimeDailyViews: z.number().min(0).max(Number.MAX_SAFE_INTEGER).default(10),
  oldTrafficMinViews: z.number().min(1).max(Number.MAX_SAFE_INTEGER).default(defaultOldTrafficThreshold),
  oldResourceCheckEnabled: z.boolean().default(true),
  pendingObservationHours: z.number().min(0.5).max(719).optional(),
}).refine(
  ({ lookbackHours, pendingObservationHours }) =>
    pendingObservationHours === undefined || pendingObservationHours < lookbackHours,
  { path: ["pendingObservationHours"], message: "待观察时长须短于潜力帖观察期。" },
).transform(({ pendingObservationHours, ...rules }) => ({
  ...rules,
  pendingObservationHours: pendingObservationHours ??
    (rules.lookbackHours > defaultPendingObservationHours
      ? defaultPendingObservationHours
      : rules.lookbackHours / 2),
}));

export type TiebaDiscoveryRules = z.infer<typeof tiebaDiscoveryRulesSchema>;

export const defaultTiebaDiscoveryRules: Readonly<TiebaDiscoveryRules> = {
  lookbackHours: 48,
  minHourlyViews: 3,
  recentGrowthMinDailyViews: defaultRecentGrowthDailyViews,
  trafficThreshold: 10_000,
  oldTrafficMinTotalViews: 1000,
  oldTrafficMinLifetimeDailyViews: 10,
  oldTrafficMinViews: defaultOldTrafficThreshold,
  oldResourceCheckEnabled: true,
  pendingObservationHours: defaultPendingObservationHours,
};

export const tiebaDiscoveryPageSize = 10;
export const tiebaDiscoveryRecycleLimit = 500;
export type TiebaDiscoveryRecycleSource = "potential" | "pending" | "traffic";
export interface TiebaDiscoveryRecycledPost {
  post: Pick<TiebaDiscoveryReadingPost, "id" | "title" | "url" | "forum" | "publishedAt" | "views">;
  source: TiebaDiscoveryRecycleSource;
  reason: "belowThreshold" | "observationExpired" | "resource";
  recycledAt: number;
}
export const tiebaDiscoveryRefreshSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["potential", "pending", "traffic", "trending", "oldTraffic", "trafficPosts"]),
    ids: z.array(z.string().regex(/^[1-9]\d{0,18}$/)).min(1).max(tiebaDiscoveryPageSize),
  }),
  z.object({
    kind: z.literal("sources"),
    names: z.array(tiebaForumNameSchema).min(1).max(tiebaDiscoveryPageSize),
  }),
]);
export type TiebaDiscoveryRefresh = z.output<typeof tiebaDiscoveryRefreshSchema>;
export const tiebaDiscoveryImportSchema = z.object({
  id: z.string().regex(/^[1-9]\d{0,18}$/),
});
export type TiebaDiscoveryImportKind = "traffic" | "potential" | "pending" | "oldTraffic" | "growthWatch";
export const tiebaDiscoveryPotentialPageSchema = z.object({
  page: z.number().int().min(1).max(2_147_483_647),
});
export const tiebaDiscoveryPotentialFilterSchema = tiebaDiscoveryPotentialPageSchema.extend({
  grew: z.boolean().optional(),
});
export const tiebaOldTrafficPageSchema = tiebaDiscoveryPotentialPageSchema.extend({
  view: z.enum(["screened", "qualified"]).default("qualified"),
  resource: z.enum(["all", "linked", "keywords", "pending", "none"]).default("all"),
});
export type TiebaOldTrafficView = z.output<typeof tiebaOldTrafficPageSchema>["view"];
export type TiebaOldResourceFilter = z.output<typeof tiebaOldTrafficPageSchema>["resource"];
export const tiebaTrafficPostsPageSchema = tiebaOldTrafficPageSchema.extend({
  view: z.enum(["all", "high", "screened", "qualified"]).default("all"),
  sort: z.enum(["archivedAt", "views", "lifetimeDailyViews", "dailyAddedViews"]).default("archivedAt"),
  direction: z.enum(["asc", "desc"]).default("desc"),
});
export type TiebaTrafficPostsView = z.output<typeof tiebaTrafficPostsPageSchema>["view"];
export type TiebaTrafficSort = z.output<typeof tiebaTrafficPostsPageSchema>["sort"];
export type TiebaTrafficSortDirection = z.output<typeof tiebaTrafficPostsPageSchema>["direction"];
export const tiebaFilterAuditPageSchema = tiebaDiscoveryPotentialPageSchema.extend({
  sort: z.enum(["sampledAt", "views", "publishedAt"]).default("sampledAt"),
  direction: z.enum(["asc", "desc"]).default("asc"),
});
export type TiebaFilterAuditSort = z.output<typeof tiebaFilterAuditPageSchema>["sort"];
export type TiebaTrafficPost = (
  | (TiebaDiscoveryTrafficPost & { kind: "high"; archivedAt: number })
  | (TiebaOldTrafficPost & { kind: "old"; archivedAt: number })
) & { resourceRecorded?: boolean };
export const tiebaOldResourceDeleteSchema = z.object({
  id: z.string().regex(/^[1-9]\d{0,18}$/),
});
export const tiebaTrafficResourceMarkSchema = tiebaOldResourceDeleteSchema.extend({ recorded: z.boolean() });

export interface TiebaHistoryProgress {
  forum?: string;
  page?: number;
  completed: number;
  total: number;
  revision: number;
}

export interface TiebaDiscoveryTask {
  kind: "survey" | "expand" | "history" | "resourceCheck" | "refresh";
  forum?: string;
  page?: number;
}

export interface TiebaDiscoveryPostPage<T> {
  page: number;
  total: number;
  items: T[];
}

export type TiebaDiscoveryPotentialPage =
  TiebaDiscoveryPostPage<TiebaDiscoveryPotentialPost>;
export type TiebaDiscoveryPendingPage =
  TiebaDiscoveryPostPage<TiebaDiscoveryPendingPost>;
export type TiebaDiscoveryTrafficPage =
  TiebaDiscoveryPostPage<TiebaDiscoveryTrafficPost>;

export const tiebaDiscoveryFilterAuditLimit = 100;

export type TiebaDiscoveryFilterSample = {
  number: string;
  sampledAt: number;
  post: Pick<TiebaDiscoveryReadingPost, "id" | "title" | "url" | "forum" | "views"> & {
    publishedAt: string;
  };
  reason:
    | { kind: "oldTraffic"; dailyViews: number; minViews: number; minDailyViews: number }
    | { kind: "oldResource" }
    | { kind: "recentDetailLink" }
    | { kind: "recentResource" };
};

export interface TiebaDiscoveryFilterAuditSummary {
  batch: number;
  startedAt: number;
  count: number;
}

export interface TiebaDiscoverySource {
  name: string;
  status: "seed" | "active" | "watch";
  scannedAt: number | null;
  addedAt?: number;
  lastAttemptAt?: number;
  exposure?: TiebaForumExposure | null;
  via?: {
    forum: string;
    reason: "posted" | "followed";
  };
}

export const tiebaDiscoveryCadenceMinutes = {
  expand: { min: 3, max: 7 },
  survey: { min: 50, max: 70 },
} as const;

export interface TiebaDiscoveryLog {
  id: number;
  at: number;
  message: string;
}

export interface TiebaDiscoverySnapshot {
  seeds: string[];
  busy: boolean;
  auto: boolean;
  nextAt: number | null;
  nextMode?: "survey" | "expand";
  queuedForums?: number;
  scanningForum?: string;
  rounds?: number;
  logs?: TiebaDiscoveryLog[];
  lastRun: {
    at: number;
    forums: number;
    authors: number;
    added: number;
    mode?: "survey" | "expand";
    warnings: string[];
  } | null;
  sources: TiebaDiscoverySource[];
  rules: TiebaDiscoveryRules;
  potentialCount: number;
  pendingCount?: number;
  trafficCount: number;
  oldTraffic?: { tracked: number; total: number };
  oldResourceReady?: boolean;
  oldResourceAdmission?: boolean;
  oldResourcePending?: number;
  historyProgress?: TiebaHistoryProgress;
  filterAudit?: TiebaDiscoveryFilterAuditSummary | null;
  filterAuditSortReady?: boolean;
  recycledCount?: number;
  trending: TiebaDiscoveryCandidate[];
  watching: TiebaDiscoveryCandidate[];
}

export interface TiebaResourceDiscoveryContract {
  "tieba.discovery.import": {
    args: z.input<typeof tiebaDiscoveryImportSchema>;
    value: { kind: TiebaDiscoveryImportKind; already: boolean; measuredDailyGrowth?: number };
  };
  "tieba.discovery.refresh": {
    args: z.input<typeof tiebaDiscoveryRefreshSchema>;
    value: { updated: number; failed: number };
  };
  "tieba.discovery.snapshot": {
    args: undefined;
    value: TiebaDiscoverySnapshot;
  };
  "tieba.discovery.seeds": {
    args: z.input<typeof tiebaResourceSeedsSchema>;
    value: TiebaDiscoverySnapshot;
  };
  "tieba.discovery.rules": {
    args: z.input<typeof tiebaDiscoveryRulesSchema>;
    value: TiebaDiscoverySnapshot;
  };
  "tieba.discovery.potential": {
    args: z.input<typeof tiebaDiscoveryPotentialFilterSchema>;
    value: TiebaDiscoveryPotentialPage;
  };
  "tieba.discovery.pending": {
    args: z.input<typeof tiebaDiscoveryPotentialPageSchema>;
    value: TiebaDiscoveryPendingPage;
  };
  "tieba.discovery.traffic": {
    args: z.input<typeof tiebaDiscoveryPotentialPageSchema>;
    value: TiebaDiscoveryTrafficPage;
  };
  "tieba.discovery.oldTraffic": {
    args: z.input<typeof tiebaOldTrafficPageSchema>;
    value: TiebaDiscoveryPostPage<TiebaOldTrafficPost>;
  };
  "tieba.discovery.trafficPosts": {
    args: z.input<typeof tiebaTrafficPostsPageSchema>;
    value: TiebaDiscoveryPostPage<TiebaTrafficPost>;
  };
  "tieba.discovery.setResourceRecorded": {
    args: z.input<typeof tiebaTrafficResourceMarkSchema>;
    value: void;
  };
  "tieba.discovery.filterAudit": {
    args: z.input<typeof tiebaFilterAuditPageSchema>;
    value: TiebaDiscoveryPostPage<TiebaDiscoveryFilterSample> & { batch: number | null };
  };
  "tieba.discovery.recycled": {
    args: z.input<typeof tiebaDiscoveryPotentialPageSchema>;
    value: TiebaDiscoveryPostPage<TiebaDiscoveryRecycledPost>;
  };
  "tieba.discovery.startFilterAudit": {
    args: undefined;
    value: TiebaDiscoverySnapshot;
  };
  "tieba.discovery.deleteOldResource": {
    args: z.input<typeof tiebaOldResourceDeleteSchema>;
    value: void;
  };
  "tieba.discovery.scan": { args: undefined; value: TiebaDiscoverySnapshot };
  "tieba.discovery.scanOldForum": { args: undefined; value: TiebaDiscoverySnapshot };
  "tieba.discovery.auto": {
    args: { enabled: boolean };
    value: TiebaDiscoverySnapshot;
  };
}

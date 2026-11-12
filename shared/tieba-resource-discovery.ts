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
  score?: number;
  rank: TiebaDiscoveryRank;
  viewRank: TiebaDiscoveryRank;
  comparedInteractions: boolean;
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
  paths: string[][];
  copies: number;
}

export interface TiebaDiscoveryReadingPost extends TiebaDiscoveryMetrics {
  id: string;
  title: string;
  url: string;
  forum: string;
  author: string;
  publishedAt: string;
  path: string[];
  checkedAt: number;
}

export interface TiebaDiscoveryPotentialPost extends TiebaDiscoveryReadingPost {
  first: TiebaDiscoveryPotentialEvidence;
  score?: number;
  confirmedAt: number | null;
  active: boolean;
}

export interface TiebaDiscoveryTrafficPost extends TiebaDiscoveryReadingPost {
  views: number;
  fromPotential: boolean;
}

export const tiebaDiscoveryRulesSchema = z.object({
  lookbackHours: z.number().int().min(1).max(720),
  potentialThreshold: z.number().int().min(0).max(100),
  trafficThreshold: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});

export type TiebaDiscoveryRules = z.infer<typeof tiebaDiscoveryRulesSchema>;

export const defaultTiebaDiscoveryRules: Readonly<TiebaDiscoveryRules> = {
  lookbackHours: 48,
  potentialThreshold: 75,
  trafficThreshold: 10_000,
};

export const tiebaDiscoveryPotentialPageSize = 8;
export const tiebaDiscoveryPotentialPageSchema = z.object({
  page: z.number().int().min(1).max(2_147_483_647),
});

export interface TiebaDiscoveryPostPage<T> {
  page: number;
  total: number;
  items: T[];
}

export type TiebaDiscoveryPotentialPage =
  TiebaDiscoveryPostPage<TiebaDiscoveryPotentialPost>;
export type TiebaDiscoveryTrafficPage =
  TiebaDiscoveryPostPage<TiebaDiscoveryTrafficPost>;

export interface TiebaDiscoverySource {
  name: string;
  path: string[];
  status: "seed" | "active" | "watch";
  scannedAt: number | null;
  lastAttemptAt?: number;
  exposure?: TiebaForumExposure | null;
  via?: {
    forum: string;
    author: string;
    uid: string;
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
  trafficCount: number;
  trending: TiebaDiscoveryCandidate[];
  watching: TiebaDiscoveryCandidate[];
}

export interface TiebaResourceDiscoveryContract {
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
    args: z.input<typeof tiebaDiscoveryPotentialPageSchema>;
    value: TiebaDiscoveryPotentialPage;
  };
  "tieba.discovery.traffic": {
    args: z.input<typeof tiebaDiscoveryPotentialPageSchema>;
    value: TiebaDiscoveryTrafficPage;
  };
  "tieba.discovery.scan": { args: undefined; value: TiebaDiscoverySnapshot };
  "tieba.discovery.auto": {
    args: { enabled: boolean };
    value: TiebaDiscoverySnapshot;
  };
}

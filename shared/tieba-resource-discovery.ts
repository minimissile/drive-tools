import { z } from "zod";
import { tiebaForumNameSchema } from "./tieba-forums";

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

export interface TiebaDiscoveryPotentialPost extends TiebaDiscoveryMetrics {
  id: string;
  title: string;
  url: string;
  forum: string;
  author: string;
  publishedAt: string;
  path: string[];
  checkedAt: number;
  first: TiebaDiscoveryPotentialEvidence;
  confirmedAt: number | null;
  active: boolean;
}

export const tiebaDiscoveryPotentialPageSize = 8;
export const tiebaDiscoveryPotentialPageSchema = z.object({
  page: z.number().int().min(1).max(2_147_483_647),
});

export interface TiebaDiscoveryPotentialPage {
  page: number;
  total: number;
  items: TiebaDiscoveryPotentialPost[];
}

export interface TiebaDiscoverySource {
  name: string;
  path: string[];
  status: "seed" | "active" | "watch";
  scannedAt: number | null;
}

export interface TiebaDiscoverySnapshot {
  seeds: string[];
  busy: boolean;
  auto: boolean;
  nextAt: number | null;
  lastRun: {
    at: number;
    forums: number;
    authors: number;
    added: number;
    warnings: string[];
  } | null;
  sources: TiebaDiscoverySource[];
  potentialCount: number;
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
  "tieba.discovery.potential": {
    args: z.input<typeof tiebaDiscoveryPotentialPageSchema>;
    value: TiebaDiscoveryPotentialPage;
  };
  "tieba.discovery.scan": { args: undefined; value: TiebaDiscoverySnapshot };
  "tieba.discovery.auto": {
    args: { enabled: boolean };
    value: TiebaDiscoverySnapshot;
  };
}

import { z } from "zod";
import { tiebaForumNameSchema } from "./tieba-forums";
import type { TiebaDiscoveryEvidence, TiebaOldResourceEvidence } from "./tieba-resource-discovery";

export const tiebaAnalysisInputSchema = z.object({
  target: z.string().trim().min(1).max(2048),
  page: z.number().int().min(1).max(2_147_483_647),
});

export const tiebaAnalysisFollowedInputSchema = z.object({
  uid: z
    .string()
    .regex(/^[1-9]\d{0,18}$/)
    .refine(
      (uid) => /^\d+$/.test(uid) && BigInt(uid) <= 9_223_372_036_854_775_807n,
    ),
  page: tiebaAnalysisInputSchema.shape.page,
});

export const tiebaAnalysisForumInputSchema = z.object({
  name: tiebaForumNameSchema,
  page: tiebaAnalysisInputSchema.shape.page,
  list: z.enum(["published", "replied"]).optional(),
});

export const tiebaForumCacheSorts = ["published", "replied", "views", "exposure"] as const;
export type TiebaForumCacheSort = (typeof tiebaForumCacheSorts)[number];
export const tiebaForumCachePageSize = 10;
export const tiebaForumCachePageSchema = z.object({
  name: tiebaForumNameSchema,
  page: tiebaAnalysisInputSchema.shape.page,
  sort: z.enum(tiebaForumCacheSorts),
});
export const tiebaForumCacheControlSchema = z.object({
  name: tiebaForumNameSchema,
  action: z.enum(["start", "pause", "restart"]),
});

export interface TiebaAnalysisForum {
  id: string;
  name: string;
  url: string;
  level: number | null;
  followers?: number | null;
  posts?: number | null;
}

export type TiebaAnalysisFollowedPage =
  | { visibility: "public"; forums: TiebaAnalysisForum[]; hasMore: boolean }
  | { visibility: "restricted" };

export interface TiebaAnalysisThread {
  id: string;
  title: string;
  forumId?: string | null;
  forum: string;
  url: string;
  publishedAt: string | null;
  repliedAt?: string | null;
  views: number | null;
  replies: number | null;
  likes: number | null;
  shares: number | null;
  authorId?: string | null;
  forumLevel?: number | null;
  resource?: TiebaDiscoveryEvidence;
  oldResource?: TiebaOldResourceEvidence;
}

export interface TiebaAnalysisForumPage {
  id: string;
  name: string;
  url: string;
  page: number;
  hasMore: boolean;
  totalPages?: number;
  followers?: number | null;
  posts?: number | null;
  threads: (TiebaAnalysisThread & { author: string })[];
  exposure?: TiebaForumExposure | null;
}

export interface TiebaForumCachePage {
  forum: Pick<TiebaAnalysisForumPage, "id" | "name" | "url"> | null;
  status: "idle" | "reading" | "paused" | "complete" | "error";
  error?: string;
  page: number;
  total: number;
  scannedPages: number;
  observedAt: number;
  threads: TiebaAnalysisForumPage["threads"];
}

export const tiebaForumExposureHours = 48;
export const tiebaForumExposureSampleLimit = 50;

export function tiebaPostExposure(
  views: number | null,
  publishedAt: string | null,
  observedAt: number,
) {
  const age = observedAt - Date.parse(publishedAt ?? "");
  if (views === null || !Number.isFinite(views) || views < 0 || !Number.isFinite(age) || age < 0)
    return null;
  return views / Math.max(age / 3_600_000, 0.5);
}

export interface TiebaForumExposure {
  hourly: number;
  sample: number;
  observedAt: number;
}

export interface TiebaAnalysisPage {
  uid: string;
  profileId: string | null;
  author: string;
  ageYears?: number | null;
  vip?: boolean | null;
  forums?: {
    id: string;
    name: string;
    level: number | null;
    exposure: TiebaForumExposure | null;
  }[];
  threads: TiebaAnalysisThread[];
}

export type TiebaAnalysisContract = {
  "tieba.analysis.query": {
    args: z.infer<typeof tiebaAnalysisInputSchema>;
    value: TiebaAnalysisPage;
  };
  "tieba.analysis.followedForums": {
    args: z.infer<typeof tiebaAnalysisFollowedInputSchema>;
    value: TiebaAnalysisFollowedPage;
  };
  "tieba.analysis.forumPosts": {
    args: z.input<typeof tiebaAnalysisForumInputSchema>;
    value: TiebaAnalysisForumPage;
  };
  "tieba.analysis.forumCache": {
    args: z.input<typeof tiebaForumCachePageSchema>;
    value: TiebaForumCachePage;
  };
  "tieba.analysis.forumCacheControl": {
    args: z.input<typeof tiebaForumCacheControlSchema>;
    value: void;
  };
};

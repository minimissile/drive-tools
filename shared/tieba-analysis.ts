import { z } from "zod";
import { tiebaForumNameSchema } from "./tieba-forums";

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
});

export interface TiebaAnalysisForum {
  id: string;
  name: string;
  url: string;
  level: number | null;
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
  views: number | null;
  replies: number | null;
  likes: number | null;
  shares: number | null;
}

export interface TiebaAnalysisForumPage {
  id: string;
  name: string;
  url: string;
  page: number;
  hasMore: boolean;
  threads: (TiebaAnalysisThread & { author: string })[];
}

export interface TiebaAnalysisPage {
  uid: string;
  profileId: string | null;
  author: string;
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
};

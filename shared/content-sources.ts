import { z } from "zod";
/** Original metrics remain attached to their source; they are not platform search counts. */
export interface ContentKeyword {
  id: string;
  word: string;
  source: string;
  observedAt: string | null;
  metrics: Record<string, unknown>;
}
export interface ContentResourceMatch {
  resourceId: string;
  copyId: string;
  title: string;
  accountAlias: string;
  summary: string;
  matchedTerms: string[];
}

export interface ContentImage {
  name: string;
  file: string;
  sha256: string;
  /** Missing on historical channel images; new shared images always specify it. */
  storage?: "content-assets" | "zhihu-assets";
}
export interface ContentProvenance {
  provider: "pipix";
  itemId: string;
  url: string;
  author: string;
  collectedAt: string;
  comments: { id: string; author: string }[];
  editorial?: {
    id: string;
    version: number;
    direction: string;
    accountId: string;
    contribution: string;
    purpose?: "warming" | "regular";
    angle?: string;
    checks?: string;
    planId?: string;
    aiAssisted: boolean;
    rights: { asset: string; basis: string; evidence: string }[];
  };
}
export type ContentChannel = "zhihu" | "weibo";
export interface ContentSourceExport {
  id: string;
  provider: "pipix";
  sourceId: string;
  channel: ContentChannel;
  accountId: string;
  accountLabel?: string;
  targetId: string;
  title: string;
  createdAt: string;
}
export interface SourceMaterial {
  title: string;
  body: string;
  images: ContentImage[];
  source: ContentProvenance;
}
export function sourceMaterialBody(
  text: string,
  author: string,
  comments: { author: string; text: string }[],
) {
  return [
    text,
    `图文来源：皮皮虾 · ${author}`,
    ...comments.map((c) => `网友评论（${c.author}）：\n${c.text}`),
  ]
    .filter(Boolean)
    .join("\n\n");
}
export const contentImageSchema = z.object({
  name: z.string().max(300),
  file: z.string().regex(/^[a-f0-9]{64}\.(png|jpg|gif)$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  storage: z.enum(["content-assets", "zhihu-assets"]),
});
export const contentProvenanceSchema = z.object({
  provider: z.literal("pipix"),
  itemId: z.string().regex(/^\d{8,30}$/),
  url: z.string().regex(/^https:\/\/h5\.pipix\.com\/ppx\/item\/\d{8,30}$/),
  author: z.string().max(100),
  collectedAt: z.iso.datetime(),
  comments: z
    .array(z.object({ id: z.string().max(100), author: z.string().max(100) }))
    .max(50),
  editorial: z.object({
    id: z.string().max(150), version: z.number().int().positive(),
    direction: z.string().max(1000), accountId: z.string().max(150),
    contribution: z.string().max(8000), aiAssisted: z.boolean(),
    purpose: z.enum(["warming", "regular"]).optional(),
    angle: z.string().max(2000).optional(), checks: z.string().max(8000).optional(), planId: z.string().max(150).optional(),
    rights: z.array(z.object({ asset: z.string().max(100), basis: z.string().max(50), evidence: z.string().max(2000) })).max(60),
  }).optional(),
});

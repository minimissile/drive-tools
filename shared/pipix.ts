import { z } from "zod";
import type { ContentImage, ContentSourceExport } from "./content-sources";

export interface PipixComment {
  id: string;
  text: string;
  author: string;
  likes: number | null;
  label: string;
}
export interface PipixImage {
  id: string;
  url: string;
  animated: boolean;
  asset?: ContentImage;
  error?: string;
}
export interface PipixItem {
  id: string;
  url: string;
  text: string;
  author: string;
  kind: "images" | "text" | "video";
  images: PipixImage[];
  comments: PipixComment[];
  commentCount: number | null;
  warnings: string[];
  collectedAt: string;
}
export interface PipixSource extends PipixItem {
  exports: ContentSourceExport[];
}
export const pipixCollectInput = z.object({
  text: z.string().trim().min(1).max(8000),
});
export const pipixExportInput = z.object({
  id: z.string().regex(/^\d{8,30}$/),
  title: z.string().trim().min(1).max(100),
  channel: z.enum(["zhihu", "weibo"]),
  accountId: z.string().max(100).optional(),
  imageIds: z.array(z.string().max(100)).max(9),
  commentIds: z.array(z.string().max(100)).max(50),
});
export type PipixExportInput = z.input<typeof pipixExportInput>;
export const pipixDiscoverInput = z
  .object({
    mode: z.enum(["search", "home", "user", "topic"]),
    keyword: z.string().trim().max(100).default(""),
    targetId: z
      .string()
      .regex(/^\d{1,30}$|^$/)
      .default(""),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_=.:-]{1,300}$/)
      .default("0"),
    page: z.number().int().min(0).max(1000000).default(0),
    force: z.boolean().default(false),
    probe: z
      .object({
        parameter: z.enum(["count", "page_size"]),
        value: z.number().int().min(1).max(10000),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === "search" && !v.keyword)
      ctx.addIssue({
        code: "custom",
        message: "请填写搜索关键词。",
        path: ["keyword"],
      });
    if ((v.mode === "user" || v.mode === "topic") && !v.targetId)
      ctx.addIssue({
        code: "custom",
        message: "请填写作者或话题的数字 ID。",
        path: ["targetId"],
      });
  });
export type PipixDiscoverInput = z.input<typeof pipixDiscoverInput>;
export interface PipixCandidate {
  id: string;
  url: string;
  text: string;
  author: string;
  kind: PipixItem["kind"] | "unknown";
}
export interface PipixDiscoveryPage {
  items: PipixCandidate[];
  nextCursor: string | null;
  warnings: string[];
  cached?: boolean;
  responseId?: string;
  fetchedAt?: string;
}
export const pipixKnowledgeInput = z.object({
  mode: z.enum(["local", "search", "home", "user", "topic"]).default("local"),
  keyword: z.string().trim().max(100).default(""),
  targetId: z.string().max(30).default(""),
  page: z.number().int().min(1).max(1000000).default(1),
  onlyImages: z.boolean().default(true),
});
export interface PipixKnowledgePage {
  items: PipixCandidate[];
  total: number;
  page: number;
  pageSize: number;
  responses: number;
  allPosts: number;
  unparsed: number;
  latestAt: string | null;
  next: { cursor: string; page: number; retry?: boolean } | null;
  hasQuery: boolean;
  warnings: string[];
}
export interface PipixCapacityReport {
  keyword: string;
  checkedAt: string;
  maxObserved: number;
  results: {
    parameter: string;
    requested: number;
    returned: number | null;
    reflected: boolean;
    cached: boolean;
    error?: string;
  }[];
}
export const pipixDiscoveryKeyInput = z.object({
  value: z
    .string()
    .trim()
    .max(20000)
    .transform((value) =>
      value.replace(/^(?:Authorization\s*:\s*)?Bearer\s+/i, "").trim(),
    )
    .refine(
      (value) => !/[\s\x00-\x1f\x7f]/.test(value),
      "Key 中含有空格或换行，请复制完整的一行令牌。",
    ),
});
type Contract<A, V> = { args: A; value: V };
export interface PipixContract {
  "pipix.knowledge": Contract<
    z.input<typeof pipixKnowledgeInput>,
    PipixKnowledgePage
  >;
  "pipix.reindex": Contract<undefined, { indexed: number; failed: number }>;
  "pipix.discoveryConfig": Contract<
    undefined,
    { configured: boolean; capacity?: PipixCapacityReport | null }
  >;
  "pipix.probeCapacity": Contract<{ keyword: string }, PipixCapacityReport>;
  "pipix.saveDiscoveryKey": Contract<
    z.input<typeof pipixDiscoveryKeyInput>,
    { configured: boolean }
  >;
  "pipix.discover": Contract<PipixDiscoverInput, PipixDiscoveryPage>;
  "pipix.list": Contract<undefined, PipixSource[]>;
  "pipix.collect": Contract<z.input<typeof pipixCollectInput>, PipixSource>;
  "pipix.export": Contract<
    PipixExportInput,
    { delivery: ContentSourceExport; existing: boolean }
  >;
  "pipix.image": Contract<{ id: string; imageId: string }, string>;
}

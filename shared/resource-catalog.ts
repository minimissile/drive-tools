import { z } from "zod";
import type { RemoteCatalogLanding } from "./catalog-landing";

export const catalogProviderSchema = z.enum([
  "feishu",
  "tencent-docs",
  "shimo",
]);
export type CatalogProvider = z.infer<typeof catalogProviderSchema>;
export const catalogIdSchema = z.string().regex(/^catalog_[\w-]{1,100}$/);
export const catalogEntrySchema = z.object({
  resourceId: z.string().min(1).max(128),
  title: z.string().trim().min(1).max(300).optional(),
  category: z.string().trim().max(60).optional(),
  summary: z.string().trim().max(12000).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
export const catalogSaveSchema = z.object({
  id: catalogIdSchema.optional(),
  expectedRevision: z.number().int().positive().optional(),
  title: z.string().trim().min(1, "请填写清单标题").max(120),
  category: z.string().trim().min(1, "请选择资源分类").max(60),
  introduction: z.string().trim().max(4000).default(""),
  includeSummary: z.boolean().default(true),
  includeTags: z.boolean().default(true),
  sort: z.enum(["title", "updated", "manual"]).default("title"),
  selectionMode: z.enum(["category", "manual"]).optional(),
  entries: z.array(catalogEntrySchema).max(2000).optional(),
  excludedResourceIds: z
    .array(z.string().min(1).max(128))
    .max(100000)
    .optional(),
});
export const catalogRemoveItemsSchema = z.object({
  id: catalogIdSchema,
  expectedRevision: z.number().int().positive(),
  resourceIds: z.array(z.string().min(1).max(128)).min(1).max(2000),
});
export type CatalogSaveInput = z.infer<typeof catalogSaveSchema>;
export interface ResourceCatalog extends Omit<
  CatalogSaveInput,
  "id" | "expectedRevision"
> {
  id: string;
  revision: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface CatalogItem {
  resourceId: string;
  title: string;
  category: string;
  summary: string;
  tags: string[];
  links: { provider: string; url: string; code: string }[];
}
export interface CatalogExcluded {
  resourceId: string;
  title: string;
  reason: string;
}
export interface CatalogSnapshot {
  id: string;
  hash: string;
  title: string;
  category: string;
  introduction: string;
  createdAt: string;
  items: CatalogItem[];
  excluded: CatalogExcluded[];
}
export interface CatalogDiff {
  added: CatalogItem[];
  changed: CatalogItem[];
  removed: CatalogItem[];
  metadataChanged: boolean;
}
export interface CatalogPreparation {
  id: string;
  catalogId: string;
  provider: CatalogProvider;
  accountId: string;
  accountAlias: string;
  publicationId: string | null;
  snapshotId: string;
  hash: string;
  version: number;
  createdAt: string;
  confirmedAt: string | null;
}
export interface CatalogPublication {
  id: string;
  provider: CatalogProvider;
  accountId: string;
  accountAlias: string;
  url: string;
  snapshotId: string;
  hash: string;
  version: number;
  confirmedAt: string;
  preparationId: string;
  needsUpdate: boolean;
  diff: CatalogDiff;
}
export interface CatalogReceipt extends Omit<
  CatalogPublication,
  "needsUpdate" | "diff"
> {}
export interface CatalogSummary extends ResourceCatalog {
  resourceCount: number;
  excludedCount: number;
  publicationCount: number;
  pendingCount: number;
}
export interface CatalogDetail {
  catalog: ResourceCatalog;
  current: CatalogSnapshot;
  publications: CatalogPublication[];
  preparations: CatalogPreparation[];
  history: CatalogReceipt[];
  site: CatalogSiteState;
}
export interface CatalogSiteState {
  baseUrl: string;
  publication: RemoteCatalogLanding | null;
  needsUpdate: boolean;
  diff: CatalogDiff | null;
  pending: "publish" | "withdraw" | null;
  error: string | null;
  checkedAt: string | null;
}
export const catalogSitePublishSchema = z.object({
  id: catalogIdSchema,
  expectedRevision: z.number().int().positive(),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
  publicConfirmed: z.literal(true),
});
export const catalogSiteWithdrawSchema = z.object({
  id: catalogIdSchema,
  expectedVersion: z.number().int().positive(),
  confirmed: z.literal(true),
});
export const catalogPrepareSchema = z.object({
  id: catalogIdSchema,
  expectedRevision: z.number().int().positive(),
  provider: catalogProviderSchema,
  accountId: z.string().regex(/^web_[\w-]{1,80}$/),
  publicationId: z.string().max(120).optional(),
});
export const catalogConfirmSchema = z.object({
  id: catalogIdSchema,
  preparationId: z.string().min(1).max(120),
  url: z.string().trim().url().max(2000),
  publicConfirmed: z.literal(true),
});
type Contract<A, V> = { args: A; value: V };
export const catalogResourcesSchema = z.object({
  query: z.string().trim().max(200).default(""),
  category: z.string().max(60).default("all"),
  page: z.number().int().min(1).max(100000).default(1),
});
export interface CatalogResourceOption {
  resourceId: string;
  title: string;
  category: string;
  summary: string;
  tags: string[];
}
export const catalogAiStartSchema = z.object({
  requestId: z.string().uuid(),
  prompt: z.string().trim().min(2, "请描述需要哪些资源").max(2000),
  category: z.string().trim().min(1).max(60).default("all"),
  maxItems: z.number().int().min(1).max(2000).default(50),
});
export interface CatalogAiJob {
  id: string;
  prompt: string;
  category: string;
  maxItems: number;
  model: string;
  total: number;
  scanned: number;
  matched: number;
  stage: "matching" | "writing" | "completed";
  busy: boolean;
  uncertain: boolean;
  error: string | null;
  draft: CatalogSaveInput | null;
  createdAt: string;
  updatedAt: string;
}
export interface ResourceCatalogContract {
  "resourceCatalog.resourceDetails": Contract<
    { ids: string[] },
    CatalogResourceOption[]
  >;
  "resourceCatalog.resources": Contract<
    z.infer<typeof catalogResourcesSchema>,
    { items: CatalogResourceOption[]; total: number }
  >;
  "resourceCatalog.aiStart": Contract<
    z.infer<typeof catalogAiStartSchema>,
    CatalogAiJob
  >;
  "resourceCatalog.aiGet": Contract<{ id: string }, CatalogAiJob>;
  "resourceCatalog.aiStep": Contract<
    { id: string; retryUncertain?: true },
    CatalogAiJob
  >;
  "resourceCatalog.list": Contract<undefined, CatalogSummary[]>;
  "resourceCatalog.get": Contract<{ id: string }, CatalogDetail>;
  "resourceCatalog.save": Contract<CatalogSaveInput, CatalogDetail>;
  "resourceCatalog.saveManual": Contract<CatalogSaveInput, CatalogDetail>;
  "resourceCatalog.removeItems": Contract<
    z.infer<typeof catalogRemoveItemsSchema>,
    CatalogDetail
  >;
  "resourceCatalog.archive": Contract<
    { id: string; expectedRevision: number; archived: boolean },
    CatalogDetail
  >;
  "resourceCatalog.remove": Contract<
    { id: string; expectedRevision: number; confirmed: true },
    boolean
  >;
  "resourceCatalog.prepare": Contract<
    z.infer<typeof catalogPrepareSchema>,
    { preparation: CatalogPreparation; snapshot: CatalogSnapshot }
  >;
  "resourceCatalog.copy": Contract<
    { id: string; preparationId: string },
    { copied: true; format: "rich" | "text" }
  >;
  "resourceCatalog.open": Contract<
    { id: string; preparationId: string },
    { opened: boolean; url: string }
  >;
  "resourceCatalog.confirm": Contract<
    z.infer<typeof catalogConfirmSchema>,
    CatalogDetail
  >;
  "resourceCatalog.export": Contract<
    { id: string; preparationId?: string; format: "xlsx" | "md" },
    string | null
  >;
  "resourceCatalog.sitePublish": Contract<
    z.infer<typeof catalogSitePublishSchema>,
    CatalogSiteState
  >;
  "resourceCatalog.siteWithdraw": Contract<
    z.infer<typeof catalogSiteWithdrawSchema>,
    CatalogSiteState
  >;
  "resourceCatalog.siteRefresh": Contract<{ id: string }, CatalogSiteState>;
  "resourceCatalog.siteRetry": Contract<{ id: string }, CatalogSiteState>;
}

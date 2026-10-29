import { z } from "zod";

export const catalogProviderSchema = z.enum([
  "feishu",
  "tencent-docs",
  "shimo",
]);
export type CatalogProvider = z.infer<typeof catalogProviderSchema>;
export const catalogIdSchema = z.string().regex(/^catalog_[\w-]{1,100}$/);
export const catalogSaveSchema = z.object({
  id: catalogIdSchema.optional(),
  expectedRevision: z.number().int().positive().optional(),
  title: z.string().trim().min(1, "请填写清单标题").max(120),
  category: z.string().trim().min(1, "请选择资源分类").max(60),
  introduction: z.string().trim().max(4000).default(""),
  includeSummary: z.boolean().default(true),
  includeTags: z.boolean().default(true),
  sort: z.enum(["title", "updated"]).default("title"),
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
}
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
export interface ResourceCatalogContract {
  "resourceCatalog.list": Contract<undefined, CatalogSummary[]>;
  "resourceCatalog.get": Contract<{ id: string }, CatalogDetail>;
  "resourceCatalog.save": Contract<CatalogSaveInput, CatalogDetail>;
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
}

import { z } from "zod";
import { exportFields } from "./resource-export-fields";
export { exportFields } from "./resource-export-fields";
export const exportField = z.enum(
  Object.keys(exportFields) as [
    keyof typeof exportFields,
    ...(keyof typeof exportFields)[],
  ],
);
export const exportColumn = z.object({
  label: z.string().trim().min(1).max(60),
  field: exportField,
});
export const exportColumns = z.array(exportColumn).min(1).max(24);
export const exportPlan = z.object({
  title: z.string().min(1).max(120),
  criteria: z.string().min(1).max(6000),
  columns: exportColumns,
  articleBrief: z.string().max(6000),
  warnings: z.array(z.string().max(300)).max(10),
});
export const exportInput = z
  .object({
    request: z.string().trim().max(6000).default(""),
    images: z.array(z.string().max(5_600_000)).max(3).default([]),
    scope: z.enum(["database", "notes", "combined"]).default("combined"),
    category: z.string().max(60).default("all"),
    provider: z
      .enum(["all", "quark", "baidu", "uc", "xunlei", "guangya", "pikpak"])
      .default("all"),
    accountId: z.string().max(100).default("all"),
    archivedOnly: z.boolean().default(false),
  })
  .refine((v) => v.request.length > 0 || v.images.length > 0, {
    message: "请填写导出需求或添加参考图片。",
  });
export const exportClassification = z.object({
  decisions: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        match: z.boolean(),
        reason: z.string().min(1).max(300),
      }),
    )
    .max(30),
});
export const exportArticle = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(12000),
  resourceIds: z.array(z.string().max(100)).min(1).max(100),
});
export type ExportInput = z.infer<typeof exportInput>;
export type ExportPlan = z.infer<typeof exportPlan>;
export type ExportColumn = z.infer<typeof exportColumn>;
export type ExportArticle = z.infer<typeof exportArticle>;
export type ExportRecord = Record<keyof typeof exportFields, string> & {
  id: string;
};
export interface ExportRun {
  id: string;
  createdAt: string;
  updatedAt: string;
  input: Omit<ExportInput, "images"> & { imageCount: number };
  plan: ExportPlan;
  state: "planned" | "running" | "paused" | "completed" | "failed";
  total: number;
  scanned: number;
  records: ExportRecord[];
  excluded: ExportRecord[];
  warnings: string[];
  error: string | null;
  article: ExportArticle | null;
  articleError?: string | null;
  articleSelection: string[];
}
export const exportSelection = z.object({
  runId: z.string().max(100),
  ids: z.array(z.string().max(100)).min(1).max(100000),
});

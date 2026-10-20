import { z } from "zod";
import { platformIds, contentFormatIds, linkPositionIds } from "./channels";
import { providerIds } from "./providers";
export const providerSchema = z.enum(providerIds);
export const platformSchema = z.enum(platformIds);
export const contentFormatSchema = z.enum(contentFormatIds);
export const linkPositionSchema = z.enum(linkPositionIds);
export const endpointSchema = z.enum([
  "longtail",
  "suggest",
  "metrics",
  "radar",
]);
export const fileSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  isDirectory: z.boolean(),
  size: z.number().finite().nonnegative().nullable(),
  parentId: z.string().max(1000),
  path: z.string().max(2000).optional(),
});
export const resourceInputSchema = z.object({
  id: z.string().optional(),
  copyId: z.string().optional(),
  title: z.string().trim().min(1).max(200),
  sourceText: z.string().min(1).max(8000),
  extractionCode: z.string().max(30).optional(),
  category: z.string().trim().min(1).max(60),
  tags: z.array(z.string().trim().min(1).max(60)).max(30),
  summary: z.string().max(30_000),
  coverData: z.string().max(12_000_000).nullable().optional(),
  accountId: z.string().min(1),
  directory: z.string().max(500),
  rightsConfirmed: z.boolean().optional(),
  selectedFiles: z.array(fileSchema).max(100).optional(),
  enqueue: z.boolean(),
});
export const querySchema = z.object({
  endpoint: endpointSchema,
  seeds: z.array(z.string().max(100)).max(50),
  pages: z.number().int().min(1).max(5),
  platform: z.string().max(30).optional(),
  type: z.string().max(100).optional(),
  startTime: z.string().max(30).optional(),
  endTime: z.string().max(30).optional(),
  useCache: z.boolean(),
  taskId: z.string().max(100).optional(),
});
export const keywordSchema = z.object({
  id: z.string().max(100),
  word: z.string().min(1).max(200),
  source: z.string().max(100),
  platform: z.string().max(50).nullable(),
  metrics: z.record(
    z.string(),
    z.union([z.string(), z.number().finite(), z.null()]),
  ),
  sourceUpdatedAt: z.string().nullable(),
  fetchedAt: z.string(),
  intent: z.string().max(100).optional(),
  idea: z
    .object({
      runId: z.string().max(100),
      kind: z.string().max(30),
      cluster: z.string().max(40),
      angle: z.string().max(200),
      answerQuestion: z.string().max(180),
      evidenceNeeded: z.string().max(200),
      references: z.array(z.string().max(100)).max(3),
    })
    .optional(),
});

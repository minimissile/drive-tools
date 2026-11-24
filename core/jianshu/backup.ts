import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  contentImageSchema,
  type ContentImage,
} from "../../shared/content-sources";
import {
  jianshuDraftUrl,
  jianshuFillCheckpointSchema,
  jianshuIdSchema,
  jianshuTemplateSchema,
} from "../../shared/jianshu";
import { jianshuSourceSchema } from "./service";
import { AppError } from "../errors";

const image = contentImageSchema.refine((value) =>
  value.file.startsWith(value.sha256 + "."),
);
const images = z.array(image).max(20);
const text = z.string().max(100000);
const version = z.object({
  revision: z.number().int().positive(),
  title: z.string().max(200),
  body: text,
  images,
  instruction: z.string().max(4000),
  origin: z.enum(["created", "manual", "ai"]),
  createdAt: z.string().max(100),
  copyId: z.string().max(150).nullable().optional(),
  sourceIds: z.array(z.string().max(150)).max(20).optional(),
  template: jianshuTemplateSchema.optional(),
});
const delivery = z.object({
  text: z.string().max(200000),
  html: z.string().max(2000000),
  resourceUrl: z.string().max(4000).nullable(),
  sourceUrls: z.array(z.string().max(4000)).max(20),
});
const article = z.object({
  id: jianshuIdSchema,
  title: z.string().max(200),
  body: text,
  template: jianshuTemplateSchema,
  copyId: z.string().max(150).nullable(),
  sourceIds: z.array(z.string().max(150)).max(20),
  images,
  accountId: z.string().max(150).nullable(),
  revision: z.number().int().positive(),
  versions: z.array(version),
  aiAssisted: z.boolean(),
  stage: z.enum(["editing", "preparing", "prepared", "uncertain", "published"]),
  message: z.string().max(2000),
  editorUrl: z.string().max(4000).nullable(),
  receiptUrl: z.string().max(4000).nullable(),
  preparedRevision: z.number().int().positive().nullable(),
  preparedUid: z.string().max(150).nullable(),
  preparedEnvironment: z.string().max(4000).nullable(),
  preparedText: z.string().max(200000).nullable(),
  preparedDelivery: delivery.nullable().optional(),
  preparedFill: jianshuFillCheckpointSchema.nullable().optional(),
  createdAt: z.string().max(100),
  updatedAt: z.string().max(100),
  preparedShareCodeHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  imageReviewRequired: z.boolean().optional(),
  imageReviewedAt: z.string().max(100).nullable().optional(),
});
const creation = z.object({
  id: jianshuIdSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
const generation = z.object({
  articleId: jianshuIdSchema,
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["running", "completed", "failed", "interrupted"]),
  message: z.string().max(2000).optional(),
});
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const createPattern = new RegExp(`^jianshu:create:v1:${uuid}$`);
const generationPattern = new RegExp(`^jianshu:generation:v1:${uuid}$`);

/** Restore only recognized content, never unknown settings or old runtime authorization. */
export function readJianshuBackupSettings(db: DatabaseSync, restore = false) {
  const settings: { key: string; value: unknown }[] = [];
  const required: ContentImage[] = [];
  const articleIds = new Set<string>(),
    sourceIds = new Set<string>(),
    articleSources: string[] = [];
  const requestArticles: string[] = [];
  const indices: {
    article?: string[];
    source?: string[];
    generation?: string[];
  } = {};
  const generationIds = new Set<string>();
  for (const row of db
    .prepare("SELECT key,value FROM settings WHERE key LIKE 'jianshu:%'")
    .all()) {
    const key = String(row.key);
    if (!(
      key === "jianshu:articles:v1" ||
      key === "jianshu:sources:v1" ||
      key === "jianshu:generations:v1" ||
      key.startsWith("jianshu:article:v1:") ||
      key.startsWith("jianshu:source:v1:") ||
      createPattern.test(key) ||
      generationPattern.test(key)
    ))
      continue;
    try {
      let value: unknown = JSON.parse(String(row.value));
      if (key === "jianshu:articles:v1")
        indices.article = value = z.array(jianshuIdSchema).parse(value);
      else if (key === "jianshu:sources:v1")
        indices.source = value = z
          .array(z.string().regex(/^[\w-]{1,150}$/))
          .parse(value);
      else if (key === "jianshu:generations:v1")
        indices.generation = value = z.array(z.uuid()).parse(value);
      else if (key.startsWith("jianshu:article:v1:")) {
        const parsed = article.parse(value);
        if (parsed.id !== key.slice("jianshu:article:v1:".length))
          throw Error("Article key mismatch");
        if (
          parsed.preparedFill &&
          jianshuDraftUrl(parsed.editorUrl) !==
            jianshuDraftUrl(parsed.preparedFill.editorUrl)
        )
          throw Error("Draft checkpoint mismatch");
        articleIds.add(parsed.id);
        articleSources.push(
          ...parsed.sourceIds,
          ...parsed.versions.flatMap((version) => version.sourceIds ?? []),
        );
        required.push(
          ...parsed.images,
          ...parsed.versions.flatMap((version) => version.images),
        );
        if (restore) {
          if (["preparing", "prepared", "uncertain"].includes(parsed.stage)) {
            parsed.stage = "uncertain";
            parsed.message = "从备份恢复，请核对原简书发布结果，不会自动重发。";
          }
          const draftUrl = jianshuDraftUrl(parsed.editorUrl);
          parsed.editorUrl = draftUrl;
          if (!draftUrl) {
            parsed.preparedUid = null;
            parsed.preparedFill = null;
          }
          parsed.preparedEnvironment = null;
        }
        value = parsed;
      } else if (key.startsWith("jianshu:source:v1:")) {
        const parsed = jianshuSourceSchema.parse(value);
        if (parsed.id !== key.slice("jianshu:source:v1:".length))
          throw Error("Source key mismatch");
        sourceIds.add(parsed.id);
        value = parsed;
      } else if (createPattern.test(key)) {
        value = creation.parse(value);
        requestArticles.push((value as z.infer<typeof creation>).id);
      } else {
        const parsed = generation.parse(value);
        requestArticles.push(parsed.articleId);
        generationIds.add(key.slice("jianshu:generation:v1:".length));
        if (restore && parsed.status === "running") {
          parsed.status = "interrupted";
          parsed.message =
            "从备份恢复，上次生成已中断；旧稿保留，不自动再次调用模型。";
        }
        value = parsed;
      }
      settings.push({ key, value });
    } catch {
      throw new AppError(
        "INVALID_BACKUP",
        "备份中的简书文章、来源或配图记录不完整。",
      );
    }
  }
  if (
    (indices.article ?? []).some((id) => !articleIds.has(id)) ||
    [...articleIds].some((id) => !indices.article?.includes(id)) ||
    (indices.source ?? []).some((id) => !sourceIds.has(id)) ||
    articleSources.some((id) => !sourceIds.has(id)) ||
    requestArticles.some((id) => !articleIds.has(id)) ||
    (indices.generation ?? []).some((id) => !generationIds.has(id))
  )
    throw new AppError("INVALID_BACKUP", "备份中的简书文章或来源引用不完整。");
  return { settings, required };
}

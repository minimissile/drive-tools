import { z } from "zod";
import {
  landingQuality,
  publishedLandingSchema,
  type LandingWrite,
  type RemoteLanding,
} from "../../../shared/resource-landing";
import { HttpError, type Env } from "./types";
import { findById } from "./store";

export const landingWriteSchema = z
  .object({
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().min(0).max(2147483646),
    expectedLinkRevision: z.number().int().min(1).max(2147483646),
    document: publishedLandingSchema.nullable(),
  })
  .strict();
export interface PageRow {
  link_id: string;
  document_json: string | null;
  version: number;
  last_operation_id: string;
  published_at: string | null;
  updated_at: string;
}
export function remotePage(row: PageRow): RemoteLanding {
  return {
    linkId: row.link_id,
    version: row.version,
    document: row.document_json
      ? publishedLandingSchema.parse(JSON.parse(row.document_json))
      : null,
    lastOperationId: row.last_operation_id,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}
export async function findPage(
  env: Env,
  id: string,
): Promise<RemoteLanding | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM resource_pages WHERE link_id=?1",
  )
    .bind(id)
    .first<PageRow>();
  return row ? remotePage(row) : null;
}
export interface ListedPage extends PageRow {
  slug: string;
  provider: string;
  title: string;
  category: string;
}
const visible = `FROM resource_pages p JOIN resource_links l ON p.link_id=l.id
 WHERE p.document_json IS NOT NULL AND l.enabled=1 AND l.target_url IS NOT NULL
 AND p.resource_title=l.title AND p.quality_score>=82
 AND json_array_length(p.document_json,'$.source.documents')>0
 AND json_type(p.document_json,'$.review.dimensions')='object' `;
export async function publicPages(
  env: Env,
  options: {
    limit?: number;
    offset?: number;
    query?: string;
    category?: string;
  } = {},
): Promise<ListedPage[]> {
  const query = (options.query ?? "").replace(/[\\%_]/g, "\\$&").slice(0, 100);
  const category = options.category ?? "";
  const result = await env.DB.prepare(
    `SELECT p.*,l.slug,l.provider,l.title ${visible}
    AND (?1='' OR p.resource_title LIKE ?2 ESCAPE '\\' OR json_extract(p.document_json,'$.article.title') LIKE ?2 ESCAPE '\\')
    AND (?3='' OR p.category=?3) ORDER BY p.updated_at DESC,p.link_id LIMIT ?4 OFFSET ?5`,
  )
    .bind(
      query,
      `%${query}%`,
      category,
      options.limit ?? 20,
      options.offset ?? 0,
    )
    .all<ListedPage>();
  return result.results;
}
export async function publicPageCount(env: Env): Promise<number> {
  return (
    (
      await env.DB.prepare(`SELECT count(*) AS n ${visible}`).first<{
        n: number;
      }>()
    )?.n ?? 0
  );
}
export async function publicCategories(env: Env): Promise<string[]> {
  return (
    await env.DB.prepare(
      `SELECT DISTINCT p.category ${visible} ORDER BY p.category`,
    ).all<{ category: string }>()
  ).results.map((r) => r.category);
}
export async function putPage(
  env: Env,
  id: string,
  raw: unknown,
): Promise<RemoteLanding> {
  const parsed = landingWriteSchema.safeParse(raw);
  if (!parsed.success)
    throw new HttpError(400, "INVALID_PAGE", "落地页结构不完整或超出限制。");
  const input: LandingWrite = parsed.data;
  const requestJson = JSON.stringify({ id, ...input });
  const previous = await env.DB.prepare(
    "SELECT * FROM resource_page_operations WHERE operation_id=?1",
  )
    .bind(input.operationId)
    .first<PageRow & { request_json: string }>();
  if (previous) {
    if (previous.request_json !== requestJson)
      throw new HttpError(
        409,
        "OPERATION_CONFLICT",
        "此操作编号已用于其他内容。",
      );
    return remotePage(previous);
  }
  const row = await findById(env, id);
  if (!row) throw new HttpError(404, "NOT_FOUND", "固定入口不存在。");
  const doc = input.document;
  if (
    doc &&
    (doc.source.resourceTitle !== row.title ||
      !landingQuality(doc.article, doc.source, doc.review).eligible)
  )
    throw new HttpError(
      400,
      "PAGE_QUALITY_REQUIRED",
      "落地页未通过内容质量检查或与资源不符。",
    );
  const prose = doc
    ? JSON.stringify([
        doc.article.sections.map((s) => s.body),
        doc.article.faq.map((f) => f.answer),
      ])
    : "";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(prose.replace(/\s/g, "")),
  );
  const bodyHash = [...new Uint8Array(digest)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  const timestamp = new Date().toISOString();
  let failed = false;
  try {
    const result = await env.DB.prepare(
      `INSERT INTO resource_pages(link_id,document_json,resource_title,category,body_hash,quality_score,version,last_operation_id,published_at,updated_at,request_json)
      SELECT ?1,?2,?3,?4,?5,?6,1,?7,CASE WHEN ?2 IS NULL THEN NULL ELSE ?8 END,?8,?9
      WHERE EXISTS(SELECT 1 FROM resource_links WHERE id=?1 AND revision=?11 AND (?2 IS NULL OR (enabled=1 AND target_url IS NOT NULL)))
      AND (?10=0 OR EXISTS(SELECT 1 FROM resource_pages WHERE link_id=?1))
      AND NOT EXISTS(SELECT 1 FROM resource_page_operations WHERE operation_id=?7)
      ON CONFLICT(link_id) DO UPDATE SET document_json=excluded.document_json,resource_title=excluded.resource_title,
      category=excluded.category,body_hash=excluded.body_hash,quality_score=excluded.quality_score,version=resource_pages.version+1,
      last_operation_id=excluded.last_operation_id,published_at=CASE WHEN excluded.document_json IS NULL THEN resource_pages.published_at ELSE COALESCE(resource_pages.published_at,excluded.published_at) END,
      updated_at=excluded.updated_at,request_json=excluded.request_json WHERE resource_pages.version=?10`,
    )
      .bind(
        id,
        doc ? JSON.stringify(doc) : null,
        doc?.source.resourceTitle ?? row.title,
        doc?.source.category ?? "",
        bodyHash,
        doc ? landingQuality(doc.article, doc.source, doc.review).score : 0,
        input.operationId,
        timestamp,
        requestJson,
        input.expectedVersion,
        input.expectedLinkRevision,
      )
      .run();
    failed = !result.success;
  } catch {
    failed = true;
  }
  let receipt: (PageRow & { request_json: string }) | null;
  try {
    receipt = await env.DB.prepare(
      "SELECT * FROM resource_page_operations WHERE operation_id=?1",
    )
      .bind(input.operationId)
      .first<PageRow & { request_json: string }>();
  } catch {
    throw new HttpError(
      503,
      "OPERATION_UNCONFIRMED",
      "发布结果待核对，请使用同一次操作重试。",
    );
  }
  if (receipt) {
    if (receipt.request_json !== requestJson)
      throw new HttpError(
        409,
        "OPERATION_CONFLICT",
        "此操作编号已用于其他内容。",
      );
    return remotePage(receipt);
  }
  if (doc) {
    const duplicate = await env.DB.prepare(
      "SELECT link_id FROM resource_pages WHERE body_hash=?1 AND document_json IS NOT NULL AND link_id<>?2",
    )
      .bind(bodyHash, id)
      .first();
    if (duplicate)
      throw new HttpError(
        409,
        "DUPLICATE_PAGE",
        "已有相同正文的落地页，未重复发布。",
      );
  }
  if (failed)
    throw new HttpError(
      503,
      "OPERATION_UNCONFIRMED",
      "暂时无法确认发布结果，请保留原操作重试。",
    );
  throw new HttpError(
    409,
    "PAGE_VERSION_CONFLICT",
    "资源或落地页版本已变化，请读取云端状态后再发布。",
  );
}

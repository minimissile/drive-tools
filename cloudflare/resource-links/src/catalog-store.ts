import {
  catalogLandingSnapshotSchema,
  catalogLandingWriteSchema,
  catalogLandingWithdrawSchema,
  type CatalogLandingSnapshot,
  type RemoteCatalogLanding,
} from "../../../shared/catalog-landing";
import { HttpError, type Env, type Provider } from "./types";
import { shareTarget } from "./validation";

export interface CatalogRow {
  id: string;
  slug: string;
  active: number;
  version: number;
  source_revision: number;
  snapshot_json: string;
  title: string;
  item_count: number;
  last_operation_id: string;
  request_hash: string;
  published_at: string;
  updated_at: string;
}
const publicColumns = "id,slug,title,item_count,updated_at";
export type CatalogListing = Pick<
  CatalogRow,
  "id" | "slug" | "title" | "item_count" | "updated_at"
>;
const hosts: Readonly<Record<string, Provider>> = {
  "pan.quark.cn": "quark",
  "pan.baidu.com": "baidu",
  "yun.baidu.com": "baidu",
  "drive.uc.cn": "uc",
  "pan.uc.cn": "uc",
  "fast.uc.cn": "uc",
  "pan.xunlei.com": "xunlei",
  "guangyapan.com": "guangya",
  "www.guangyapan.com": "guangya",
  "mypikpak.com": "pikpak",
};
export function catalogShare(
  link: CatalogLandingSnapshot["items"][number]["links"][number],
  origin: string,
) {
  let host: string;
  try {
    host = new URL(link.url).hostname;
  } catch {
    throw new HttpError(400, "INVALID_SHARE", "清单中的网盘地址不正确。");
  }
  const provider = hosts[host];
  if (!provider)
    throw new HttpError(
      400,
      "INVALID_SHARE",
      "清单仅支持已接入网盘的官方分享地址。",
    );
  const url = shareTarget(link.url, provider, link.code, origin);
  if (link.code)
    url.searchParams.set(provider === "guangya" ? "code" : "pwd", link.code);
  return { url: url.href, provider };
}
export function catalogSnapshot(row: CatalogRow): CatalogLandingSnapshot {
  return catalogLandingSnapshotSchema.parse(JSON.parse(row.snapshot_json));
}
export function remoteCatalog(
  row: CatalogRow,
  origin: string,
): RemoteCatalogLanding {
  return {
    id: row.id,
    slug: row.slug,
    url: `${origin}/c/${row.slug}`,
    active: row.active === 1,
    version: row.version,
    sourceRevision: row.source_revision,
    snapshot: catalogSnapshot(row),
    lastOperationId: row.last_operation_id,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}
export const findCatalog = (env: Env, id: string) =>
  env.DB.prepare("SELECT * FROM resource_catalogs WHERE id=?1")
    .bind(id)
    .first<CatalogRow>();
export const findCatalogSlug = (env: Env, slug: string) =>
  env.DB.prepare("SELECT * FROM resource_catalogs WHERE slug=?1")
    .bind(slug)
    .first<CatalogRow>();
export async function publicCatalogCount(env: Env) {
  return (
    (
      await env.DB.prepare(
        "SELECT count(*) AS n FROM resource_catalogs WHERE active=1 AND item_count>0",
      ).first<{ n: number }>()
    )?.n ?? 0
  );
}
export async function publicCatalogs(
  env: Env,
  limit = 20,
  offset = 0,
): Promise<CatalogListing[]> {
  return (
    await env.DB.prepare(
      `SELECT ${publicColumns} FROM resource_catalogs WHERE active=1 AND item_count>0 ORDER BY updated_at DESC,id LIMIT ?1 OFFSET ?2`,
    )
      .bind(limit, offset)
      .all<CatalogListing>()
  ).results;
}
const safeText = (value: string) =>
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) &&
  !/(?:file:\/\/|\/(?:Users|home|private|Volumes)\/|\b(?:access_token|refresh_token|bdstoken|stoken|authorization)\s*[:=])/i.test(
    value,
  );
function validateSnapshot(snapshot: CatalogLandingSnapshot, origin: string) {
  if (snapshot.id !== `snapshot_${snapshot.hash}`)
    throw new HttpError(400, "INVALID_SNAPSHOT", "清单快照标识与摘要不一致。");
  const ids = new Set<string>();
  const values = [snapshot.title, snapshot.category, snapshot.introduction];
  for (const item of snapshot.items) {
    if (ids.has(item.resourceId))
      throw new HttpError(400, "INVALID_SNAPSHOT", "清单中存在重复资源。");
    ids.add(item.resourceId);
    values.push(
      item.title,
      item.category,
      item.summary,
      ...item.tags,
      ...item.links.map((l) => l.provider),
    );
    for (const link of item.links) catalogShare(link, origin);
  }
  if (values.some((v) => !safeText(v)))
    throw new HttpError(
      400,
      "PRIVATE_CONTENT",
      "清单文本含内部路径或凭据格式，请清理后再发布。",
    );
}
export async function writeCatalog(
  env: Env,
  id: string,
  value: unknown,
  origin: string,
  withdraw = false,
): Promise<RemoteCatalogLanding> {
  const parsedWrite = withdraw
    ? null
    : catalogLandingWriteSchema.safeParse(value);
  const parsedWithdraw = withdraw
    ? catalogLandingWithdrawSchema.safeParse(value)
    : null;
  const writeInput = parsedWrite?.success ? parsedWrite.data : null;
  const input =
    writeInput ?? (parsedWithdraw?.success ? parsedWithdraw.data : null);
  if (!input)
    throw new HttpError(
      400,
      "INVALID_CATALOG",
      "清单发布参数不完整或超出支持范围，请重新读取清单后提交。",
    );
  if (
    writeInput &&
    input.expectedVersion === 0 &&
    !writeInput.snapshot.items.length
  )
    throw new HttpError(400, "EMPTY_CATALOG", "首次发布至少需要一份有效资源。");
  if (writeInput) validateSnapshot(writeInput.snapshot, origin);
  const requestHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify({ id, withdraw, ...input })),
      ),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const at = new Date().toISOString();
  // Random public slug is generated only on insert; on conflict the existing slug is retained.
  const slug = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  let failed = false;
  try {
    const statement = withdraw
      ? env.DB.prepare(
          `UPDATE resource_catalogs SET active=0,version=version+1,last_operation_id=?2,request_hash=?3,updated_at=?4
          WHERE id=?1 AND version=?5 AND NOT EXISTS(SELECT 1 FROM resource_catalog_operations WHERE operation_id=?2)`,
        ).bind(id, input.operationId, requestHash, at, input.expectedVersion)
      : (() => {
          if (!writeInput) throw new Error("Missing snapshot");
          return env.DB.prepare(
            `INSERT INTO resource_catalogs(id,slug,active,version,source_revision,snapshot_json,title,item_count,last_operation_id,request_hash,published_at,updated_at)
            SELECT ?1,?2,1,1,?3,?4,?5,?6,?7,?8,?9,?9
            WHERE (?10=0 OR EXISTS(SELECT 1 FROM resource_catalogs WHERE id=?1)) AND NOT EXISTS(SELECT 1 FROM resource_catalog_operations WHERE operation_id=?7)
            ON CONFLICT(id) DO UPDATE SET active=1,version=resource_catalogs.version+1,source_revision=excluded.source_revision,
              snapshot_json=excluded.snapshot_json,title=excluded.title,item_count=excluded.item_count,
              last_operation_id=excluded.last_operation_id,request_hash=excluded.request_hash,updated_at=excluded.updated_at
            WHERE resource_catalogs.version=?10`,
          ).bind(
            id,
            slug,
            writeInput.sourceRevision,
            JSON.stringify(writeInput.snapshot),
            writeInput.snapshot.title,
            writeInput.snapshot.items.length,
            input.operationId,
            requestHash,
            at,
            input.expectedVersion,
          );
        })();
    failed = !(await statement.run()).success;
  } catch {
    failed = true;
  }
  let receipt: CatalogRow | null;
  try {
    receipt = await env.DB.prepare(
      "SELECT * FROM resource_catalog_operations WHERE operation_id=?1",
    )
      .bind(input.operationId)
      .first<CatalogRow>();
  } catch {
    throw new HttpError(
      503,
      "OPERATION_UNCONFIRMED",
      "暂时无法核对清单发布结果，请保留原操作并重试。",
    );
  }
  if (receipt) {
    if (receipt.request_hash !== requestHash)
      throw new HttpError(
        409,
        "OPERATION_CONFLICT",
        "此操作标识已用于其他内容，请先核对原操作结果。",
      );
    return remoteCatalog(receipt, origin);
  }
  if (failed)
    throw new HttpError(
      503,
      "OPERATION_UNCONFIRMED",
      "暂时无法确认清单发布结果，请使用相同操作重试。",
    );
  throw new HttpError(
    409,
    "VERSION_CONFLICT",
    "线上清单版本已变化，请读取最新状态后再提交。",
  );
}

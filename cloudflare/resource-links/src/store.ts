import {
  HttpError,
  type Env,
  type LinkRow,
  type LinkWrite,
  type OperationRow,
  type RemoteLink,
} from "./types";

const columns =
  "id, slug, title, provider, target_url, code, enabled, revision, last_operation_id, updated_at";

/** Validate the deployed binding and migration without reading resource contents or writing. */
export async function checkConnection(env: Env): Promise<void> {
  try {
    const [links, operations, triggers] = await Promise.allSettled([
      env.DB.prepare(
        `SELECT ${columns}, request_json FROM resource_links LIMIT 0`,
      ).first<LinkRow>(),
      env.DB.prepare(
        `SELECT operation_id, ${columns}, request_json FROM resource_link_operations LIMIT 0`,
      ).first<OperationRow>(),
      env.DB.prepare(
        `
        SELECT count(*) AS trigger_count FROM sqlite_schema
        WHERE type = 'trigger' AND tbl_name = 'resource_links'
          AND name IN ('resource_links_receipt_insert', 'resource_links_receipt_update')
      `,
      ).first<{ trigger_count: number }>(),
    ]);
    if (
      links.status !== "fulfilled" ||
      operations.status !== "fulfilled" ||
      triggers.status !== "fulfilled" ||
      triggers.value?.trigger_count !== 2
    ) {
      throw new Error("Resource link migration is unavailable");
    }
  } catch {
    throw new HttpError(
      503,
      "DATABASE_NOT_READY",
      "资源入口数据库尚未就绪，请检查 D1 绑定并应用数据库迁移。",
    );
  }
}

export function remoteLink(row: LinkRow, origin: string): RemoteLink {
  return {
    id: row.id,
    slug: row.slug,
    url: `${origin}/r/${row.slug}`,
    title: row.title,
    provider: row.provider,
    targetUrl: row.target_url,
    code: row.code,
    enabled: row.enabled === 1,
    revision: row.revision,
    lastOperationId: row.last_operation_id,
    updatedAt: row.updated_at,
  };
}

export function findById(env: Env, id: string): Promise<LinkRow | null> {
  return env.DB.prepare(`SELECT ${columns} FROM resource_links WHERE id = ?1`)
    .bind(id)
    .first<LinkRow>();
}

export function findBySlug(env: Env, slug: string): Promise<LinkRow | null> {
  return env.DB.prepare(`SELECT ${columns} FROM resource_links WHERE slug = ?1`)
    .bind(slug)
    .first<LinkRow>();
}

/** A single UPSERT is the only mutation; AFTER triggers journal its committed snapshot. */
const compareAndSwap = `
  INSERT INTO resource_links (
    id, slug, title, provider, target_url, code, enabled, revision,
    last_operation_id, updated_at, request_json
  )
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?9, ?8, ?11
  WHERE (?10 = 0 OR EXISTS (SELECT 1 FROM resource_links WHERE id = ?1))
    AND NOT EXISTS (SELECT 1 FROM resource_link_operations WHERE operation_id = ?9)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    provider = excluded.provider,
    target_url = excluded.target_url,
    code = excluded.code,
    enabled = excluded.enabled,
    revision = resource_links.revision + 1,
    last_operation_id = excluded.last_operation_id,
    updated_at = excluded.updated_at,
    request_json = excluded.request_json
  WHERE resource_links.revision = ?10 AND resource_links.slug = excluded.slug
  ON CONFLICT(slug) DO NOTHING
`;

export async function putLink(
  env: Env,
  id: string,
  input: LinkWrite,
  origin: string,
): Promise<RemoteLink> {
  // Fixed field order makes object property order irrelevant; all submitted values, including
  // expectedRevision and id, participate in operation-id conflict detection.
  const requestJson = JSON.stringify({ id, ...input });
  let writeFailed = false;
  try {
    const result = await env.DB.prepare(compareAndSwap)
      .bind(
        id,
        input.slug,
        input.title,
        input.provider,
        input.targetUrl,
        input.code,
        input.enabled ? 1 : 0,
        new Date().toISOString(),
        input.operationId,
        input.expectedRevision,
        requestJson,
      )
      .run();
    writeFailed = !result.success;
  } catch {
    // A failed HTTP/database response does not prove that the statement did not commit.
    // Recover the durable receipt before deciding what happened; never replay a new id.
    writeFailed = true;
  }
  let receipt: OperationRow | null;
  try {
    receipt = await env.DB.prepare(
      `
      SELECT ${columns}, request_json FROM resource_link_operations WHERE operation_id = ?1
    `,
    )
      .bind(input.operationId)
      .first<OperationRow>();
  } catch {
    throw new HttpError(
      503,
      "OPERATION_UNCONFIRMED",
      "暂时无法核对保存结果，请保留本次 operationId，稍后使用相同请求重试。",
    );
  }
  if (receipt) {
    if (receipt.request_json !== requestJson) {
      throw new HttpError(
        409,
        "OPERATION_CONFLICT",
        "此 operationId 已用于不同的请求，请先核对原操作结果。",
      );
    }
    return remoteLink(receipt, origin);
  }
  if (writeFailed)
    throw new HttpError(
      503,
      "OPERATION_UNCONFIRMED",
      "暂时无法确认保存结果，请使用相同 operationId 和请求内容重试。",
    );
  const current = await findById(env, id);
  if (current && current.slug !== input.slug)
    throw new HttpError(409, "SLUG_IMMUTABLE", "固定入口创建后不能修改短码。");
  const slugOwner = await findBySlug(env, input.slug);
  if (slugOwner && slugOwner.id !== id)
    throw new HttpError(
      409,
      "SLUG_CONFLICT",
      "此短码已被使用，请选择其他短码。",
    );
  throw new HttpError(
    409,
    "REVISION_CONFLICT",
    "远端入口版本已变化或不存在，请先读取最新记录后再保存。",
  );
}

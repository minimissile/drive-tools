import type { Database } from "./database";
import type { Provider, ResourceInput, ShareInput } from "../shared/types";
import { isIndexedOwnSource } from "../shared/owned-file-source";
import { AppError } from "./errors";

/** Only existing, exact local provenance may bypass share parsing during metadata edits. */
export function indexedOwnSource(
  db: Database,
  input: ResourceInput,
): ShareInput | null {
  if (!input.id) return null;
  const resource = db.get<{
    source_url: string;
    source_key: string;
    source_kind: string;
    provider: Provider;
  }>(
    "SELECT source_url,source_key,source_kind,provider FROM resources WHERE id=?",
    input.id,
  );
  if (
    !resource ||
    resource.source_kind !== "owned" ||
    !isIndexedOwnSource(resource.source_url)
  )
    return null;
  if (
    !input.isOwnResource ||
    input.enqueue ||
    input.sourceText.trim() !== resource.source_url ||
    !input.copyId ||
    !db.get(
      "SELECT 1 FROM copies c JOIN accounts a ON a.id=c.account_id WHERE c.id=? AND c.resource_id=? AND c.account_id=? AND c.owner_uid=a.uid AND c.verified_at IS NOT NULL",
      input.copyId,
      input.id,
      input.accountId,
    )
  )
    throw new AppError(
      "INDEXED_SOURCE_IMMUTABLE",
      "此记录来自本人网盘目录，请保留原账号与来源编辑；分享需在资源中单独创建。",
    );
  return {
    provider: resource.provider,
    shareKey: resource.source_key,
    url: resource.source_url,
    code: "",
  };
}

import type { Provider, SimilarResource } from "../shared/types";
import { providerSpecs } from "../shared/providers";
import type { Database } from "./database";
import { AppError } from "./errors";
import { normalizedResourceTitle } from "../shared/resource-names";
export { normalizedResourceTitle } from "../shared/resource-names";

const similarityThreshold = 0.8;

/** Normalized edit similarity. Values below the warning threshold return zero. */
export function resourceTitleSimilarity(left: string, right: string) {
  const a = Array.from(normalizedResourceTitle(left));
  const b = Array.from(normalizedResourceTitle(right));
  const length = Math.max(a.length, b.length);
  if (!length || !a.length || !b.length) return 0;
  const allowed = Math.floor(length * (1 - similarityThreshold) + 1e-9);
  if (Math.abs(a.length - b.length) > allowed) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row++) {
    const current = new Array<number>(b.length + 1).fill(allowed + 1);
    current[0] = row;
    let minimum = current[0];
    for (
      let column = Math.max(1, row - allowed);
      column <= Math.min(b.length, row + allowed);
      column++
    ) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
      minimum = Math.min(minimum, current[column]);
    }
    if (minimum > allowed) return 0;
    previous = current;
  }
  const distance = previous[b.length];
  return distance <= allowed ? 1 - distance / length : 0;
}

export function similarResources(db: Database, title: string, excludeId = "") {
  if (!normalizedResourceTitle(title)) return [];
  return db
    .all<Omit<SimilarResource, "similarity">>(
      "SELECT id,title,provider FROM resources WHERE id!=?",
      excludeId,
    )
    .map((resource) => ({
      ...resource,
      similarity: resourceTitleSimilarity(title, resource.title),
    }))
    .filter((resource) => resource.similarity >= similarityThreshold)
    .sort(
      (a, b) => b.similarity - a.similarity || a.title.localeCompare(b.title),
    )
    .slice(0, 10);
}

export function exactTitleResource(
  db: Database,
  title: string,
  provider: Provider,
  excludeId = "",
) {
  const normalized = normalizedResourceTitle(title);
  if (!normalized) return undefined;
  return db
    .all<{ id: string; title: string }>(
      "SELECT id,title FROM resources WHERE provider=? AND id!=? ORDER BY created_at",
      provider,
      excludeId,
    )
    .find((resource) => normalizedResourceTitle(resource.title) === normalized);
}

export function duplicateResourceError(title: string, provider: Provider) {
  return new AppError(
    "RESOURCE_PROVIDER_EXISTS",
    `“${title}”已在${providerSpecs[provider].name}资源库中保存。同一资源在同类型网盘只保留一份，请打开已有资源编辑。`,
  );
}

/** Recheck synchronously inside the save transaction after asynchronous work. */
export function assertResourceUnique(
  db: Database,
  input: {
    resourceId: string;
    sourceUrl: string;
    title: string;
    provider: Provider;
    accountId: string;
    copyId?: string;
  },
) {
  const bySource = db.get<{ id: string; title: string }>(
    "SELECT id,title FROM resources WHERE source_url=?",
    input.sourceUrl,
  );
  if (bySource && bySource.id !== input.resourceId)
    throw duplicateResourceError(bySource.title, input.provider);
  const current = input.copyId
    ? db.get<{ title: string }>(
        "SELECT title FROM resources WHERE id=?",
        input.resourceId,
      )
    : undefined;
  const byTitle =
    current &&
    normalizedResourceTitle(current.title) ===
      normalizedResourceTitle(input.title)
      ? undefined
      : exactTitleResource(db, input.title, input.provider, input.resourceId);
  if (byTitle) throw duplicateResourceError(byTitle.title, input.provider);
  if (input.copyId) {
    const edited = db.get<{ resource_id: string; account_id: string }>(
      "SELECT resource_id,account_id FROM copies WHERE id=?",
      input.copyId,
    );
    if (
      !edited ||
      edited.resource_id !== input.resourceId ||
      edited.account_id !== input.accountId
    )
      throw new AppError(
        "COPY_MISMATCH",
        "已有资源账号不能直接改绑，请打开原记录编辑。",
      );
    return;
  }
  const prior = db.get<{ title: string }>(
    "SELECT r.title FROM copies c JOIN resources r ON r.id=c.resource_id JOIN accounts a ON a.id=c.account_id WHERE c.resource_id=? AND a.provider=? LIMIT 1",
    input.resourceId,
    input.provider,
  );
  if (prior) throw duplicateResourceError(prior.title, input.provider);
}

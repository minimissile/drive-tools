import type { Pool, PoolSummary } from "../../shared/types";

/** Keep an already-open dev window usable while its backend update is pending. */
export function poolSummary(pool: PoolSummary | Pool): PoolSummary {
  if ("keywordCount" in pool) return pool;
  return {
    id: pool.id,
    name: pool.name,
    resourceId: pool.resourceId,
    keywordCount: pool.keywords.length,
    preview: pool.keywords.slice(0, 5).map(({ id, word }) => ({ id, word })),
    createdAt: pool.createdAt,
  };
}

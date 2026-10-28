import { z } from "zod";
import type { CollectionCandidate } from "../../shared/resource-collection";

const pageSchema = z.object({
  rows: z
    .array(
      z.object({
        name: z.string(),
        link: z.string(),
        code: z.string(),
        sourceName: z.string().optional(),
        sourceUrl: z.string().optional(),
        verified: z.boolean().optional(),
      }),
    )
    .max(100),
  hasMore: z.boolean(),
});
const checkpointSchema = z.object({
  index: z.number().int().nonnegative(),
  pansoo: pageSchema.optional(),
  haisou: pageSchema.optional(),
});

export interface CollectionSearchClient {
  search(
    keyword: string,
    page: number,
    signal: AbortSignal,
  ): Promise<{ rows: CollectionCandidate[]; hasMore: boolean }>;
}
export type CollectionPageCheckpoint = z.infer<typeof checkpointSchema>;
export function collectionPageCheckpoint(
  raw: unknown,
  index: number,
): CollectionPageCheckpoint {
  const parsed = checkpointSchema.safeParse(raw);
  return parsed.success && parsed.data.index === index
    ? parsed.data
    : { index };
}

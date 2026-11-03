import { z } from "zod";
import { contentImageSchema } from "../../shared/content-sources";
import {
  supplyEditorialSchema,
  type SupplyDraft,
} from "../../shared/content-supply";
import type { Database } from "../database";

const sourceSchema = z.object({
  id: z.string().regex(/^\d{8,30}$/),
  url: z.string().max(8000),
  text: z.string().max(30000),
  author: z.string().max(1000),
  kind: z.enum(["images", "text", "video"]),
  images: z
    .array(
      z.object({
        id: z.string(),
        url: z.string(),
        animated: z.boolean(),
        asset: contentImageSchema.optional(),
        error: z.string().optional(),
      }),
    )
    .max(9),
  comments: z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        author: z.string(),
        likes: z.number().nullable(),
        label: z.string(),
      }),
    )
    .max(50),
  commentCount: z.number().nullable(),
  warnings: z.string().array(),
  collectedAt: z.iso.datetime(),
});
const draftSchema: z.ZodType<SupplyDraft> = z.object({
  id: z.string(),
  sourceId: z.string(),
  version: z.number().int().positive(),
  stage: z.enum([
    "queued",
    "collecting",
    "blocked",
    "editing",
    "held",
    "delivered",
  ]),
  reason: z.string(),
  source: sourceSchema.nullable(),
  editorial: supplyEditorialSchema,
  deliveries: z.array(
    z.object({
      channel: z.enum(["zhihu", "weibo"]),
      accountId: z.string(),
      targetId: z.string(),
      title: z.string(),
      fingerprint: z.string(),
      createdAt: z.iso.datetime(),
      planLinked: z.boolean(),
      linkError: z.string(),
    }),
  ),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const prefix = "contentSupply:draft:v1:";
export function readSupplyDraft(db: Database, id: string) {
  const row = db.get<{ value: string }>(
    "SELECT value FROM settings WHERE key=?",
    `${prefix}${id}`,
  );
  return row ? draftSchema.parse(JSON.parse(row.value)) : null;
}
export function readSupplyDrafts(db: Database) {
  // A corrupt entry is a read error, never an empty inventory or a reason to overwrite it.
  return db
    .all<{ value: string }>(
      "SELECT value FROM settings WHERE key LIKE ? ORDER BY rowid DESC",
      `${prefix}%`,
    )
    .map((row) => draftSchema.parse(JSON.parse(row.value)));
}
export function storeSupplyDraft(db: Database, draft: SupplyDraft) {
  db.setSetting(`${prefix}${draft.id}`, draftSchema.parse(draft));
}

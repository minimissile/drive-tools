import { z } from "zod";

/** Public allowlist. Never send catalog exclusions, account identities or internal paths. */
const text = (max: number) => z.string().trim().max(max);
export const catalogLandingIdSchema = z
  .string()
  .regex(/^catalog_[\w-]{1,100}$/);
export const catalogLandingSlugSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,32}$/);
export const catalogLandingSnapshotSchema = z
  .object({
    id: z.string().regex(/^snapshot_[a-f0-9]{64}$/),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    title: text(120).min(1),
    category: text(60).min(1),
    introduction: text(4000),
    createdAt: z.string().datetime(),
    items: z
      .array(
        z
          .object({
            resourceId: z.string().min(1).max(128),
            title: text(300).min(1),
            category: text(60),
            summary: text(12000),
            tags: z.array(text(100)).max(100),
            landingSlug: catalogLandingSlugSchema.nullable().optional(),
            links: z
              .array(
                z
                  .object({
                    provider: text(400).min(1),
                    url: z.string().url().max(2048),
                    code: z
                      .string()
                      .max(128)
                      .regex(/^[^\u0000-\u001f\u007f]*$/),
                  })
                  .strict(),
              )
              .min(1)
              .max(200),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();
export const catalogLandingWriteSchema = z
  .object({
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().min(0).max(2147483646),
    sourceRevision: z.number().int().positive(),
    snapshot: catalogLandingSnapshotSchema,
  })
  .strict();
export const catalogLandingWithdrawSchema = z
  .object({
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().positive().max(2147483646),
  })
  .strict();
export const remoteCatalogLandingSchema = z.object({
  id: catalogLandingIdSchema,
  slug: catalogLandingSlugSchema,
  url: z.string().url().max(2048),
  active: z.boolean(),
  version: z.number().int().positive(),
  sourceRevision: z.number().int().positive(),
  snapshot: catalogLandingSnapshotSchema,
  lastOperationId: z.string().uuid(),
  publishedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CatalogLandingSnapshot = z.infer<
  typeof catalogLandingSnapshotSchema
>;
export type CatalogLandingWrite = z.infer<typeof catalogLandingWriteSchema>;
export type CatalogLandingWithdraw = z.infer<
  typeof catalogLandingWithdrawSchema
>;
export type RemoteCatalogLanding = z.infer<typeof remoteCatalogLandingSchema>;
export const catalogLandingMaxBodyBytes = 1024 * 1024;

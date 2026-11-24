import { z } from "zod";
import { contentImageSchema, type ContentImage } from "./content-sources";
import type { WebsiteAccount } from "./website-accounts";
import type { JianshuCollectInput } from "./jianshu-sources";

export const jianshuIdSchema = z.string().regex(/^jianshu_[\w-]{1,100}$/);
export const jianshuSourceIdSchema = z
  .string()
  .max(150)
  .regex(/^[\w-]+$/);
export const jianshuTemplateSchema = z.enum(["resource", "guide"]);
export type JianshuTemplate = z.infer<typeof jianshuTemplateSchema>;
export const jianshuTemplateItems = [
  { value: "resource", label: "资源介绍" },
  { value: "guide", label: "使用指南" },
];

export type { JianshuCollectInput } from "./jianshu-sources";
export { jianshuCollectInput as jianshuCollectSchema } from "./jianshu-sources";
export type JianshuSource = import("./jianshu-sources").JianshuSourceMaterial;

export interface JianshuVersion {
  revision: number;
  title: string;
  body: string;
  images: ContentImage[];
  instruction: string;
  origin: "created" | "manual" | "ai";
  createdAt: string;
  /** Missing on early drafts: restoring them must explicitly keep current associations. */
  copyId?: string | null;
  sourceIds?: string[];
  template?: JianshuTemplate;
}
export type JianshuStage =
  "editing" | "preparing" | "prepared" | "uncertain" | "published";

/** A writer notebook is not a draft checkpoint: resuming requires a specific note. */
export function jianshuDraftUrl(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !["www.jianshu.com", "jianshu.com"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      !/^\/writer\/?$/.test(url.pathname) ||
      !/^#\/notebooks\/[1-9]\d*\/notes\/[1-9]\d*$/.test(url.hash)
    )
      return null;
    return `https://www.jianshu.com/writer${url.hash}`;
  } catch {
    return null;
  }
}
export const jianshuFillCheckpointSchema = z
  .object({
    editorUrl: z
      .string()
      .max(4000)
      .refine((value) => jianshuDraftUrl(value) !== null),
    filled: z.boolean().optional(),
    uploadedImages: z.number().int().min(0).max(20).optional(),
    totalImages: z.number().int().min(0).max(20).optional(),
    titleHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    textHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    /** A submitted upload whose result must be resolved before any retry. */
    pendingImageSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    uploadedImageRefs: z
      .array(
        z.object({
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          url: z
            .string()
            .max(4000)
            .refine((value) => {
              try {
                const url = new URL(value);
                return (
                  url.protocol === "https:" &&
                  !url.username &&
                  !url.password &&
                  !url.port
                );
              } catch {
                return false;
              }
            }),
        }),
      )
      .max(20)
      .optional(),
  })
  .refine(
    (value) =>
      value.uploadedImages === undefined ||
      value.totalImages === undefined ||
      value.uploadedImages <= value.totalImages,
  );
export type JianshuFillCheckpoint = z.infer<typeof jianshuFillCheckpointSchema>;

export interface JianshuArticle {
  id: string;
  title: string;
  body: string;
  template: JianshuTemplate;
  copyId: string | null;
  sourceIds: string[];
  images: ContentImage[];
  accountId: string | null;
  revision: number;
  versions: JianshuVersion[];
  aiAssisted: boolean;
  stage: JianshuStage;
  message: string;
  editorUrl: string | null;
  receiptUrl: string | null;
  preparedRevision: number | null;
  preparedUid: string | null;
  preparedEnvironment: string | null;
  preparedText: string | null;
  preparedDelivery?: JianshuDelivery | null;
  preparedShareCodeHash?: string | null;
  /** The linked remote draft and last verified fill result, retained for safe retries. */
  preparedFill?: JianshuFillCheckpoint | null;
  imageReviewRequired?: boolean;
  imageReviewedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface JianshuIssue {
  severity: "error" | "warning";
  text: string;
}
export interface JianshuDelivery {
  text: string;
  html: string;
  resourceUrl: string | null;
  sourceUrls: string[];
  /** Ephemeral SecretStore value; never persisted by article/settings workflows. */
  resourceCode?: string;
}
export interface JianshuDetail {
  article: JianshuArticle;
  sources: JianshuSource[];
  issues: JianshuIssue[];
  delivery: JianshuDelivery;
  busy: boolean;
}
export type JianshuSummary = Pick<
  JianshuArticle,
  | "id"
  | "title"
  | "stage"
  | "accountId"
  | "copyId"
  | "sourceIds"
  | "updatedAt"
  | "receiptUrl"
  | "message"
  | "imageReviewRequired"
>;
export interface JianshuPayload extends JianshuDelivery {
  id: string;
  title: string;
  images: ContentImage[];
  aiAssisted: boolean;
  editorUrl?: string | null;
  fillCheckpoint?: JianshuFillCheckpoint | null;
}
export interface JianshuPreparation {
  opened: true;
  filled: boolean;
  editorUrl: string;
  message: string;
  uploadedImages?: number;
  totalImages?: number;
}
export interface JianshuReceipt {
  verified: boolean;
  url: string;
  reason: string;
  imageReviewRequired?: boolean;
}
export interface JianshuPort {
  /** Open the exact existing note in its account session without filling or saving. */
  openEditor?(
    account: WebsiteAccount,
    url: string,
  ): Promise<{ opened: true; editorUrl: string }>;
  prepare(
    account: WebsiteAccount,
    payload: JianshuPayload,
    onCheckpoint?: (checkpoint: JianshuFillCheckpoint) => Promise<void>,
  ): Promise<JianshuPreparation>;
  checkResult(
    account: WebsiteAccount,
    url: string,
    payload: JianshuPayload,
  ): Promise<JianshuReceipt>;
}

export const jianshuCreateSchema = z.object({
  requestId: z.uuid(),
  copyId: z.string().max(150).nullable().optional(),
  sourceIds: z.array(jianshuSourceIdSchema).max(20).default([]),
  title: z.string().trim().max(200).default(""),
  body: z.string().max(100000).default(""),
  template: jianshuTemplateSchema.default("resource"),
  accountId: z.string().max(150).nullable().optional(),
});
export type JianshuCreateInput = z.infer<typeof jianshuCreateSchema>;
export const jianshuSaveSchema = z.object({
  id: jianshuIdSchema,
  revision: z.number().int().positive(),
  title: z.string().trim().max(200),
  body: z.string().max(100000),
  template: jianshuTemplateSchema,
  accountId: z.string().max(150).nullable(),
  copyId: z.string().max(150).nullable(),
  sourceIds: z.array(jianshuSourceIdSchema).max(20),
  images: z.array(contentImageSchema).max(20),
});
export type JianshuSaveInput = z.infer<typeof jianshuSaveSchema>;
export const jianshuGenerateSchema = z.object({
  id: jianshuIdSchema,
  revision: z.number().int().positive(),
  requestId: z.uuid(),
  instruction: z.string().trim().max(4000).default(""),
});
export type JianshuGenerateInput = z.infer<typeof jianshuGenerateSchema>;
export const jianshuVersionSchema = z.object({
  id: jianshuIdSchema,
  revision: z.number().int().positive(),
});
export const jianshuResolveSchema = jianshuVersionSchema
  .extend({
    notPublished: z.literal(true),
    imageNotUploaded: z.literal(true).optional(),
    newDraft: z.literal(true).optional(),
  })
  .refine(
    (value) => !(value.imageNotUploaded && value.newDraft),
    "请单独选择图片重试或改用新草稿。",
  );
export const jianshuResultSchema = jianshuVersionSchema.extend({
  url: z.string().trim().max(2000),
});
type Contract<A, V> = { args: A; value: V };
export interface JianshuContract {
  "jianshu.list": Contract<undefined, JianshuSummary[]>;
  "jianshu.get": Contract<{ id: string }, JianshuDetail>;
  "jianshu.sources": Contract<undefined, JianshuSource[]>;
  "jianshu.collect": Contract<JianshuCollectInput, JianshuSource[]>;
  "jianshu.create": Contract<JianshuCreateInput, JianshuDetail>;
  "jianshu.save": Contract<JianshuSaveInput, JianshuDetail>;
  "jianshu.generate": Contract<JianshuGenerateInput, JianshuDetail>;
  "jianshu.prepare": Contract<{ id: string; revision: number }, JianshuDetail>;
  "jianshu.checkResult": Contract<
    { id: string; revision: number; url: string },
    JianshuDetail
  >;
  "jianshu.resolve": Contract<
    z.infer<typeof jianshuResolveSchema>,
    JianshuDetail
  >;
  "jianshu.confirmImages": Contract<
    { id: string; revision: number; confirmed: true },
    JianshuDetail
  >;
  "jianshu.importImages": Contract<
    { id: string; revision: number },
    JianshuDetail | null
  >;
  "jianshu.matches": Contract<
    { keyword: string },
    import("./content-sources").ContentResourceMatch[]
  >;
  "jianshu.image": Contract<
    { id: string; revision: number; file: string },
    string
  >;
  "jianshu.copy": Contract<{ id: string; revision: number }, boolean>;
  "jianshu.export": Contract<{ id: string; revision: number }, string | null>;
}

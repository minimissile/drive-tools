import { z } from "zod";
import type { WebsiteAccount } from "./website-accounts";
import type { TiebaAutocareTarget } from "./tieba-autocare";
import type { RuntimeLogPage } from "./runtime-logs";
import type { ContentImage } from "./content-sources";

export interface TiebaTopicImage extends ContentImage {
  id: string;
}
export const tiebaTopicSourceSchema = z.object({
  kind: z.enum(["owned", "licensed"]).default("owned"),
  title: z.string().trim().max(200).default(""),
  body: z.string().trim().max(20000).default(""),
  sourceUrl: z.string().trim().max(2000).default(""),
  rightsNote: z.string().trim().max(2000).default(""),
});
export type TiebaTopicSource = z.infer<typeof tiebaTopicSourceSchema>;
export interface TiebaTopicRule {
  targetId: string;
  version: number;
  note: string;
  allowImages: boolean;
  checkedAt: string;
}
export interface TiebaTopicReceipt {
  status: "verified" | "pending_review" | "uncertain";
  forumId: string;
  threadId: string | null;
  postId: string | null;
  url: string | null;
  authorUid: string | null;
  title: string | null;
  body: string | null;
  images: { sha256: string; url: string }[];
  checkedAt: string;
  message: string;
}
export type TiebaTopicStatus =
  | "draft"
  | "ready"
  | "generating"
  | "submitting"
  | "verified"
  | "pending_review"
  | "uncertain"
  | "attention"
  | "failed";
export interface TiebaTopicDraft {
  id: string;
  targetId: string;
  accountId: string;
  uid: string;
  forumId: string;
  forumName: string;
  title: string;
  body: string;
  source: TiebaTopicSource;
  images: TiebaTopicImage[];
  version: number;
  status: TiebaTopicStatus;
  checks: string[];
  model: string | null;
  generationAttempts: number;
  aiGenerated?: boolean;
  submittedAt: string | null;
  receipt: TiebaTopicReceipt | null;
  message: string;
  createdAt: string;
  updatedAt: string;
}
export interface TiebaTopicsSnapshot {
  busy: boolean;
  accounts: WebsiteAccount[];
  targets: TiebaAutocareTarget[];
  rules: TiebaTopicRule[];
  drafts: TiebaTopicDraft[];
  logs: RuntimeLogPage;
  message: string;
  savedDraftId?: string;
}
const draftId = z.string().regex(/^tiebatopic_[\w-]+$/);
const targetId = z.string().regex(/^tiebatarget_[\w-]+$/);
const imageId = z.string().regex(/^tiebatopicimage_[\w-]+$/);
export const tiebaTopicSaveSchema = z.object({
  id: draftId.optional(),
  version: z.number().int().positive().optional(),
  targetId,
  title: z.string().trim().max(30),
  body: z.string().trim().max(10000),
  source: tiebaTopicSourceSchema,
});
export const tiebaTopicRuleSchema = z.object({
  targetId,
  version: z.number().int().min(0),
  note: z.string().trim().min(20).max(2000),
  allowImages: z.boolean(),
  confirmed: z.literal(true),
});
export const tiebaTopicGenerateSchema = z.object({
  id: draftId,
  version: z.number().int().positive(),
  confirmed: z.literal(true),
  rightsConfirmed: z.literal(true),
});
export const tiebaTopicSubmitSchema = z.object({
  id: draftId,
  version: z.number().int().positive(),
  confirmed: z.literal(true),
  rightsConfirmed: z.literal(true),
});
export const tiebaTopicImagePickSchema = z.object({
  id: draftId,
  version: z.number().int().positive(),
});
export const tiebaTopicImageRemoveSchema = z.object({
  id: draftId,
  version: z.number().int().positive(),
  imageId,
});
export const tiebaTopicImageSchema = z.object({ id: draftId, imageId });
export const tiebaTopicReconcileSchema = z.object({ id: draftId });
type Contract<A> = { args: A; value: TiebaTopicsSnapshot };
export interface TiebaTopicsContract {
  "tieba.topics.snapshot": Contract<undefined>;
  "tieba.topics.save": Contract<z.infer<typeof tiebaTopicSaveSchema>>;
  "tieba.topics.rule": Contract<z.infer<typeof tiebaTopicRuleSchema>>;
  "tieba.topics.generate": Contract<z.infer<typeof tiebaTopicGenerateSchema>>;
  "tieba.topics.submit": Contract<z.infer<typeof tiebaTopicSubmitSchema>>;
  "tieba.topics.reconcile": Contract<z.infer<typeof tiebaTopicReconcileSchema>>;
  "tieba.topics.pickImages": Contract<
    z.infer<typeof tiebaTopicImagePickSchema>
  >;
  "tieba.topics.removeImage": Contract<
    z.infer<typeof tiebaTopicImageRemoveSchema>
  >;
  "tieba.topics.image": {
    args: z.infer<typeof tiebaTopicImageSchema>;
    value: string;
  };
}

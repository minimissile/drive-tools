import { z } from "zod";
import { contentFormatIds } from "./channels";
import { studioRatios } from "./studio-options";
import type { Draft } from "./types";
export const creativeFormat = z.enum(["text", "image", "carousel", "video"]);
export const creativeCard = z.object({
  heading: z.string().max(120),
  copy: z.string().max(1500),
  imagePrompt: z.string().max(4000),
});
export const creativePackage = z.object({
  format: creativeFormat,
  templateId: z.string().min(1).max(100),
  brief: z.string().max(3000),
  aspectRatio: z.enum(studioRatios),
  cards: z.array(creativeCard).max(8),
  videoPrompt: z.string().max(8000),
  voiceover: z.string().max(5000),
});
export const creativeResponse = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(25000),
  tags: z.array(z.string().max(60)).max(20),
  coverText: z.string().max(300),
  cards: z.array(creativeCard).max(8),
  videoPrompt: z.string().max(8000),
  voiceover: z.string().max(5000),
});
export const creativeTemplateInput = z.object({
  id: z.string().max(100).optional(),
  name: z.string().trim().min(1).max(60),
  description: z.string().max(200).default(""),
  style: z.string().trim().min(1).max(2000),
  instruction: z.string().trim().min(1).max(3000),
  accent: z
    .string()
    .regex(/^#[a-fA-F0-9]{6}$/)
    .default("#3567cf"),
});
export type CreativeTemplate = Omit<
  z.infer<typeof creativeTemplateInput>,
  "id"
> & { id: string; builtin: boolean };
export type CreativePackage = z.infer<typeof creativePackage>;
// A working copy may be incomplete; validation for a publishable version stays
// in draft.save/draft.review. Keeping it separate never changes the reviewed draft.
export const studioEditorValue = z.object({
  title: z.string().max(200),
  body: z.string().max(30000),
  tags: z.string().max(3000),
  coverText: z.string().max(300),
  creative: creativePackage.nullable(),
});
export const studioWorkingCopy = z.object({
  draftId: z.string().min(1).max(100),
  editedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  value: studioEditorValue,
});
export type StudioEditorValue = z.infer<typeof studioEditorValue>;
export type StudioWorkingCopy = z.infer<typeof studioWorkingCopy>;
export function editorValueForDraft(draft: Draft): StudioEditorValue {
  return {
    title: draft.title,
    body: draft.body,
    tags: draft.tags.join(" "),
    coverText: draft.coverText,
    creative: draft.creative,
  };
}
export interface MediaModel {
  id: string;
  name: string;
  kind: "image" | "video";
  ratios: string[];
  durations: number[];
  resolutions: string[];
  audio: boolean;
  reference: boolean;
  pricing: string;
  qualities?: string[];
  lastError?: string;
  description?: string;
  priceLines?: import("./model-pricing").ModelPriceLine[];
  pricingUpdatedAt?: string;
  pricingError?: string;
}
export interface StudioJob {
  superseded?: boolean;
  id: string;
  draftId: string;
  kind: "image" | "video";
  slot: number;
  model: string;
  prompt: string;
  status:
    | "submitting"
    | "pending"
    | "in_progress"
    | "completed"
    | "failed"
    | "uncertain"
    | "download_failed";
  remoteId: string | null;
  asset: string | null;
  extension: "png" | "mp4" | null;
  callId: string;
  keyFingerprint: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  checkedAt: string | null;
  costMicros: number | null;
  reservedMicros: number;
  aspectRatio: string;
  duration: number;
  resolution: string;
  audio: boolean;
}
export const studioCreateInput = z.object({
  contentFormat: z.enum(contentFormatIds).optional(),
  copyId: z.string().max(100),
  platform: z.string().max(50),
  poolId: z.string().max(100).nullable().default(null),
  sourceDraftId: z.string().max(100).nullable().default(null),
  mode: z.enum(["ai", "template", "blank"]).default("ai"),
  format: creativeFormat.default("text"),
  templateId: z.string().max(100).default("resource-guide"),
  brief: z.string().max(3000).default(""),
  aspectRatio: z.enum(studioRatios).default("3:4"),
  pageCount: z.number().int().min(1).max(8).default(3),
});
export const mediaSubmitInput = z.object({
  draftId: z.string().max(100),
  kind: z.enum(["image", "video"]),
  slot: z.number().int().min(0).max(7).default(0),
  model: z.string().trim().max(150).default(""),
  reserveMicros: z.number().int().min(1000).max(1_000_000_000),
  duration: z.number().int().min(1).max(60).default(8),
  resolution: z.string().max(20).default("720p"),
  audio: z.boolean().default(false),
  referenceCover: z.boolean().default(false),
  regenerate: z.boolean().default(false),
});

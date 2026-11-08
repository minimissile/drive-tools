import { z } from "zod";
import type { WebsiteAccount } from "./website-accounts";
import type { TiebaAutocareTarget } from "./tieba-autocare";
import type { TiebaTopicReceipt } from "./tieba-topics";
import type { ContentKeyword } from "./content-sources";
import type { RuntimeLogPage } from "./runtime-logs";
import type { Provider } from "./types";

export interface TiebaPublishingResource {
  resourceId: string;
  copyId: string;
  title: string;
  summary: string;
  provider: Provider;
  accountAlias: string;
  url: string;
  code: string;
  resourceRevision: number;
  shareVersion: number;
  matchedTerms: string[];
}
export type TiebaPublishingStatus =
  | "draft"
  | "ready"
  | "submitting"
  | "verified"
  | "pending_review"
  | "uncertain";
export interface TiebaPublishingDraft {
  id: string;
  targetId: string;
  accountId: string;
  uid: string;
  forumId: string;
  forumName: string;
  keyword: string;
  keywordSourceId: string;
  resources: TiebaPublishingResource[];
  title: string;
  body: string;
  ruleNote: string;
  version: number;
  status: TiebaPublishingStatus;
  checks: string[];
  message: string;
  submittedAt: string | null;
  receipt: TiebaTopicReceipt | null;
  createdAt: string;
  updatedAt: string;
}
export interface TiebaPublishingSnapshot {
  busy: boolean;
  accounts: WebsiteAccount[];
  targets: TiebaAutocareTarget[];
  drafts: TiebaPublishingDraft[];
  logs: RuntimeLogPage;
  savedDraftId?: string;
  message: string;
}
const identifier = z.string().regex(/^tiebapublishing_[\w-]+$/);
export const tiebaPublishingQuerySchema = z.object({
  query: z.string().trim().max(100).default(""),
});
export const tiebaPublishingWordsSchema = tiebaPublishingQuerySchema.extend({
  source: z.enum(["all", "history", "pool"]).default("all"),
});
export const tiebaPublishingSaveSchema = z.object({
  id: identifier.optional(),
  version: z.number().int().positive().optional(),
  targetId: z.string().regex(/^tiebatarget_[\w-]+$/),
  keyword: z.string().trim().min(1).max(100),
  keywordSourceId: z.string().max(250).default("manual"),
  copyIds: z.array(z.string().min(1).max(150)).min(1).max(10),
  title: z.string().trim().max(30),
  body: z.string().trim().max(10000),
  ruleNote: z.string().trim().max(2000).default(""),
});
export const tiebaPublishingSubmitSchema = z.object({
  id: identifier,
  version: z.number().int().positive(),
  /** Marks an explicit publish-button request; it does not require another UI confirmation. */
  confirmed: z.literal(true),
});
export const tiebaPublishingReconcileSchema = z.object({ id: identifier });
type Contract<A> = { args: A; value: TiebaPublishingSnapshot };
export interface TiebaPublishingContract {
  "tieba.publishing.snapshot": Contract<undefined>;
  "tieba.publishing.words": {
    args: z.infer<typeof tiebaPublishingWordsSchema>;
    value: ContentKeyword[];
  };
  "tieba.publishing.resources": {
    args: z.infer<typeof tiebaPublishingQuerySchema>;
    value: TiebaPublishingResource[];
  };
  "tieba.publishing.save": Contract<z.infer<typeof tiebaPublishingSaveSchema>>;
  "tieba.publishing.submit": Contract<
    z.infer<typeof tiebaPublishingSubmitSchema>
  >;
  "tieba.publishing.reconcile": Contract<
    z.infer<typeof tiebaPublishingReconcileSchema>
  >;
}

import { z } from "zod";
import type { WebsiteAccount } from "./website-accounts";
import type { TiebaAutocareTarget } from "./tieba-autocare";
import type { RuntimeLogPage } from "./runtime-logs";

export interface TiebaThreadCandidate {
  threadId: string;
  forumId: string;
  forumName: string;
  title: string;
  url: string;
  authorUid: string | null;
  replyCount: number | null;
  lastActiveAt: string | null;
  discoveredAt: string;
}
export interface TiebaThreadContext {
  threadId: string;
  forumId: string;
  forumName: string;
  title: string;
  url: string;
  authorUid: string | null;
  body: string;
  replies: {
    postId: string;
    authorUid: string | null;
    authorName: string;
    text: string;
  }[];
  closed: boolean | null;
  canReply: boolean | null;
  truncated: boolean;
  incompleteReason?: string | null;
  checkedAt: string;
}
export interface TiebaReplyReceipt {
  status: "verified" | "uncertain" | "not_found";
  threadId: string;
  postId: string | null;
  url: string | null;
  authorUid: string | null;
  body: string | null;
  checkedAt: string;
  message: string;
}
export interface TiebaParticipationCandidate extends TiebaThreadCandidate {
  id: string;
  targetId: string;
  accountId: string;
  uid: string;
  status: "discovered" | "read" | "skipped";
  context: TiebaThreadContext | null;
  message: string;
  updatedAt: string;
}
export type TiebaReplyDraftStatus =
  | "generating"
  | "draft"
  | "ready"
  | "submitting"
  | "verified"
  | "uncertain"
  | "failed"
  | "skipped"
  | "attention";
export interface TiebaReplyDraft {
  id: string;
  candidateId: string;
  accountId: string;
  uid: string;
  threadId: string;
  title: string;
  url: string;
  version: number;
  status: TiebaReplyDraftStatus;
  body: string;
  evidence: string[];
  checks: string[];
  model: string | null;
  generationAttempts: number;
  submittedAt: string | null;
  receipt: TiebaReplyReceipt | null;
  message: string;
  createdAt: string;
  updatedAt: string;
}
export interface TiebaParticipationSnapshot {
  busy: boolean;
  accounts: WebsiteAccount[];
  targets: TiebaAutocareTarget[];
  candidates: TiebaParticipationCandidate[];
  drafts: TiebaReplyDraft[];
  logs: RuntimeLogPage;
  message: string;
}
const candidateId = z.string().regex(/^tiebacandidate_[\w-]+$/);
const draftId = z.string().regex(/^tiebareply_[\w-]+$/);
export const tiebaDiscoverSchema = z.object({
  targetId: z.string().regex(/^tiebatarget_[\w-]+$/),
});
export const tiebaReadThreadSchema = z.object({ candidateId });
export const tiebaGenerateReplySchema = z.object({
  candidateId,
  confirmed: z.literal(true),
});
export const tiebaSaveReplySchema = z.object({
  draftId,
  version: z.number().int().positive(),
  body: z.string().trim().min(20).max(800),
});
export const tiebaSubmitReplySchema = z.object({
  draftId,
  version: z.number().int().positive(),
  confirmed: z.literal(true),
});
export const tiebaReconcileReplySchema = z.object({ draftId });
type Contract<A> = { args: A; value: TiebaParticipationSnapshot };
export interface TiebaParticipationContract {
  "tieba.participation.snapshot": Contract<undefined>;
  "tieba.participation.discover": Contract<z.infer<typeof tiebaDiscoverSchema>>;
  "tieba.participation.read": Contract<z.infer<typeof tiebaReadThreadSchema>>;
  "tieba.participation.generate": Contract<
    z.infer<typeof tiebaGenerateReplySchema>
  >;
  "tieba.participation.save": Contract<z.infer<typeof tiebaSaveReplySchema>>;
  "tieba.participation.submit": Contract<
    z.infer<typeof tiebaSubmitReplySchema>
  >;
  "tieba.participation.reconcile": Contract<
    z.infer<typeof tiebaReconcileReplySchema>
  >;
}

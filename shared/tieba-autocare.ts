import { z } from "zod";
import {
  websiteAccountIdSchema,
  type WebsiteAccount,
} from "./website-accounts";
import type { RuntimeLogPage } from "./runtime-logs";
import { tiebaForumNameSchema } from "./tieba-forums";

export interface TiebaForumReading {
  forumId: string;
  name: string;
  url: string;
  level: number | null;
  experience: number | null;
  signed: boolean | null;
  canSign: boolean | null;
  message: string | null;
  checkedAt: string;
  /** Current verified account relationship, never inferred from a missing widget. */
  followed?: boolean | null;
  personalStatsMessage?: string | null;
  memberCount?: number | null;
  postCount?: number | null;
  threadCount?: number | null;
}
export interface TiebaForumFollowReceipt {
  status: "followed" | "uncertain";
  uid: string;
  reading: TiebaForumReading;
  checkedAt: string;
  message: string;
}
export interface TiebaFollowIntent {
  status: "submitting" | "uncertain" | "verified";
  submittedAt: string;
  checkedAt: string | null;
  message: string;
}
export interface TiebaAutocareTarget extends TiebaForumReading {
  /** Legacy targets came from the official followed list. */
  source?: "followed" | "observed";
  id: string;
  accountId: string;
  uid: string;
  paused: boolean;
  pauseReason: string | null;
  syncedAt: string;
  followIntent?: TiebaFollowIntent;
}
export const tiebaAutocareConfigSchema = z.object({
  targetIds: z
    .array(z.string().regex(/^tiebatarget_[\w-]+$/))
    .max(300)
    .transform((ids) => [...new Set(ids)]),
});
export type TiebaAutocareConfig = z.infer<typeof tiebaAutocareConfigSchema>;
export type TiebaAutocareTaskStatus =
  | "pending"
  | "running"
  | "submitting"
  | "verified"
  | "already_signed"
  | "uncertain"
  | "failed"
  | "skipped"
  | "expired"
  | "cancelled";
export interface TiebaAutocareTask {
  id: string;
  targetId: string;
  accountId: string;
  uid: string;
  forumId: string;
  forumName: string;
  action: "checkin";
  day: string;
  status: TiebaAutocareTaskStatus;
  plannedAt: string;
  deadlineAt: string;
  startedAt: string | null;
  submittedAt: string | null;
  checkedAt: string | null;
  message: string;
  configRevision: number;
  createdAt: string;
  updatedAt: string;
}
export interface TiebaAutocareRun {
  id: string;
  day: string;
  startedAt: string;
  deadlineAt: string;
  status: "running" | "ended" | "stopped";
}
export interface TiebaAutocareSnapshot {
  addition?: {
    accountId: string;
    items: {
      name: string;
      targetId?: string;
      status: "followed" | "uncertain" | "failed";
      message: string;
    }[];
  };
  /** Feedback from one explicit follow/reconciliation request; the intent also persists on its target. */
  followResult?: {
    targetId: string;
    status: "followed" | "uncertain" | "failed";
    message: string;
  };
  /** One explicit observation request only; never persists or authorizes actions. */
  observation?: {
    accountId: string;
    succeeded: string[];
    failed: { name: string; message: string }[];
  };
  revision: number;
  enabled: boolean;
  busy: boolean;
  config: TiebaAutocareConfig;
  run: TiebaAutocareRun | null;
  accounts: WebsiteAccount[];
  targets: TiebaAutocareTarget[];
  tasks: TiebaAutocareTask[];
  logs: RuntimeLogPage;
  message: string;
}
export const tiebaAutocareSaveSchema = z.object({
  config: tiebaAutocareConfigSchema,
  revision: z.number().int().positive(),
});
export const tiebaAutocareToggleSchema = z.object({
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  confirmed: z.literal(true),
});
export const tiebaAutocareSyncSchema = z.object({
  accountId: websiteAccountIdSchema,
});
export const tiebaAutocareObserveSchema = z.object({
  accountId: websiteAccountIdSchema,
  forumNames: z
    .array(tiebaForumNameSchema)
    .min(1, "请选择至少一个观察吧")
    .max(5, "一次最多添加5个观察吧")
    .transform((names) => [...new Set(names)]),
});
export const tiebaAutocareAddSchema = z.object({
  accountId: websiteAccountIdSchema,
  forumNames: z
    .array(tiebaForumNameSchema)
    .min(1, "请选择至少一个贴吧")
    .max(5, "一次最多添加5个贴吧")
    .transform((names) => {
      const seen = new Set<string>();
      return names.filter((name) => {
        const key = name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }),
  revision: z.number().int().positive(),
  confirmed: z.literal(true),
});
export const tiebaAutocarePauseSchema = z.object({
  targetId: z.string().regex(/^tiebatarget_[\w-]+$/),
  paused: z.boolean(),
  revision: z.number().int().positive(),
});
export const tiebaAutocareReconcileSchema = z.object({
  taskId: z.string().regex(/^tiebatask_[\w-]+$/),
});
export const tiebaAutocareFollowSchema = z.object({
  targetId: z.string().regex(/^tiebatarget_[\w-]+$/),
  revision: z.number().int().positive(),
  confirmed: z.literal(true),
});
type Contract<A> = { args: A; value: TiebaAutocareSnapshot };
export interface TiebaAutocareContract {
  "tieba.autocare.snapshot": Contract<undefined>;
  "tieba.autocare.save": Contract<z.infer<typeof tiebaAutocareSaveSchema>>;
  "tieba.autocare.sync": Contract<z.infer<typeof tiebaAutocareSyncSchema>>;
  "tieba.autocare.observe": Contract<
    z.infer<typeof tiebaAutocareObserveSchema>
  >;
  "tieba.autocare.add": Contract<z.infer<typeof tiebaAutocareAddSchema>>;
  "tieba.autocare.follow": Contract<z.infer<typeof tiebaAutocareFollowSchema>>;
  "tieba.autocare.toggle": Contract<z.infer<typeof tiebaAutocareToggleSchema>>;
  "tieba.autocare.pause": Contract<z.infer<typeof tiebaAutocarePauseSchema>>;
  "tieba.autocare.reconcile": Contract<
    z.infer<typeof tiebaAutocareReconcileSchema>
  >;
}

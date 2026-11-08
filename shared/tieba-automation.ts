import { z } from "zod";
import type { WebsiteAccount } from "./website-accounts";
import type { TiebaAutocareTarget } from "./tieba-autocare";
import type { RuntimeLogPage } from "./runtime-logs";

export const tiebaAutomationConfigSchema = z.object({
  targetIds: z
    .array(z.string().regex(/^tiebatarget_[\w-]+$/))
    .max(300)
    .transform((ids) => [...new Set(ids)]),
  mode: z.enum(["draft", "publish"]).default("draft"),
  /** Total prepared threads per day, across all selected forums and accounts. */
  dailyLimit: z.number().int().min(1).max(2).default(1),
});
export type TiebaAutomationConfig = z.infer<typeof tiebaAutomationConfigSchema>;
export const tiebaAutomationRecommended: TiebaAutomationConfig = {
  targetIds: [],
  mode: "draft",
  dailyLimit: 1,
};
export type TiebaAutomationStep =
  "discover" | "read" | "generate" | "submit" | "done";
export type TiebaAutomationStatus =
  | "pending"
  | "running"
  | "draft"
  | "verified"
  | "uncertain"
  | "attention"
  | "skipped"
  | "failed"
  | "expired"
  | "cancelled";
export interface TiebaAutomationRun {
  id: string;
  day: string;
  startedAt: string;
  deadlineAt: string;
  status: "running" | "ended" | "stopped";
}
export interface TiebaAutomationTask {
  id: string;
  runId: string;
  day: string;
  targetId: string;
  accountId: string;
  uid: string;
  forumId: string;
  forumName: string;
  mode: TiebaAutomationConfig["mode"];
  configRevision: number;
  step: TiebaAutomationStep;
  status: TiebaAutomationStatus;
  candidateId: string | null;
  draftId: string | null;
  draftVersion: number | null;
  plannedAt: string;
  deadlineAt: string;
  startedAt: string | null;
  createdAt: string;
  updatedAt: string;
  message: string;
}
export interface TiebaAutomationSnapshot {
  revision: number;
  enabled: boolean;
  busy: boolean;
  config: TiebaAutomationConfig;
  run: TiebaAutomationRun | null;
  accounts: WebsiteAccount[];
  targets: TiebaAutocareTarget[];
  tasks: TiebaAutomationTask[];
  logs: RuntimeLogPage;
  message: string;
}
export const tiebaAutomationSaveSchema = z.object({
  config: tiebaAutomationConfigSchema,
  revision: z.number().int().positive(),
});
export const tiebaAutomationToggleSchema = z.object({
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  /** A fresh explicit authorization; never persisted in a renderer form. */
  confirmed: z.literal(true),
});
export const tiebaAutomationReconcileSchema = z.object({
  taskId: z.string().regex(/^tiebaauto_[\w-]+$/),
});
type Contract<A> = { args: A; value: TiebaAutomationSnapshot };
export interface TiebaAutomationContract {
  "tieba.automation.snapshot": Contract<undefined>;
  "tieba.automation.save": Contract<z.infer<typeof tiebaAutomationSaveSchema>>;
  "tieba.automation.toggle": Contract<
    z.infer<typeof tiebaAutomationToggleSchema>
  >;
  "tieba.automation.reconcile": Contract<
    z.infer<typeof tiebaAutomationReconcileSchema>
  >;
}

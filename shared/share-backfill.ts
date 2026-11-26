import type { RuntimeLogEntry } from "./runtime-logs";

export interface ShareBackfillScope {
  accountId: string;
  category?: string;
}

export interface ShareBackfillPreview {
  existing: number;
  pending: number;
  unavailable: number;
}

export interface ShareBackfillRun {
  id: string;
  status: "running" | "pausing" | "paused" | "blocked" | "completed";
  category?: string;
  total: number;
  pending: number;
  reused: number;
  created: number;
  failed: number;
  message: string;
  nextCreateAt: number | null;
  current: { title: string; state: "checking" | "sending" | "uncertain"; canConfirmAbsent: boolean } | null;
  logs: RuntimeLogEntry[];
}

export interface ShareBackfillContract {
  "shareBackfill.preview": { args: ShareBackfillScope; value: ShareBackfillPreview };
  "shareBackfill.run": { args: { accountId: string }; value: ShareBackfillRun | null };
  "shareBackfill.start": { args: ShareBackfillScope & { confirmed: true }; value: ShareBackfillRun };
  "shareBackfill.pause": { args: { runId: string }; value: ShareBackfillRun };
  "shareBackfill.resume": { args: { runId: string }; value: ShareBackfillRun };
  "shareBackfill.recheck": { args: { runId: string }; value: ShareBackfillRun };
  "shareBackfill.confirmAbsent": { args: { runId: string }; value: ShareBackfillRun };
}

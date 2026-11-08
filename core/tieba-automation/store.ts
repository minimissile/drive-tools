import type { Database } from "../database";
import type { EnvironmentStamp } from "../../shared/browser-environments";
import type {
  TiebaAutomationConfig,
  TiebaAutomationRun,
  TiebaAutomationTask,
} from "../../shared/tieba-automation";
import { tiebaAutomationRecommended } from "../../shared/tieba-automation";

export interface AutomationAuthority {
  targetId: string;
  accountId: string;
  uid: string;
  forumId: string;
  stamp: EnvironmentStamp;
}
export interface AutomationTaskRecord extends TiebaAutomationTask {
  stamp: EnvironmentStamp;
}
export interface AutomationState {
  revision: number;
  enabled: boolean;
  config: TiebaAutomationConfig;
  run: TiebaAutomationRun | null;
  authorities: AutomationAuthority[];
}
export class TiebaAutomationStore {
  constructor(private db: Database) {}
  state(): AutomationState {
    return this.db.setting("tiebaAutomation:v1", {
      revision: 1,
      enabled: false,
      config: structuredClone(tiebaAutomationRecommended),
      run: null,
      authorities: [],
    });
  }
  saveState(state: AutomationState) {
    this.db.setSetting("tiebaAutomation:v1", state);
  }
  tasks(): AutomationTaskRecord[] {
    return this.db
      .all<{ data: string }>(
        "SELECT data FROM tieba_automation_tasks ORDER BY rowid DESC",
      )
      .map((row) => JSON.parse(row.data));
  }
  task(id: string): AutomationTaskRecord | undefined {
    const row = this.db.get<{ data: string }>(
      "SELECT data FROM tieba_automation_tasks WHERE id=?",
      id,
    );
    return row ? JSON.parse(row.data) : undefined;
  }
  saveTask(task: AutomationTaskRecord) {
    this.db.run(
      "INSERT INTO tieba_automation_tasks(id,run_id,day,status,planned_at,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,planned_at=excluded.planned_at,data=excluded.data",
      task.id,
      task.runId,
      task.day,
      task.status,
      task.plannedAt,
      JSON.stringify(task),
    );
  }
}

/** Restore never restores execution authority or replays a partially executed step. */
export function stopTiebaAutomationForBackup(db: Database) {
  const store = new TiebaAutomationStore(db),
    state = store.state();
  state.enabled = false;
  state.authorities = [];
  state.revision++;
  if (state.run) state.run.status = "stopped";
  store.saveState(state);
  const exists = db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='tieba_automation_tasks'",
  );
  if (!exists) return;
  for (const task of store.tasks()) {
    if (!["pending", "running"].includes(task.status)) continue;
    const row = task.draftId
      ? db.get<{ data: string }>(
          "SELECT data FROM tieba_reply_drafts WHERE id=?",
          task.draftId,
        )
      : task.candidateId
        ? db.get<{ data: string }>(
            "SELECT data FROM tieba_reply_drafts WHERE candidate_id=? AND uid=?",
            task.candidateId,
            task.uid,
          )
        : undefined;
    const draft = row
      ? (JSON.parse(row.data) as {
          id: string;
          version: number;
          status: string;
          submittedAt: string | null;
        })
      : undefined;
    if (draft) {
      task.draftId = draft.id;
      task.draftVersion = draft.version;
    }
    task.status =
      draft?.status === "verified"
        ? "verified"
        : draft?.submittedAt
          ? "uncertain"
          : (draft && ["generating", "attention"].includes(draft.status)) ||
              (!draft && task.status === "running" && task.step === "generate")
            ? "attention"
            : draft
              ? "draft"
              : "cancelled";
    task.message =
      "备份恢复已撤销自动执行授权；已发生请求保留原记录，不能自动重放。";
    task.updatedAt = new Date().toISOString();
    store.saveTask(task);
  }
}

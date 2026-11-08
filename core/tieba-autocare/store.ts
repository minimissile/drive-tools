import { Database } from "../database";
import { recordTiebaMetric } from "../tieba-insights/metrics";
import type { EnvironmentStamp } from "../../shared/browser-environments";
import type {
  TiebaAutocareConfig,
  TiebaAutocareRun,
  TiebaAutocareTarget,
  TiebaAutocareTask,
} from "../../shared/tieba-autocare";

export interface TargetRecord extends TiebaAutocareTarget {
  stamp: EnvironmentStamp;
}
export interface TaskRecord extends TiebaAutocareTask {
  stamp: EnvironmentStamp;
  configSnapshot: TiebaAutocareConfig;
}
export interface AutocareState {
  revision: number;
  enabled: boolean;
  config: TiebaAutocareConfig;
  run: TiebaAutocareRun | null;
  authorities: { targetId: string; uid: string; stamp: EnvironmentStamp }[];
}
const key = "tiebaAutocare:v1";
export class TiebaAutocareStore {
  constructor(private db: Database) {}
  state(): AutocareState {
    return this.db.setting(key, {
      revision: 1,
      enabled: false,
      config: { targetIds: [] },
      run: null,
      authorities: [],
    });
  }
  saveState(state: AutocareState) {
    this.db.setSetting(key, state);
  }
  targets(): TargetRecord[] {
    return this.db
      .all<{ data: string }>(
        "SELECT data FROM tieba_autocare_targets ORDER BY rowid",
      )
      .map((row) => JSON.parse(row.data));
  }
  target(id: string) {
    return this.targets().find((target) => target.id === id);
  }
  saveTarget(target: TargetRecord) {
    this.db.run(
      "INSERT INTO tieba_autocare_targets(id,account_id,uid,forum_id,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      target.id,
      target.accountId,
      target.uid,
      target.forumId,
      JSON.stringify(target),
    );
    recordTiebaMetric(this.db, target);
  }
  tasks(): TaskRecord[] {
    return this.db
      .all<{ data: string }>(
        "SELECT data FROM tieba_autocare_tasks ORDER BY rowid DESC",
      )
      .map((row) => JSON.parse(row.data));
  }
  task(id: string) {
    const row = this.db.get<{ data: string }>(
      "SELECT data FROM tieba_autocare_tasks WHERE id=?",
      id,
    );
    return row ? (JSON.parse(row.data) as TaskRecord) : undefined;
  }
  saveTask(task: TaskRecord) {
    this.db.run(
      "INSERT INTO tieba_autocare_tasks(id,target_id,uid,forum_id,day,action,status,planned_at,deadline_at,submitted_at,data) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,planned_at=excluded.planned_at,deadline_at=excluded.deadline_at,submitted_at=excluded.submitted_at,data=excluded.data",
      task.id,
      task.targetId,
      task.uid,
      task.forumId,
      task.day,
      task.action,
      task.status,
      task.plannedAt,
      task.deadlineAt,
      task.submittedAt,
      JSON.stringify(task),
    );
  }
  claim(task: TaskRecord) {
    return (
      this.db.run(
        "UPDATE tieba_autocare_tasks SET status=?,data=? WHERE id=? AND status='pending'",
        task.status,
        JSON.stringify(task),
        task.id,
      ).changes === 1
    );
  }
}

/** Read-only shared gate for explicit follow mutations, including unresolved receipts. */
export function tiebaFollowWriteState(
  db: Database,
  uid: string,
  excludeTargetId = "",
) {
  const targets = new TiebaAutocareStore(db)
    .targets()
    .filter((target) => target.id !== excludeTargetId && target.followIntent);
  return {
    uncertain: targets.some(
      (target) =>
        target.uid === uid &&
        ["submitting", "uncertain"].includes(target.followIntent!.status),
    ),
    lastMutationAt:
      targets
        .map((target) => target.followIntent!.submittedAt)
        .sort()
        .at(-1) ?? null,
  };
}

/** Operates on a backup/restore database, never the user's running service. */
export function stopTiebaAutocareForBackup(db: Database) {
  const store = new TiebaAutocareStore(db),
    state = store.state();
  state.enabled = false;
  state.authorities = [];
  state.revision++;
  if (state.run) state.run.status = "stopped";
  store.saveState(state);
  if (
    !db.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tieba_autocare_tasks'",
    )
  )
    return;
  for (const task of store.tasks()) {
    if (
      task.status === "submitting" ||
      (task.status === "running" && task.submittedAt)
    ) {
      task.status = "uncertain";
      task.message = "备份中的签到可能已提交，保留原记录，仅可核对结果。";
    } else if (
      ["pending", "running"].includes(task.status) &&
      !task.submittedAt
    ) {
      task.status = "cancelled";
      task.message = "备份与恢复不继承自动签到授权，未提交任务已取消。";
    } else continue;
    task.updatedAt = new Date().toISOString();
    store.saveTask(task);
  }
}

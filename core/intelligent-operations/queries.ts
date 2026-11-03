import type { Database } from "../database";
import {
  operationsTaskQuery,
  operationsLogQuery,
  type OperationsTask,
  type OperationsTaskPage,
} from "../../shared/intelligent-operations";
import { operationalDay } from "./policy";

export function queryOperationsTasks(
  source: OperationsTask[],
  time: number,
  raw: unknown = {},
): OperationsTaskPage {
  const q = operationsTaskQuery.parse(raw),
    today = operationalDay(time),
    end = time + 7 * 86400000;
  const start = Date.parse(`${today}T00:00:00+08:00`);
  const items = source
    .filter(
      (t) =>
        (!q.planId || t.planId === q.planId) &&
        (!q.accountId || t.accountId === q.accountId) &&
        (q.kind === "all" || t.kind === q.kind) &&
        (q.channel === "all" || t.channel === q.channel) &&
        (q.status === "all" || t.status === q.status) &&
        (q.horizon === "all" ||
          !t.scheduledAt ||
          (q.horizon === "today"
            ? operationalDay(t.scheduledAt) === today
            : Date.parse(t.scheduledAt) >= start &&
              Date.parse(t.scheduledAt) < end)),
    )
    .sort(
      (a, b) =>
        (a.scheduledAt ?? "9999").localeCompare(b.scheduledAt ?? "9999") ||
        b.createdAt.localeCompare(a.createdAt),
    );
  const pageSize = 30,
    page = Math.min(q.page, Math.max(1, Math.ceil(items.length / pageSize)));
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    total: items.length,
    page,
    pageSize,
  };
}

export function queryOperationsLogs(
  db: Database,
  folder: string,
  raw: unknown = {},
) {
  const q = operationsLogQuery.parse(raw),
    conditions = ["domain=?"],
    values: (string | number)[] = ["intelligent-operations"];
  if (q.planId) {
    conditions.push("json_extract(details,'$.planId')=?");
    values.push(q.planId);
  }
  if (q.level !== "all") {
    conditions.push("level=?");
    values.push(q.level);
  }
  const where = conditions.join(" AND "),
    total = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM runtime_logs WHERE ${where}`,
      ...values,
    )!.n,
    pageSize = 50,
    page = Math.min(q.page, Math.max(1, Math.ceil(total / pageSize)));
  const rows = db.all<{
    id: number;
    domain: string;
    level: "info" | "warning" | "error";
    event: string;
    message: string;
    account_id: string | null;
    task_id: string | null;
    details: string;
    created_at: string;
  }>(
    `SELECT * FROM runtime_logs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...values,
    pageSize,
    (page - 1) * pageSize,
  );
  return {
    items: rows.map((r) => ({
      id: r.id,
      domain: r.domain,
      level: r.level,
      event: r.event,
      message: r.message,
      accountId: r.account_id,
      taskId: r.task_id,
      details: JSON.parse(r.details),
      createdAt: r.created_at,
    })),
    total,
    page,
    pageSize,
    folder: folder,
  };
}

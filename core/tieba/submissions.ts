import type { Database } from "../database";

/** One identity's latest durable mutation; other accounts have independent clocks. */
export function latestTiebaSubmission(
  db: Database,
  uid: string,
  exclude: { checkin?: string; topic?: string } = {},
) {
  const tables = [
    ["tieba_autocare_tasks", exclude.checkin ?? ""],
    ["tieba_reply_drafts", ""],
    ["tieba_topic_drafts", exclude.topic ?? ""],
  ] as const;
  const queries: string[] = [],
    values: string[] = [];
  for (const [table, id] of tables) {
    if (
      !db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        table,
      )
    )
      continue;
    queries.push(
      `SELECT submitted_at at FROM ${table} WHERE uid=? AND id<>? AND submitted_at IS NOT NULL`,
    );
    values.push(uid, id);
  }
  return queries.length
    ? (db.get<{ at: string | null }>(
        `SELECT MAX(at) at FROM (${queries.join(" UNION ALL ")})`,
        ...values,
      )?.at ?? null)
    : null;
}

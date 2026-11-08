import type { Database } from "../database";
import type { TiebaAutocareTarget } from "../../shared/tieba-autocare";
import type { TiebaMetricPoint } from "../../shared/tieba-insights";

export function recordTiebaMetric(db: Database, target: TiebaAutocareTarget) {
  if (!Number.isFinite(Date.parse(target.checkedAt))) return;
  // Old isolated fixtures can still contain only the original domain tables.
  if (
    !db.get("SELECT name FROM sqlite_master WHERE name='tieba_forum_metrics'")
  )
    return;
  const point: TiebaMetricPoint = {
    checkedAt: target.checkedAt,
    level: target.level,
    experience: target.experience,
  };
  db.run(
    "INSERT INTO tieba_forum_metrics(target_id,account_id,uid,forum_id,checked_at,data) VALUES(?,?,?,?,?,?) ON CONFLICT(uid,forum_id,checked_at) DO UPDATE SET data=excluded.data",
    target.id,
    target.accountId,
    target.uid,
    target.forumId,
    target.checkedAt,
    JSON.stringify(point),
  );
}

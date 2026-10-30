import { now, type Database } from "./database";
import type { Resource, ResourceCopy } from "../shared/types";

/** Local cleanup only. Callers validate references and own the surrounding transaction. */
export function removeResourceRecords(
  db: Database,
  resource: Resource,
  copies: ResourceCopy[] = resource.copies,
) {
  const wholeResource = copies.length === resource.copies.length;
  if (wholeResource) {
    db.run(
      "UPDATE pools SET resource_id=NULL WHERE resource_id=?",
      resource.id,
    );
    db.run(
      "UPDATE distribution_task_sources SET active=0 WHERE resource_id=?",
      resource.id,
    );
    db.run(
      "UPDATE distribution_tasks SET status='skipped',message='资源已从本地资源库删除，未继续投稿。',updated_at=? WHERE status IN ('ready','blocked','waiting_login','waiting_rules','verifying') AND resource_id=? AND NOT EXISTS(SELECT 1 FROM distribution_task_sources s WHERE s.task_id=distribution_tasks.id AND s.active=1)",
      now(),
      resource.id,
    );
  }
  for (const copy of copies) {
    db.run(
      "UPDATE search_topics SET copy_id=NULL,split_item_id=NULL,archived=1,updated_at=? WHERE copy_id=? OR split_item_id IN (SELECT id FROM split_items WHERE copy_id=?)",
      now(),
      copy.id,
      copy.id,
    );
    db.run(
      "UPDATE distribution_task_sources SET active=0 WHERE copy_id=?",
      copy.id,
    );
    db.run(
      "UPDATE distribution_tasks SET status='skipped',message='资源副本已从本地资源库删除，未继续投稿。',updated_at=? WHERE status IN ('ready','blocked','waiting_login','waiting_rules','verifying') AND copy_id=? AND NOT EXISTS(SELECT 1 FROM distribution_task_sources s WHERE s.task_id=distribution_tasks.id AND s.active=1)",
      now(),
      copy.id,
    );
    for (const draft of db.all<{ id: string }>(
      "SELECT id FROM drafts WHERE copy_id=?",
      copy.id,
    )) {
      db.run("DELETE FROM studio_jobs WHERE draft_id=?", draft.id);
      db.run("DELETE FROM studio_packages WHERE draft_id=?", draft.id);
      db.run("DELETE FROM settings WHERE key=?", `studio:working:${draft.id}`);
    }
    db.run("DELETE FROM drafts WHERE copy_id=?", copy.id);
    for (const item of db.all<{ id: string }>(
      "SELECT id FROM split_items WHERE copy_id=?",
      copy.id,
    ))
      db.run("DELETE FROM secrets WHERE key=?", `split:${item.id}`);
    db.run(
      "DELETE FROM split_run_items WHERE run_id IN (SELECT id FROM split_runs WHERE copy_id=?) OR item_id IN (SELECT id FROM split_items WHERE copy_id=?)",
      copy.id,
      copy.id,
    );
    db.run("DELETE FROM split_runs WHERE copy_id=?", copy.id);
    db.run("DELETE FROM split_items WHERE copy_id=?", copy.id);
    db.run("DELETE FROM transfer_batch_items WHERE copy_id=?", copy.id);
    db.run("DELETE FROM outbox WHERE copy_id=?", copy.id);
    db.run("DELETE FROM note_exports WHERE copy_id=?", copy.id);
    db.run("DELETE FROM share_checks WHERE copy_id=?", copy.id);
    db.run("DELETE FROM jobs WHERE copy_id=?", copy.id);
    db.run("DELETE FROM secrets WHERE key=?", `share:${copy.id}`);
    db.run(
      "DELETE FROM settings WHERE key=?",
      `share-creation-latest:${copy.id}`,
    );
    db.run("DELETE FROM copies WHERE id=?", copy.id);
  }
  if (wholeResource) {
    db.run("DELETE FROM secrets WHERE key=?", `source:${resource.id}`);
    const fixed = db.get<{ id: string }>(
      "SELECT id FROM resource_links WHERE resource_id=?",
      resource.id,
    );
    if (fixed)
      db.run(
        "DELETE FROM secrets WHERE key IN (?,?)",
        `resource-links:code:${fixed.id}`,
        `resource-links:operation:${fixed.id}`,
      );
    db.run("DELETE FROM resources WHERE id=?", resource.id);
  }
}

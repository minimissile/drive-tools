import { id, now } from "./database";
import type { Database } from "./database";
import type { Draft } from "../shared/types";

export function recordEditorOpened(
  db: Database,
  draft: Draft,
  bindingId: string,
  once = false,
) {
  if (
    once &&
    db.get(
      "SELECT id FROM publications WHERE draft_id=? AND draft_version=? AND binding_id=? AND status='opened'",
      draft.id,
      draft.version,
      bindingId,
    )
  )
    return;
  db.run(
    "INSERT INTO publications(id,draft_id,draft_version,binding_id,status,created_at) VALUES(?,?,?,?,?,?)",
    id("pub"),
    draft.id,
    draft.version,
    bindingId,
    "opened",
    now(),
  );
}

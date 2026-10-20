export type TaskFilter = "attention" | "active" | "completed" | "all";
export function taskGroup(
  stage: string,
): Exclude<TaskFilter, "all"> | "cancelled" {
  if (["failed", "needs_review", "waiting_login"].includes(stage))
    return "attention";
  if (stage === "completed") return "completed";
  if (stage === "cancelled") return "cancelled";
  return "active";
}

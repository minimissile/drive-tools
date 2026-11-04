import type { RuntimeLogEntry } from "../../shared/runtime-logs";
import { formatTime } from "./format";

export function formatRuntimeLogs(
  items: RuntimeLogEntry[],
  context: (entry: RuntimeLogEntry) => string,
) {
  return [...items]
    .reverse()
    .map(
      (entry) =>
        `[${formatTime(entry.createdAt)}] [${entry.level.toUpperCase()}] [${context(entry)}] ${entry.event} ${entry.message}${entry.taskId ? ` · ${entry.taskId}` : ""}\n${JSON.stringify(entry.details)}`,
    )
    .join("\n");
}

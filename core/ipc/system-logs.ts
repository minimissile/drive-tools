import { systemLogQuery } from "../../shared/system-logs";
import type { HandlerMap, HandlerServices } from "./types";

export function createSystemLogHandlers({
  systemLogs,
}: Pick<HandlerServices, "systemLogs">) {
  return {
    "systemLogs.list": (raw) => systemLogs.read(systemLogQuery.parse(raw)),
  } satisfies HandlerMap;
}

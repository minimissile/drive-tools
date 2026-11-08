import { useLayoutEffect, useRef } from "react";
import type { RuntimeLogEntry } from "../../shared/runtime-logs";
import { formatTime } from "../lib/format";
import "./log-window.css";

/** Read-only log presentation. Filtering, transport and clipboard belong to callers. */
export function LogWindow({
  items,
  label,
  context,
  follow,
  onFollowChange,
  simple = false,
  formatMessage,
}: {
  items: RuntimeLogEntry[];
  label: string;
  context(entry: RuntimeLogEntry): string;
  follow: boolean;
  onFollowChange(value: boolean): void;
  simple?: boolean;
  formatMessage?(entry: RuntimeLogEntry): string;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = viewport.current;
    const selection = window.getSelection();
    if (
      !element ||
      !follow ||
      (selection &&
        !selection.isCollapsed &&
        selection.anchorNode &&
        element.contains(selection.anchorNode))
    )
      return;
    element.scrollTop = element.scrollHeight;
  }, [items, follow]);
  return (
    <div className={`log-window${simple ? " log-window-simple" : ""}`}>
      <div className="log-window-columns" aria-hidden="true">
        <span>时间</span>
        <span>{simple ? "状态" : "级别"}</span>
        <span>{simple ? "账号 · 运行情况" : "账号 · 事件 · 消息"}</span>
      </div>
      <div
        className="log-window-viewport"
        ref={viewport}
        role="log"
        aria-label={label}
        aria-live="off"
        tabIndex={0}
        onScroll={(event) => {
          const e = event.currentTarget;
          if (follow && e.scrollHeight - e.clientHeight - e.scrollTop > 24)
            onFollowChange(false);
        }}
      >
        <ol className="log-window-lines">
          {[...items].reverse().map((entry) => (
            <li
              key={entry.id}
              className="log-window-line"
              data-level={entry.level}
            >
              <time dateTime={entry.createdAt}>
                {simple
                  ? new Date(entry.createdAt).toLocaleString("zh-CN", {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                      hour12: false,
                      timeZone: "Asia/Shanghai",
                    })
                  : formatTime(entry.createdAt)}
              </time>
              <span className="log-window-level">
                {entry.level === "error"
                  ? simple
                    ? "异常"
                    : "ERROR"
                  : entry.level === "warning"
                    ? simple
                      ? "提醒"
                      : "WARN"
                    : simple
                      ? "进展"
                      : "INFO"}
              </span>
              <div className="log-window-content">
                <div className="log-window-context">
                  <span>{context(entry)}</span>
                  {!simple ? <code>{entry.event}</code> : null}
                </div>
                <p>{formatMessage ? formatMessage(entry) : entry.message}</p>
                {!simple &&
                (Object.keys(entry.details).length || entry.taskId) ? (
                  <details
                    onToggle={(e) => {
                      if (e.currentTarget.open) onFollowChange(false);
                    }}
                  >
                    <summary>
                      {entry.taskId ? `任务 ${entry.taskId}` : "查看详情"}
                    </summary>
                    <pre>
                      {JSON.stringify(
                        {
                          ...entry.details,
                          ...(entry.taskId ? { taskId: entry.taskId } : {}),
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

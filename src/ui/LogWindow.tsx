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
}: {
  items: RuntimeLogEntry[];
  label: string;
  context(entry: RuntimeLogEntry): string;
  follow: boolean;
  onFollowChange(value: boolean): void;
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
    <div className="log-window">
      <div className="log-window-columns" aria-hidden="true">
        <span>时间</span>
        <span>级别</span>
        <span>账号 · 事件 · 消息</span>
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
                {formatTime(entry.createdAt)}
              </time>
              <span className="log-window-level">
                {entry.level === "error"
                  ? "ERROR"
                  : entry.level === "warning"
                    ? "WARN"
                    : "INFO"}
              </span>
              <div className="log-window-content">
                <div className="log-window-context">
                  <span>{context(entry)}</span>
                  <code>{entry.event}</code>
                </div>
                <p>{entry.message}</p>
                {Object.keys(entry.details).length || entry.taskId ? (
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

import { useEffect, useRef, type ReactNode } from "react";
import { useTaskFocus } from "./TaskFocus";
import type { Job } from "../../shared/types";
export function TaskSection({
  job,
  children,
}: {
  job: Job;
  children: ReactNode;
}) {
  const node = useRef<HTMLDivElement>(null);
  const { focus, consume } = useTaskFocus();
  useEffect(() => {
    if (focus?.kind !== "job" || focus.id !== job.id) return;
    node.current?.scrollIntoView({ block: "center" });
    node.current?.focus({ preventScroll: true });
    consume();
  }, [focus, job.id, consume]);
  return (
    <div ref={node} tabIndex={-1} data-task-id={job.id}>
      {job.stage === "completed" ? (
        <details className="completed-task">
          <summary>
            <strong>{job.title}</strong>
            <span>已完成 · 展开详情</span>
          </summary>
          {children}
        </details>
      ) : (
        children
      )}
    </div>
  );
}

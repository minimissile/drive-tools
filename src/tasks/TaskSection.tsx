import type { ReactNode } from "react";
import type { Job } from "../../shared/types";
export function TaskSection({
  job,
  children,
}: {
  job: Job;
  children: ReactNode;
}) {
  return job.stage === "completed" ? (
    <details className="completed-task">
      <summary>
        <strong>{job.title}</strong>
        <span>已完成 · 展开详情</span>
      </summary>
      {children}
    </details>
  ) : (
    children
  );
}

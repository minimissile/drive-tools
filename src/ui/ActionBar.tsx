import type { ReactNode } from "react";
import "./action-bar.css";

/** For long, single-task forms. Status and actions remain in the same scrolling context. */
export function ActionBar({
  label,
  status,
  children,
}: {
  label: string;
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <footer className="page-actions" role="group" aria-label={label}>
      {status ? (
        <div className="page-action-status" role="status">
          {status}
        </div>
      ) : null}
      <div className="actions">{children}</div>
    </footer>
  );
}

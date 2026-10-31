import {
  AlertCircle,
  Folder,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import "./data-state.css";

type StateKind = "empty" | "loading" | "error";

/** A read region's state; the caller owns its data, recovery and business actions. */
export function DataState({
  kind,
  title,
  children,
  action,
  compact = false,
  fill = false,
  className = "",
  icon,
}: {
  kind: StateKind;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  fill?: boolean;
  className?: string;
  icon?: LucideIcon;
}) {
  const Icon =
    icon ??
    (kind === "loading"
      ? LoaderCircle
      : kind === "error"
        ? AlertCircle
        : Folder);
  return (
    <div
      className={`data-state data-state--${kind} ${compact ? "data-state--compact" : ""} ${className}`}
      data-fill={fill || undefined}
      role={
        kind === "error" ? "alert" : kind === "loading" ? "status" : undefined
      }
      aria-live={kind === "loading" ? "polite" : undefined}
      aria-atomic={kind === "loading" ? true : undefined}
    >
      <span className="data-state-symbol" aria-hidden="true">
        <Icon
          size={compact ? 17 : 22}
          className={kind === "loading" ? "spin" : undefined}
        />
      </span>
      <div className="data-state-copy">
        <h3>{title}</h3>
        {children ? <p>{children}</p> : null}
      </div>
      {action ? <div className="data-state-action">{action}</div> : null}
    </div>
  );
}

/** Quiet inline feedback for toolbars and retained content during a refresh. */
export function Loading({
  label = "正在处理…",
  announce = true,
}: {
  label?: string;
  announce?: boolean;
}) {
  return (
    <span
      className="loading"
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
      aria-atomic={announce ? true : undefined}
    >
      <LoaderCircle size={15} className="spin" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

/** Reserve the result region instead of leaving a bare loading sentence at its edge. */
export function LoadingState({
  label = "正在读取数据…",
  children,
  compact = false,
  fill = false,
  layout = "panel",
}: {
  label?: string;
  children?: ReactNode;
  compact?: boolean;
  fill?: boolean;
  layout?: "panel" | "list";
}) {
  if (layout === "list")
    return (
      <div
        className="data-loading-list"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-fill={fill || undefined}
      >
        <Loading label={label} announce={false} />
        <div className="data-skeleton-list" aria-hidden="true">
          {[0, 1, 2, 3].map((row) => (
            <div className="data-skeleton-row" key={row}>
              <span className="data-skeleton-icon" />
              <span className="data-skeleton-copy">
                <span />
                <span />
                <span />
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  return (
    <DataState kind="loading" title={label} compact={compact} fill={fill}>
      {children}
    </DataState>
  );
}

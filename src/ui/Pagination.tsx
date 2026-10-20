import "./pagination.css";
import type { ReactNode } from "react";
import { Button } from "./primitives";

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  disabled = false,
  label,
  previousLabel = "上一页",
  nextLabel = "下一页",
  className = "pagination",
  children,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange(page: number): void;
  disabled?: boolean;
  label: string;
  previousLabel?: string;
  nextLabel?: string;
  className?: string;
  children?: ReactNode;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav
      className={`row spread ${className}`}
      data-single-page={pages === 1 || undefined}
      aria-label={label}
    >
      {pages > 1 ? (
        <Button
          size="compact"
          disabled={disabled || page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          {previousLabel}
        </Button>
      ) : null}
      <small aria-live="polite">
        {children ?? `第 ${page} / ${pages} 页 · 共 ${total} 项`}
      </small>
      {pages > 1 ? (
        <Button
          size="compact"
          disabled={disabled || page >= pages}
          onClick={() => onPageChange(page + 1)}
        >
          {nextLabel}
        </Button>
      ) : null}
    </nav>
  );
}

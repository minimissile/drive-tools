import "./pagination.css";
import type { ReactNode } from "react";
import { Button } from "./primitives";

export function Pagination({
  page,
  pageSize,
  total,
  hasNextPage,
  onPageChange,
  disabled = false,
  label,
  previousLabel = "上一页",
  nextLabel = "下一页",
  className = "pagination",
  children,
}: {
  page: number;
  onPageChange(page: number): void;
  disabled?: boolean;
  label: string;
  previousLabel?: string;
  nextLabel?: string;
  className?: string;
  children?: ReactNode;
} & (
  | { pageSize: number; total: number; hasNextPage?: never }
  | { pageSize?: never; total?: never; hasNextPage: boolean }
)) {
  const pages =
    total === undefined ? null : Math.max(1, Math.ceil(total / pageSize!));
  const canGoNext = hasNextPage ?? (pages !== null && page < pages);
  const showButtons = page > 1 || canGoNext || (pages !== null && pages > 1);
  return (
    <nav
      className={`row spread ${className}`}
      data-single-page={!showButtons || undefined}
      aria-label={label}
    >
      {showButtons ? (
        <Button
          size="compact"
          disabled={disabled || page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          {previousLabel}
        </Button>
      ) : null}
      <small aria-live="polite">
        {children ??
          (pages === null
            ? `第 ${page} 页`
            : `第 ${page} / ${pages} 页 · 共 ${total} 项`)}
      </small>
      {showButtons ? (
        <Button
          size="compact"
          disabled={disabled || !canGoNext}
          onClick={() => onPageChange(page + 1)}
        >
          {nextLabel}
        </Button>
      ) : null}
    </nav>
  );
}

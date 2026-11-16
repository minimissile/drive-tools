import "./pagination.css";
import { useState, type ReactNode } from "react";
import { Button } from "./primitives";

export function Pagination({
  page,
  pageSize,
  total,
  hasNextPage,
  pageCount,
  onPageChange,
  disabled = false,
  label,
  previousLabel = "上一页",
  nextLabel = "下一页",
  className = "pagination",
  children,
  numbered = false,
}: {
  page: number;
  onPageChange(page: number): void;
  disabled?: boolean;
  label: string;
  previousLabel?: string;
  nextLabel?: string;
  className?: string;
  children?: ReactNode;
  numbered?: boolean;
} & (
  | { pageSize: number; total: number; hasNextPage?: boolean; pageCount?: never }
  | { pageSize?: never; total?: never; hasNextPage: boolean; pageCount?: number }
)) {
  const pages =
    total === undefined ? pageCount ?? null : Math.max(1, Math.ceil(total / pageSize!));
  const canGoNext = hasNextPage ?? (pages !== null && page < pages);
  const showButtons = page > 1 || canGoNext || (pages !== null && pages > 1);
  if (numbered) {
    const numberedPages = Math.max(pages ?? 1, page + Number(canGoNext));
    return (
      <nav className={className} data-numbered aria-label={label}>
        <small className="muted" aria-live="polite">
          {children ?? (total !== undefined
            ? `第 ${page} / ${pages} 页 · 共 ${total} 项`
            : pages === null ? `第 ${page} 页` : `第 ${page} / ${pages} 页`)}
        </small>
        {showButtons ? (
          <div className="pagination-actions">
            <Button
              size="compact"
              disabled={disabled || page <= 1}
              onClick={() => onPageChange(page - 1)}
            >
              {previousLabel}
            </Button>
            {pageLinks(page, numberedPages).map((link) =>
              typeof link === "number" ? (
                <Button
                  key={link}
                  size="compact"
                  className="pagination-number"
                  aria-current={link === page ? "page" : undefined}
                  aria-label={`第 ${link} 页`}
                  disabled={disabled}
                  onClick={() => {
                    if (link !== page) onPageChange(link);
                  }}
                >
                  {link}
                </Button>
              ) : (
                <span
                  key={link}
                  className="pagination-gap muted"
                  aria-hidden="true"
                >
                  …
                </span>
              ),
            )}
            <Button
              size="compact"
              disabled={disabled || !canGoNext}
              onClick={() => onPageChange(page + 1)}
            >
              {nextLabel}
            </Button>
            {numberedPages > 7 ? (
              <PageJump
                key={page}
                pages={numberedPages}
                disabled={disabled}
                onPageChange={onPageChange}
              />
            ) : null}
          </div>
        ) : null}
      </nav>
    );
  }
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

function pageLinks(page: number, pages: number) {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1);
  if (page <= 4) return [1, 2, 3, 4, 5, "after", pages];
  if (page >= pages - 3)
    return [1, "before", pages - 4, pages - 3, pages - 2, pages - 1, pages];
  return [1, "before", page - 1, page, page + 1, "after", pages];
}

function PageJump({
  pages,
  disabled,
  onPageChange,
}: {
  pages: number;
  disabled: boolean;
  onPageChange(page: number): void;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="pagination-jump"
      onSubmit={(event) => {
        event.preventDefault();
        const destination = Number(value);
        if (
          !disabled &&
          Number.isInteger(destination) &&
          destination >= 1 &&
          destination <= pages
        )
          onPageChange(destination);
      }}
    >
      <input
        aria-label="跳转页码"
        type="number"
        inputMode="numeric"
        min={1}
        max={pages}
        step={1}
        required
        placeholder="页码"
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button type="submit" size="compact" disabled={disabled || !value}>
        跳转
      </Button>
    </form>
  );
}

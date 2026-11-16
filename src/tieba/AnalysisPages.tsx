import { useRef, type ReactNode } from "react";
import { Pagination } from "../ui/Pagination";
import { Loading } from "../ui/primitives";

export function AnalysisPages({
  page,
  pageSize,
  total,
  label,
  loading = false,
  loadingLabel,
  partial = false,
  hasNextPage,
  pageCount,
  summary,
  onPageChange,
  children,
}: {
  page: number;
  pageSize: number;
  total?: number;
  label: string;
  loading?: boolean;
  loadingLabel?: string;
  partial?: boolean;
  hasNextPage?: boolean;
  pageCount?: number;
  summary?: string;
  onPageChange(page: number): void;
  children: ReactNode;
}) {
  const top = useRef<HTMLDivElement>(null);
  const focusTop = () => {
    top.current?.focus({ preventScroll: true });
    top.current?.scrollIntoView({ block: "nearest" });
  };
  const pagination = {
    page,
    ...(total === undefined
      ? { hasNextPage: hasNextPage ?? false, pageCount }
      : { pageSize, total, hasNextPage }),
    numbered: true,
    disabled: loading,
    children: loading && loadingLabel
      ? <Loading label={loadingLabel} announce={false} />
      : summary ?? (partial && total !== undefined
        ? `第 ${page} 页 · 已读取 ${total} 项`
        : undefined),
  };
  return (
    <>
      <div ref={top} className="tieba-analysis-page-top" tabIndex={-1}>
        <Pagination
          {...pagination}
          label={`${label}顶部`}
          onPageChange={onPageChange}
        />
      </div>
      <div aria-busy={loading}>{children}</div>
      {page > 1 || hasNextPage || (total ?? 0) > pageSize ? (
        <Pagination
          {...pagination}
          label={`${label}底部`}
          onPageChange={(next) => {
            if (next === page) return;
            onPageChange(next);
            focusTop();
          }}
        />
      ) : null}
    </>
  );
}

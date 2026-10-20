import type { ReactNode } from "react";
import { DataState } from "./DataState";
import { Button } from "./primitives";

export function QueryError({
  error,
  loading = false,
  onRetry,
  title = "暂时无法读取数据",
  children,
  compact = true,
  fill = false,
}: {
  error: string;
  loading?: boolean;
  onRetry(): void;
  title?: string;
  children?: ReactNode;
  compact?: boolean;
  fill?: boolean;
}) {
  return error ? (
    <DataState
      kind="error"
      title={title}
      compact={compact}
      fill={fill}
      action={
        <Button
          disabled={loading}
          size={compact ? "compact" : "default"}
          onClick={onRetry}
        >
          {loading ? "正在重试…" : "重试读取"}
        </Button>
      }
    >
      {error}
      {children ? <> {children}</> : null}
    </DataState>
  ) : null;
}

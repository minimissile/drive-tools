import { useCallback, useEffect, useRef, useState } from "react";
import type {
  IpcArgs,
  IpcArguments,
  IpcQueryMethod,
  IpcValue,
} from "../../shared/ipc";
import { ipc } from "./client";

interface QueryOptions {
  enabled?: boolean;
  delay?: number;
  revision?: unknown;
  invalidate?: unknown;
  keepPrevious?: boolean;
  /** Poll local reads after the previous request settles; never overlaps requests. */
  refreshInterval?: number;
  onError?(error: Error): void;
}

/** Shared read lifecycle: debounce, stale-response protection, errors and retry. */
export function useIpcQuery<M extends IpcQueryMethod>(
  method: M,
  args: IpcArgs<M>,
  {
    enabled = true,
    delay = 0,
    revision,
    invalidate,
    keepPrevious = false,
    refreshInterval = 0,
    onError,
  }: QueryOptions = {},
) {
  const key = JSON.stringify([method, args]);
  const input = useRef(args);
  input.current = args;
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const [result, setResult] = useState<{
    key: string;
    value: IpcValue<M>;
  } | null>(null);
  const [status, setStatus] = useState<{
    key: string;
    loading: boolean;
    error: string;
  }>({ key, loading: enabled, error: "" });
  const [retry, setRetry] = useState(0);
  const reload = useCallback(() => setRetry((n) => n + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const parameters = input.current;
    setStatus({ key, loading: true, error: "" });
    let timer: ReturnType<typeof setTimeout>;
    const read = () => {
      setStatus({ key, loading: true, error: "" });
      void ipc(method, ...([parameters] as IpcArguments<M>))
        .then((value) => {
          if (active) {
            setResult({ key, value });
            setStatus({ key, loading: false, error: "" });
          }
        })
        .catch((cause: unknown) => {
          if (!active) return;
          const error =
            cause instanceof Error ? cause : new Error("读取失败，请重试。");
          setResult((old) => (keepPrevious && old?.key === key ? old : null));
          setStatus({ key, loading: false, error: error.message });
          errorHandler.current?.(error);
        })
        .finally(() => {
          if (active && refreshInterval > 0)
            timer = setTimeout(read, refreshInterval);
        });
    };
    timer = setTimeout(read, delay);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    method,
    key,
    enabled,
    delay,
    revision,
    invalidate,
    retry,
    refreshInterval,
    keepPrevious,
  ]);
  return {
    data:
      enabled && result && (result.key === key || keepPrevious)
        ? result.value
        : null,
    loading: enabled && (status.key !== key || status.loading),
    error: status.key === key ? status.error : "",
    reload,
  };
}

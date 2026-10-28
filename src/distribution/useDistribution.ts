import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions } from "../state";
import type {
  DistributionPlatformId,
  DistributionStatus,
} from "../../shared/distribution";

export function useDistribution(
  platformId: DistributionPlatformId,
  query: string,
  status: DistributionStatus | "all",
  page: number,
) {
  const { notify } = useAppActions();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const active = useRef(true),
    running = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const overview = useIpcQuery("distribution.overview", undefined, {
    revision,
    keepPrevious: true,
    refreshInterval: 1500,
  });
  const tasks = useIpcQuery(
    "distribution.list",
    { platformId, query, status, page },
    { revision, delay: 120, keepPrevious: true, refreshInterval: 2000 },
  );
  const refresh = useCallback(() => {
    overview.reload();
    tasks.reload();
  }, [overview.reload, tasks.reload]);
  const run = useCallback(
    async <T>(
      action: () => Promise<T>,
      message?: string | ((result: T) => string),
    ): Promise<T | undefined> => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      try {
        const result = await action();
        if (active.current) {
          setRevision((value) => value + 1);
          if (message)
            notify(
              typeof message === "function" ? message(result) : message,
              "success",
            );
        }
        return result;
      } catch (error) {
        if (active.current)
          notify(
            error instanceof Error ? error.message : "操作失败，请重试。",
            "error",
          );
        return undefined;
      } finally {
        running.current = false;
        if (active.current) setBusy(false);
      }
    },
    [notify],
  );
  const open = (page: "submit" | "login" = "submit") =>
    run(() => ipc("distribution.open", { platformId, page }));
  return { overview, tasks, refresh, busy, run, open };
}
export type DistributionModel = ReturnType<typeof useDistribution>;

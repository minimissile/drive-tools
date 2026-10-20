import { ipc } from "../api/client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSnapshot } from "../../shared/types";
import { structuralShare } from "../lib/structural-share";

export function useSnapshot(resourceId: string) {
  const [data, setData] = useState<AppSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const selection = useRef(resourceId);
  selection.current = resourceId;
  const pending = useRef<{
    promise: Promise<void>;
    reading: boolean;
    dirty: boolean;
  } | null>(null);
  const mounted = useRef(false);
  const refresh = useCallback((): Promise<void> => {
    if (!window.panxu) return Promise.resolve();
    if (pending.current) {
      if (pending.current.reading) pending.current.dirty = true;
      return pending.current.promise;
    }
    // Mutations and the desktop change event share one refresh, including bursts
    // of task progress. Read-only queries never explicitly refresh the snapshot.
    const task = { promise: Promise.resolve(), reading: false, dirty: false };
    task.promise = (async () => {
      if (mounted.current) {
        setLoading(true);
        setError("");
      }
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        let id: string;
        let snapshot: AppSnapshot;
        do {
          task.dirty = false;
          task.reading = true;
          id = selection.current;
          snapshot = await ipc("snapshot", { resourceId: id || undefined });
        } while (mounted.current && (task.dirty || id !== selection.current));
        if (mounted.current) setData((old) => structuralShare(old, snapshot));
      } catch (cause) {
        if (mounted.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "本地知识库读取失败，请重试。",
          );
        throw cause;
      } finally {
        if (mounted.current) setLoading(false);
      }
    })();
    pending.current = task;
    void task.promise
      .finally(() => {
        if (pending.current === task) pending.current = null;
      })
      .catch(() => {});
    return task.promise;
  }, []);
  useEffect(() => {
    mounted.current = true;
    const update = () => {
      void refresh().catch(() => {
        /* The workspace read state owns recovery feedback. */
      });
    };
    update();
    const unsubscribe = window.panxu?.onChanged(update);
    return () => {
      mounted.current = false;
      unsubscribe?.();
    };
  }, [refresh]);
  useEffect(() => {
    void refresh().catch(() => {
      /* The workspace read state owns recovery feedback. */
    });
  }, [resourceId, refresh]);
  return { data, refresh, error, loading };
}

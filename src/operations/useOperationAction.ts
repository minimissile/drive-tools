import { useEffect, useRef, useState } from "react";
import { useAppActions } from "../state";

export type OperationAction = <T>(
  action: () => Promise<T>,
  message: string,
  onError?: (message: string) => void,
) => Promise<{ ok: true; value: T } | { ok: false }>;

export function useOperationAction(reload: () => void) {
  const { notify } = useAppActions();
  const lock = useRef(false);
  const alive = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run: OperationAction = async (action, message, onError) => {
    if (lock.current) return { ok: false };
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const value = await action();
      notify(message, "success");
      reload();
      return { ok: true, value };
    } catch (cause) {
      if (alive.current) {
        const failure =
          cause instanceof Error ? cause.message : "操作未完成，请重试。";
        if (onError) onError(failure);
        else setError(failure);
      }
      return { ok: false };
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return { busy, error, run };
}

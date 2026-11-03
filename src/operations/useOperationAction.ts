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
  const interruptLock = useRef(false);
  const pending = useRef(0);
  const alive = useRef(true);
  const [busy, setBusy] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function perform<T>(
    interrupt: boolean,
    action: () => Promise<T>,
    message: string,
    onError?: (message: string) => void,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    // Only pause/stop commands use the interrupt path. New work still waits
    // for both locks, while a stop can pass a slow model or ordinary request.
    if (
      interrupt ? interruptLock.current : lock.current || interruptLock.current
    )
      return { ok: false };
    if (interrupt) {
      interruptLock.current = true;
      setInterrupting(true);
    } else lock.current = true;
    pending.current += 1;
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
      if (interrupt) interruptLock.current = false;
      else lock.current = false;
      pending.current -= 1;
      if (alive.current) {
        setBusy(pending.current > 0);
        if (interrupt) setInterrupting(false);
      }
    }
  }
  const run: OperationAction = (action, message, onError) =>
    perform(false, action, message, onError);
  const runInterrupt: OperationAction = (action, message, onError) =>
    perform(true, action, message, onError);
  return { busy, interrupting, error, run, runInterrupt };
}

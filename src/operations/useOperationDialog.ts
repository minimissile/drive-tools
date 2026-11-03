import { useEffect, useRef, useState } from "react";
import type { OperationAction } from "./useOperationAction";

/** Dialog dismissal only waits for this dialog's command, never a background agent. */
export function useOperationDialog(run: OperationAction, close: () => void) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function submit<T>(
    action: () => Promise<T>,
    message: string,
    saved?: () => void,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError("");
    const result = await run(action, message, (failure) => {
      if (alive.current) setError(failure);
    });
    inFlight.current = false;
    if (!alive.current) return;
    setSubmitting(false);
    if (result.ok) {
      saved?.();
      close();
    }
  }
  return { submitting, error, submit };
}

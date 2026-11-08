import { useEffect, useRef, useState } from "react";
import type { FeedbackMessage } from "../lib/feedback";
import { useAppActions } from "../state";

export function tiebaBackendError(message: string) {
  return /UNKNOWN_METHOD|不支持此操作|未注册.*操作/.test(message)
    ? "当前后台尚未加载此功能，请手动应用顶部更新后重试。草稿已保留。"
    : message;
}

/** Only event handlers invoke run. Completion updates data, never navigation or consent. */
export function useTiebaAction<T>(
  receive: (value: T) => void,
  reload: () => void,
) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false),
    mounted = useRef(true);
  const { notify } = useAppActions();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async (
    operation: () => Promise<T>,
    message: string | ((value: T) => FeedbackMessage),
  ) => {
    if (lock.current) return null;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const value = await operation();
      if (!mounted.current) return null;
      receive(value);
      const feedback =
        typeof message === "string"
          ? { text: message, tone: "success" as const }
          : message(value);
      notify(feedback.text, feedback.tone);
      return value;
    } catch (cause) {
      if (mounted.current) {
        setError(
          tiebaBackendError(
            cause instanceof Error
              ? cause.message
              : "操作未完成，请重新读取本地状态。",
          ),
        );
        reload();
      }
      return null;
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return { busy, error, run, clearError: () => setError("") };
}

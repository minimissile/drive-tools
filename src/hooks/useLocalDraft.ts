import { windowStorage } from "../storage/window-storage";
import { useCallback, useRef, useState, useMemo } from "react";
import { readDraft, writeDraft } from "../storage/local-draft";

/** Local input only. Never restores consent, remote commands or file inspections. */
export function useLocalDraft<T extends object>(
  key: string,
  defaults: T,
  parse: (value: unknown) => T,
) {
  const storage = useMemo(() => {
    try {
      return windowStorage;
    } catch {
      return undefined;
    }
  }, []);
  const [initial] = useState(() => readDraft(storage, key, parse));
  const [value, setValue] = useState(initial ?? defaults);
  const latest = useRef(value);
  const [error, setError] = useState("");
  const update = useCallback(
    (patch: Partial<T>) => {
      const next = { ...latest.current, ...patch };
      latest.current = next;
      setValue(next);
      setError(
        writeDraft(storage, key, next)
          ? ""
          : "本机暂存空间不可用，请先保存当前内容，再离开页面。",
      );
    },
    [key, storage],
  );
  const clear = useCallback(() => {
    try {
      storage?.removeItem(key);
    } catch {
      /* Saved business data remains authoritative. */
    }
  }, [key]);
  return { value, update, clear, error, restored: !!initial };
}

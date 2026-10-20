import { useCallback, useEffect, useRef, useState } from "react";
import { readAttachment, writeAttachment } from "../storage/draft-attachments";

export function useAttachmentDraft(key: string, label = "封面") {
  const [value, setValue] = useState<string | null | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const changed = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void readAttachment(key)
      .then((stored) => {
        if (mounted.current && !changed.current) setValue(stored);
      })
      .catch(() => {
        if (mounted.current)
          setError(`${label}暂存读取失败，请重新选择${label}后保存。`);
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, [key]);
  const update = useCallback(
    (next: string | null | undefined) => {
      changed.current = true;
      setValue(next);
      void writeAttachment(key, next)
        .then(() => {
          if (mounted.current) setError("");
        })
        .catch(() => {
          if (mounted.current)
            setError(`${label}暂存失败，请保存资料后再离开。文字输入已单独暂存。`);
        });
    },
    [key],
  );
  const restore = useCallback((next: string | null | undefined) => {
    if (mounted.current && !changed.current) setValue(next);
  }, []);
  const clear = useCallback(() => {
    void writeAttachment(key, undefined).catch(() => {});
  }, [key]);
  return { value, update, restore, clear, loading, error };
}

import { useEffect, useRef, useState } from "react";
import { ipc } from "../api/client";
import {
  publishingInput,
  type PublishingDraft,
  type PublishingDraftRow,
} from "./publishing-draft";

export function usePublishingGeneration(
  value: PublishingDraft,
  update: (patch: Partial<PublishingDraft>) => void,
  reload: () => void,
) {
  const latest = useRef(value);
  latest.current = value;
  const mounted = useRef(true),
    lock = useRef(false);
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const start = async (rows: PublishingDraftRow[]) => {
    if (lock.current || !rows.length) return;
    lock.current = true;
    setPending(true);
    setError("");
    try {
      const planned = await ipc("zhidao.workflow.planMany", {
        resources: rows.map(publishingInput),
      });
      if (!mounted.current) return;
      const keys = new Map(
        rows.map((row, index) => [row.key, planned[index].id]),
      );
      update({
        rows: latest.current.rows.map((row) =>
          keys.has(row.key)
            ? { ...row, key: keys.get(row.key)!, prepared: false }
            : row,
        ),
        activeKey:
          keys.get(latest.current.activeKey) ?? latest.current.activeKey,
      });
      reload();
      await ipc("zhidao.workflow.generateMany", {
        ids: planned.map((record) => record.id),
      });
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "问答生成未完成，请继续生成剩余问答。",
        );
    } finally {
      lock.current = false;
      if (mounted.current) {
        setPending(false);
        reload();
      }
    }
  };
  return { pending, error, start };
}

import { useEffect, useRef, useState } from "react";
import type { PublishingRecord } from "../../shared/zhidao-workflow";
import { ipc } from "../api/client";
import type { PublishingDraft, PublishingDraftRow } from "./publishing-draft";
import { publishingInput } from "./publishing-draft";

async function readPreparation(id: string) {
  const [record] = await ipc("zhidao.workflow.get", { ids: [id] });
  if (!record) throw new Error("未找到此资源的准备记录，请重新准备。");
  return record;
}

export function usePublishingPreparation(
  value: PublishingDraft,
  update: (patch: Partial<PublishingDraft>) => void,
  reload: () => void,
) {
  const latest = useRef(value);
  latest.current = value;
  const mounted = useRef(true),
    lock = useRef(false),
    stopped = useRef(false),
    active = useRef("");
  const [pending, setPending] = useState(false),
    [stopping, setStopping] = useState(false),
    [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopped.current = true;
    };
  }, []);
  const patchDraft = (patch: Partial<PublishingDraft>) => {
    latest.current = { ...latest.current, ...patch };
    update(patch);
  };
  const start = async (rows: PublishingDraftRow[], transferJobId?: string) => {
    if (lock.current) return;
    lock.current = true;
    stopped.current = false;
    setPending(true);
    setStopping(false);
    try {
      for (const row of rows) {
        if (stopped.current || !mounted.current) break;
        active.current = row.key;
        setErrors((previous) => ({ ...previous, [row.key]: "" }));
        try {
          let record: PublishingRecord;
          if (transferJobId) {
            await ipc("job.retry", { id: transferJobId });
            record = await readPreparation(row.key);
          } else {
            record = await ipc("zhidao.workflow.prepare", {
              resource: publishingInput(row),
              accountId: latest.current.accountId,
              authorized: true,
            });
          }
          if (!mounted.current) break;
          patchDraft({
            rows: latest.current.rows.map((r) =>
              r.key === row.key ? { ...r, prepared: true } : r,
            ),
          });
          reload();
          while (
            record.stage === "transferring" &&
            !stopped.current &&
            mounted.current
          ) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            if (stopped.current || !mounted.current) break;
            record = await readPreparation(record.id);
          }
          if (
            !record.transferBlocked &&
            record.stage !== "transferring" &&
            record.stage !== "ready" &&
            !stopped.current &&
            mounted.current
          ) {
            await ipc("zhidao.workflow.shares", {
              id: record.id,
              authorized: true,
            });
          }
        } catch (error) {
          if (mounted.current) {
            setErrors((previous) => ({
              ...previous,
              [row.key]:
                error instanceof Error ? error.message : "准备未完成，请重试。",
            }));
            patchDraft({
              rows: latest.current.rows.map((r) =>
                r.key === row.key ? { ...r, prepared: true } : r,
              ),
            });
          }
        } finally {
          if (mounted.current) reload();
        }
      }
    } finally {
      lock.current = false;
      active.current = "";
      if (mounted.current) {
        setPending(false);
        setStopping(false);
      }
    }
  };
  return {
    pending,
    stopping,
    errors,
    start: (rows: PublishingDraftRow[]) => start(rows),
    resume: (row: PublishingDraftRow, jobId: string) => start([row], jobId),
    stop: async () => {
      stopped.current = true;
      setStopping(true);
      if (active.current) {
        const id = active.current;
        try {
          await ipc("zhidao.workflow.pause", { id });
        } catch (error) {
          setErrors((previous) => ({
            ...previous,
            [id]:
              error instanceof Error
                ? error.message
                : "停止请求未确认，请等待当前回执。",
          }));
        }
      }
    },
  };
}

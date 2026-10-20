import { useEffect } from "react";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions } from "../state";
import type { Draft } from "../../shared/types";
import type { StudioJob } from "../../shared/studio";

const noJobs: StudioJob[] = [];
const remotePending = (job: StudioJob) =>
  job.kind === "video" &&
  !!job.remoteId &&
  ["pending", "in_progress", "download_failed"].includes(job.status);

/** Local task reads and the user's video-progress polling preference share one owner. */
export function useStudioJobs(draft: Draft, autoPoll: boolean, dirty: boolean) {
  const { notify } = useAppActions();
  const { data, reload } = useIpcQuery(
    "studio.jobs",
    { draftId: draft.id },
    {
      revision: draft.updatedAt,
      refreshInterval: 5000,
      onError: (error) => notify(error.message, "error"),
    },
  );
  const jobs = data ?? noJobs;
  const pendingKey = JSON.stringify(
    jobs.filter(remotePending).map((job) => job.id),
  );
  useEffect(() => {
    const ids: string[] = JSON.parse(pendingKey);
    if (!autoPoll || dirty || !ids.length) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        // These commands only inspect existing remote tasks; submission stays in the click handler.
        await Promise.all(ids.map((id) => ipc("studio.poll", { id })));
        if (active) reload();
      } catch (error) {
        if (active)
          notify(
            error instanceof Error ? error.message : "素材进度读取失败",
            "error",
          );
      } finally {
        if (active) timer = setTimeout(poll, 30_000);
      }
    };
    timer = setTimeout(poll, 30_000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [autoPoll, dirty, pendingKey, reload, notify]);
  return { jobs, reload };
}

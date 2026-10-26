import type { Job } from "../../shared/types";
import { operationLabels, type OperationRun } from "../../shared/zhidao";
import { stageName } from "../resources/labels";
import { operationPage } from "../zhidao/navigation";
import type { Page } from "../state";
import type { TaskFocus } from "./TaskFocus";
export function activeTaskOptions(
  runs: Omit<OperationRun, "config">[],
  jobs: Job[],
) {
  return [
    ...runs
      .filter((run) => run.status === "running")
      .map((run) => ({
        value: `operation:${run.id}`,
        label: `${run.kind === "answer" ? "百度知道答题" : run.kind === "publish" ? "百度知道上传内容" : operationLabels[run.kind]} · ${run.title} · ${run.done}/${run.total || "…"}`,
        page: operationPage[run.kind] as Page,
        focus: { id: run.id, kind: run.kind } as TaskFocus,
      })),
    ...jobs
      .filter((job) =>
        [
          "queued",
          "preflight",
          "transferring",
          "verifying",
          "sharing",
          "archiving",
        ].includes(job.stage),
      )
      .map((job) => ({
        value: `job:${job.id}`,
        label: `网盘任务 · ${job.title} · ${stageName(job.stage)}`,
        page: "tasks" as Page,
        focus: { id: job.id, kind: "job" } as TaskFocus,
      })),
  ];
}

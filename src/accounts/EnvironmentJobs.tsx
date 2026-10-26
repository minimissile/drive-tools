import { useState } from "react";
import { useIpcQuery } from "../api/useIpcQuery";
import { ipc } from "../api/client";
import { useAppActions } from "../state";
import { formatTime } from "../lib/format";
import { Button, Empty, LoadingState, Panel, Status } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import type {
  BrowserEnvironmentView,
  EnvironmentJob,
} from "../../shared/browser-environments";
const labels: Record<EnvironmentJob["status"], string> = {
  queued: "排队中",
  running: "执行中",
  completed: "操作结束",
  failed: "需处理",
  cancelled: "已取消",
  attention: "中断待核对",
};
export function EnvironmentJobs({
  environments,
}: {
  environments: BrowserEnvironmentView[];
}) {
  const query = useIpcQuery("environments.jobs", undefined, {
    keepPrevious: true,
    refreshInterval: 1500,
  });
  const [pending, setPending] = useState("");
  const { notify } = useAppActions();
  return (
    <Panel title="环境任务调度">
      <p className="muted">
        同一环境串行执行，最多同时执行两个环境任务。重启后保留记录，等待人工核对后在原业务继续。
      </p>
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
      />
      {!query.data && !query.error ? (
        <LoadingState label="正在读取环境任务…" compact />
      ) : null}
      {query.data?.length ? (
        <div className="table-scroll">
          <table className="environment-jobs">
            <thead>
              <tr>
                <th>操作</th>
                <th>关联环境</th>
                <th>状态</th>
                <th>说明</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {query.data.slice(0, 15).map((job) => (
                <tr key={job.id}>
                  <td>
                    {job.label}
                    <small>{formatTime(job.updatedAt)}</small>
                  </td>
                  <td>
                    {job.environmentIds
                      .map(
                        (id) =>
                          environments.find((env) => env.id === id)?.name ??
                          "历史环境",
                      )
                      .join("、")}
                  </td>
                  <td>
                    <Status
                      kind={
                        ["failed", "attention"].includes(job.status)
                          ? "warning"
                          : "normal"
                      }
                    >
                      {labels[job.status]}
                    </Status>
                  </td>
                  <td>{job.message}</td>
                  <td>
                    {job.status === "queued" ? (
                      <Button
                        quiet
                        disabled={!!pending}
                        onClick={() => {
                          setPending(job.id);
                          void ipc("environments.cancelJob", { id: job.id })
                            .then(() => {
                              query.reload();
                              notify(
                                "已取消排队，平台操作尚未执行。",
                                "success",
                              );
                            })
                            .catch((error) => notify(error.message, "error"))
                            .finally(() => setPending(""));
                        }}
                      >
                        取消排队
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : query.data && !query.error ? (
        <Empty compact title="暂无环境调度记录">
          微博、CSDN 和知道的显式操作会在这里留下调度记录。
        </Empty>
      ) : null}
    </Panel>
  );
}

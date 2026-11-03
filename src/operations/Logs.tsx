import { ScrollText } from "lucide-react";
import {
  operationsLogQuery,
  type OperationsPlan,
} from "../../shared/intelligent-operations";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { formatTime } from "../lib/format";
import { DataState, LoadingState } from "../ui/DataState";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Button, Field, Notice, Panel, Status } from "../ui/primitives";

export function OperationsLogs({
  plans,
  workspace,
}: {
  plans: OperationsPlan[];
  workspace: string;
}) {
  const filters = useLocalDraft(
    `panxu-operations-logs-v1:${workspace}`,
    operationsLogQuery.parse({}),
    (v) => operationsLogQuery.parse(v),
  );
  const query = useIpcQuery("intelligentOps.logs", filters.value, {
    keepPrevious: true,
    refreshInterval: 5000,
  });
  const data = query.data;
  return (
    <Panel
      title="决策与执行日志"
      extra={
        <Button size="compact" disabled={query.loading} onClick={query.reload}>
          刷新日志
        </Button>
      }
    >
      <div className="operations-toolbar">
        <Field label="运营计划">
          <Select
            value={filters.value.planId}
            items={[
              { value: "", label: "全部计划与调度器" },
              ...plans.map((p) => ({ value: p.id, label: p.name })),
            ]}
            onValueChange={(planId) => filters.update({ planId, page: 1 })}
          />
        </Field>
        <Field label="级别">
          <Select
            value={filters.value.level}
            items={[
              { value: "all", label: "全部级别" },
              { value: "info", label: "信息" },
              { value: "warning", label: "注意" },
              { value: "error", label: "错误" },
            ]}
            onValueChange={(level) =>
              filters.update({
                level: level as typeof filters.value.level,
                page: 1,
              })
            }
          />
        </Field>
        <span className="operations-quiet">
          规划、阻塞、重排、审核和执行各自留痕
        </span>
      </div>
      {filters.error ? <Notice warning>{filters.error}</Notice> : null}
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
        title="决策日志读取失败"
      />
      {!data && !query.error ? (
        <LoadingState label="正在读取本地决策日志…" compact />
      ) : null}
      {data?.items.length ? (
        <>
          <ol className="operations-log-list">
            {data.items.map((e) => (
              <li key={e.id}>
                <time dateTime={e.createdAt}>{formatTime(e.createdAt)}</time>
                <Status
                  kind={
                    e.level === "error"
                      ? "danger"
                      : e.level === "warning"
                        ? "warning"
                        : "normal"
                  }
                >
                  {e.level === "error"
                    ? "错误"
                    : e.level === "warning"
                      ? "注意"
                      : "信息"}
                </Status>
                <div>
                  <strong>{e.message}</strong>
                  <small>{e.event}</small>
                  {Object.keys(e.details).length || e.taskId ? (
                    <details>
                      <summary>查看决策依据</summary>
                      <pre>
                        {JSON.stringify(
                          {
                            ...e.details,
                            ...(e.taskId ? { taskId: e.taskId } : {}),
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          <Pagination
            label="决策日志分页"
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            disabled={query.loading}
            onPageChange={(page) => filters.update({ page })}
          />
        </>
      ) : data && !query.loading && !query.error ? (
        <DataState
          kind="empty"
          compact
          icon={ScrollText}
          title={
            filters.value.planId || filters.value.level !== "all"
              ? "没有匹配的日志"
              : "尚无决策记录"
          }
        >
          保存计划或重新规划后，在这里查看系统的安排依据。
        </DataState>
      ) : null}
      {data?.folder ? (
        <p className="operations-log-location">本地日志目录：{data.folder}</p>
      ) : null}
    </Panel>
  );
}

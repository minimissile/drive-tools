import { useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  distributionStatus,
  distributionStatusLabels,
  type DistributionPlatformId,
  type DistributionStatus,
  type DistributionTask,
} from "../../shared/distribution";
import { useIpcQuery } from "../api/useIpcQuery";
import {
  Button,
  Empty,
  Loading,
  LoadingState,
  Panel,
  SearchField,
  Status,
} from "../ui/primitives";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { formatTime } from "../lib/format";
import { ResolveDialog } from "./ResolveDialog";
import type { DistributionModel } from "./useDistribution";

export function TaskBoard({
  model,
  platformId,
  workspace,
  query,
  status,
  onQuery,
  onStatus,
  onPage,
}: {
  model: DistributionModel;
  platformId: DistributionPlatformId;
  workspace: string;
  query: string;
  status: DistributionStatus | "all";
  onQuery(value: string): void;
  onStatus(value: DistributionStatus | "all"): void;
  onPage(value: number): void;
}) {
  const [resolving, setResolving] = useState<DistributionTask | null>(null);
  const { tasks } = model;
  const data = tasks.data?.platformId === platformId ? tasks.data : null;
  return (
    <Panel
      title="逐条分发记录"
      extra={
        <Button
          quiet
          size="compact"
          disabled={model.busy || tasks.loading}
          onClick={model.refresh}
        >
          <RefreshCw size={14} />
          刷新本地记录
        </Button>
      }
    >
      <div className="distribution-filter">
        <SearchField
          value={query}
          onChange={onQuery}
          placeholder="搜索标题、资源 ID 或分享记录 ID…"
        />
        <Select
          aria-label="筛选分发阶段"
          value={status}
          items={[
            { value: "all", label: "全部阶段" },
            ...distributionStatus.options.map((value) => ({
              value,
              label: distributionStatusLabels[value],
            })),
          ]}
          onValueChange={(value) =>
            onStatus(value as DistributionStatus | "all")
          }
        />
      </div>
      <QueryError
        error={tasks.error}
        loading={tasks.loading}
        onRetry={tasks.reload}
        title="分发记录读取失败"
      />
      {tasks.loading && !data ? (
        <LoadingState label="正在读取分发记录…" layout="list" />
      ) : data ? (
        <>
          {tasks.loading && data.items.length ? (
            <Loading label="正在更新本地进度…" />
          ) : null}
          {data.items.length ? (
            <div className="distribution-records">
              {data.items.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  onResolve={() => setResolving(task)}
                />
              ))}
            </div>
          ) : !tasks.error ? (
            <Empty
              title={
                query || status !== "all"
                  ? "没有符合条件的分发记录"
                  : "尚未准备这个平台的全库链接"
              }
            >
              {query || status !== "all"
                ? "调整关键词或阶段后再查看。"
                : "点击上方“准备全库链接”，自动读取全部已就绪的本人分享。"}
            </Empty>
          ) : null}
          <Pagination
            label="分发记录分页"
            page={data.page}
            total={data.total}
            pageSize={data.pageSize}
            onPageChange={onPage}
          />
        </>
      ) : null}
      {resolving ? (
        <ResolveDialog
          task={resolving}
          workspace={workspace}
          model={model}
          onClose={() => setResolving(null)}
        />
      ) : null}
    </Panel>
  );
}
function TaskRow({
  task,
  onResolve,
}: {
  task: DistributionTask;
  onResolve(): void;
}) {
  const [expanded, setExpanded] = useState(false),
    [page, setPage] = useState(1);
  const history = useIpcQuery(
    "distribution.history",
    { taskId: task.id, page },
    { enabled: expanded, keepPrevious: true, revision: task.updatedAt },
  );
  const tone =
    task.status === "published"
      ? "good"
      : ["failed", "rejected"].includes(task.status)
        ? "danger"
        : ["uncertain", "blocked", "waiting_login", "waiting_rules"].includes(
              task.status,
            )
          ? "warning"
          : "normal";
  return (
    <article className="distribution-record">
      <div className="distribution-record-top">
        <div>
          <h3>{task.title}</h3>
          <p>
            {task.provider} · {task.shareUrl}
          </p>
        </div>
        <Status kind={tone}>{distributionStatusLabels[task.status]}</Status>
      </div>
      <p className="distribution-record-message">{task.message}</p>
      <div className="distribution-record-meta">
        <span title={task.resourceId}>资源 ID：{task.resourceId}</span>
        <span title={task.shareRecordId}>分享 ID：{task.shareRecordId}</span>
      </div>
      <div className="row spread">
        <details
          className="distribution-history"
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary>记录与历史</summary>
          {expanded ? (
            <>
              <dl>
                <div>
                  <dt>资源 ID</dt>
                  <dd>{task.resourceId}</dd>
                </div>
                <div>
                  <dt>分享记录 ID</dt>
                  <dd>{task.shareRecordId}</dd>
                </div>
                <div>
                  <dt>分发记录 ID</dt>
                  <dd>{task.id}</dd>
                </div>
                <div>
                  <dt>当前批次</dt>
                  <dd>{task.batchId || "尚未进入提交批次"}</dd>
                </div>
                <div>
                  <dt>最后更新</dt>
                  <dd>{formatTime(task.updatedAt)}</dd>
                </div>
              </dl>
              <QueryError
                error={history.error}
                loading={history.loading}
                onRetry={history.reload}
              />
              {history.loading && !history.data ? (
                <LoadingState compact label="正在读取历史…" />
              ) : history.data ? (
                <>
                  <ol>
                    {history.data.items.map((event) => (
                      <li key={event.id}>
                        <strong>
                          {distributionStatusLabels[event.status]}
                        </strong>
                        <time>{formatTime(event.at)}</time>
                        <p>{event.note}</p>
                        {event.receipt ? <p>回执：{event.receipt}</p> : null}
                        {event.url ? <p>{event.url}</p> : null}
                      </li>
                    ))}
                  </ol>
                  <Pagination
                    label="分发记录历史分页"
                    page={history.data.page}
                    pageSize={history.data.pageSize}
                    total={history.data.total}
                    onPageChange={setPage}
                  />
                </>
              ) : null}
            </>
          ) : null}
        </details>
        {[
          "submitted",
          "processing",
          "reviewing",
          "published",
          "uncertain",
          "failed",
          "rejected",
          "skipped",
        ].includes(task.status) ? (
          <Button quiet size="compact" onClick={onResolve}>
            核对官网结果
          </Button>
        ) : null}
      </div>
    </article>
  );
}
export function BatchHistory({
  platformId,
}: {
  platformId: DistributionPlatformId;
}) {
  const [page, setPage] = useState(1);
  const query = useIpcQuery(
    "distribution.batches",
    { platformId, page },
    { keepPrevious: true, refreshInterval: 2000 },
  );
  return (
    <Panel title="提交批次">
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
      />
      {query.loading && !query.data ? (
        <LoadingState label="正在读取批次…" />
      ) : query.data ? (
        <>
          {query.data.items.length ? (
            <div className="distribution-batches">
              {query.data.items.map((batch) => (
                <article key={batch.id}>
                  <div className="row spread">
                    <strong>{batch.count} 条链接</strong>
                    <Status
                      kind={
                        batch.status === "uncertain"
                          ? "warning"
                          : batch.status === "failed"
                            ? "danger"
                            : "normal"
                      }
                    >
                      {distributionStatusLabels[
                        batch.status as DistributionStatus
                      ] ??
                        (batch.status === "preparing"
                          ? "准备中"
                          : batch.status === "paused"
                            ? "已暂停"
                            : batch.status === "checked"
                              ? "已核对"
                              : batch.status)}
                    </Status>
                  </div>
                  <small>
                    {batch.id} · {formatTime(batch.createdAt)}
                  </small>
                  <p>{batch.message}</p>
                  {batch.receipt ? <p>回执：{batch.receipt}</p> : null}
                </article>
              ))}
            </div>
          ) : (
            <Empty title="还没有提交批次">
              开始当前平台的自动分发后，会按批保存记录和回执。
            </Empty>
          )}
          <Pagination
            label="提交批次分页"
            page={query.data.page}
            pageSize={query.data.pageSize}
            total={query.data.total}
            onPageChange={setPage}
          />
        </>
      ) : null}
    </Panel>
  );
}

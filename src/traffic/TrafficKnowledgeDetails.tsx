import { useState } from "react";
import { Download } from "lucide-react";
import type { KnowledgeItem } from "../../shared/traffic-knowledge";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions, useAppActivity } from "../state";
import { formatTime } from "../lib/format";
import { Dialog } from "../ui/Dialog";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { Button, Empty, Loading, LoadingState } from "../ui/primitives";
import {
  keywordMetricNames,
  knowledgeEndpointName,
  knowledgePlatformName,
  primaryKeywordMetric,
} from "./knowledge";

interface DetailProps {
  item: KnowledgeItem;
  onClose(): void;
}

/** Keep the selected entry's history and source reads inside its own lifecycle. */
export function TrafficKnowledgeDetails(props: DetailProps) {
  return <EntryDetails key={props.item.entryId} {...props} />;
}

function MetricList({ metrics }: { metrics: Record<string, unknown> }) {
  const values = Object.entries(metrics);
  if (!values.length) return <small>来源未提供指标。</small>;
  return (
    <dl className="knowledge-detail-metrics">
      {values.map(([name, value]) => (
        <div key={name}>
          <dt>{keywordMetricNames[name] ?? name}</dt>
          <dd>
            {value == null
              ? "未提供"
              : typeof value === "object"
                ? JSON.stringify(value)
                : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function EntryDetails({ item, onClose }: DetailProps) {
  const [page, setPage] = useState(1);
  const [queryId, setQueryId] = useState<string | null>(null);
  const history = useIpcQuery(
    "traffic.knowledge.history",
    { entryId: item.entryId, page },
    { keepPrevious: true },
  );
  const isDefault = item.metrics.averageMonthPvSource === "默认值（非实测）";
  return (
    <Dialog
      title={`词条详情 · ${item.word}`}
      className="knowledge-detail-dialog"
      onClose={onClose}
      focus="container"
      footer={<Button onClick={onClose}>完成</Button>}
    >
      <dl className="knowledge-detail-summary">
        <div>
          <dt>来源</dt>
          <dd>{item.source}</dd>
        </div>
        <div>
          <dt>平台</dt>
          <dd>{knowledgePlatformName(item.platform)}</dd>
        </div>
        <div>
          <dt>首次收录</dt>
          <dd>
            {item.firstObservedAt
              ? formatTime(item.firstObservedAt)
              : "时间未知"}
          </dd>
        </div>
        <div>
          <dt>最近采集</dt>
          <dd>{item.observedAt ? formatTime(item.observedAt) : "时间未知"}</dd>
        </div>
        {item.sourceUpdatedAt ? (
          <div>
            <dt>来源更新时间</dt>
            <dd>{item.sourceUpdatedAt}</dd>
          </div>
        ) : null}
      </dl>
      <section className="knowledge-detail-section" aria-label="当前指标">
        <h3>当前指标</h3>
        {isDefault ? (
          <p className="knowledge-detail-message">
            月搜索量 {String(item.metrics.averageMonthPv)}{" "}
            为默认值，非实测数据。
          </p>
        ) : null}
        <MetricList metrics={item.metrics} />
      </section>
      <section className="knowledge-detail-section" aria-label="词条采集历史">
        <div className="section-heading">
          <h3>采集历史</h3>
          {history.loading && history.data ? (
            <Loading label="正在刷新历史…" />
          ) : history.data ? (
            <small>{history.data.total} 次记录</small>
          ) : null}
        </div>
        <QueryError
          title="采集历史暂未读取成功"
          error={history.error}
          loading={history.loading}
          onRetry={history.reload}
        />
        {history.loading && !history.data ? (
          <LoadingState label="正在读取此词的采集历史…" compact />
        ) : history.data?.items.length ? (
          <div className="table-scroll knowledge-detail-history">
            <table>
              <thead>
                <tr>
                  <th>采集时间</th>
                  <th>当时指标</th>
                  <th>来源档案</th>
                </tr>
              </thead>
              <tbody>
                {history.data.items.map((observation) => {
                  const metric = primaryKeywordMetric(observation.metrics);
                  return (
                    <tr key={observation.id}>
                      <td>
                        {observation.observedAt
                          ? formatTime(observation.observedAt)
                          : "时间未知"}
                      </td>
                      <td>
                        <details>
                          <summary>
                            {metric.label}：{metric.value}
                            {metric.note ? (
                              <small> · {metric.note}</small>
                            ) : null}
                          </summary>
                          <MetricList metrics={observation.metrics} />
                        </details>
                      </td>
                      <td>
                        <Button
                          size="compact"
                          onClick={() => setQueryId(observation.queryId)}
                          aria-pressed={queryId === observation.queryId}
                        >
                          查看来源
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : history.data && !history.error ? (
          <Empty title="暂无此词的历史记录" compact>
            后续采集会在这里保留各次指标与来源。
          </Empty>
        ) : null}
        {history.data ? (
          <Pagination
            label="词条历史分页"
            page={page}
            pageSize={history.data.pageSize}
            total={history.data.total}
            disabled={history.loading}
            onPageChange={setPage}
          />
        ) : null}
      </section>
      {queryId ? (
        <section
          className="knowledge-detail-section"
          aria-label="所选采集来源档案"
        >
          <div className="section-heading">
            <h3>来源档案</h3>
            <Button size="compact" quiet onClick={() => setQueryId(null)}>
              收起来源
            </Button>
          </div>
          <KnowledgeSourceArchive queryId={queryId} />
        </section>
      ) : null}
    </Dialog>
  );
}

/** Read only the source explicitly requested by a term history or query archive. */
export function KnowledgeSourceArchive({ queryId }: { queryId: string }) {
  const { command, notify } = useAppActions();
  const { busy } = useAppActivity();
  const source = useIpcQuery("traffic.knowledge.detail", { id: queryId });
  return (
    <div className="knowledge-detail-source">
      <QueryError
        title="来源档案暂未读取成功"
        error={source.error}
        loading={source.loading}
        onRetry={source.reload}
      />
      {source.loading && !source.data ? (
        <LoadingState label="正在读取来源档案…" compact />
      ) : null}
      {source.data ? (
        <div key={source.data.query.id}>
          <p className="knowledge-detail-message">
            {knowledgeEndpointName(source.data.query.endpoint)}
            {source.data.query.receivedAt
              ? ` · ${formatTime(source.data.query.receivedAt)}`
              : ""}
          </p>
          {source.data.query.message ? (
            <p className="knowledge-detail-message">
              {source.data.query.message}
            </p>
          ) : null}
          <details className="knowledge-detail-raw">
            <summary>查看原始查询与响应</summary>
            <h4>查询参数</h4>
            <pre>
              {JSON.stringify(
                {
                  parameters: source.data.query.request,
                  seeds: source.data.query.seeds,
                  httpStatus: source.data.query.httpStatus,
                },
                null,
                2,
              )}
            </pre>
            <h4>归档响应</h4>
            {!source.data.response && source.data.recoveredObservations ? (
              <p className="knowledge-detail-message">
                原始响应未保存，以下为保留的历史词条证据。
              </p>
            ) : null}
            <pre>
              {source.data.response ??
                source.data.recoveredObservations ??
                "当时未取得完整响应，已保留的词条与来源仍可查看。"}
            </pre>
          </details>
          <Button
            disabled={busy > 0}
            onClick={async () => {
              const path = await command("traffic.knowledge.exportQuery", {
                id: queryId,
              });
              if (path) notify(`查询档案已导出：${path}`, "success");
            }}
          >
            <Download size={14} />
            导出此来源 JSON
          </Button>
        </div>
      ) : null}
    </div>
  );
}

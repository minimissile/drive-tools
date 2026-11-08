import { useState } from "react";
import type { KnowledgeFilter } from "../../shared/traffic-knowledge";
import { useIpcQuery } from "../api/useIpcQuery";
import { formatTime } from "../lib/format";
import { Button, Empty, LoadingState } from "../ui/primitives";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import {
  knowledgeEndpointName,
  knowledgePlatformName,
  knowledgeStatusNames,
} from "./knowledge";
import { KnowledgeSourceArchive } from "./TrafficKnowledgeDetails";

export function TrafficQueryArchive({ filter }: { filter: KnowledgeFilter }) {
  return (
    <Archive
      key={JSON.stringify([
        filter.search,
        filter.endpoint,
        filter.platform,
        filter.kind,
        filter.volume,
      ])}
      filter={filter}
    />
  );
}
function Archive({ filter }: { filter: KnowledgeFilter }) {
  const [page, setPage] = useState(1),
    [queryId, setQueryId] = useState("");
  const query = useIpcQuery(
    "traffic.knowledge.list",
    {
      ...filter,
      cursor: undefined,
      view: "queries",
      page,
      sort: "recent",
    },
    { keepPrevious: true },
  );
  return (
    <section className="knowledge-query-archive" aria-label="查询档案">
      <QueryError
        title="查询档案读取失败"
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
      />
      {query.loading && !query.data ? (
        <LoadingState label="正在读取查询档案…" compact />
      ) : query.data?.queries.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>采集时间</th>
                <th>来源</th>
                <th>查询主题 / 平台</th>
                <th>词条数</th>
                <th>状态</th>
                <th>档案</th>
              </tr>
            </thead>
            <tbody>
              {query.data.queries.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.receivedAt || item.startedAt
                      ? formatTime((item.receivedAt ?? item.startedAt)!)
                      : "时间未记录"}
                  </td>
                  <td>{knowledgeEndpointName(item.endpoint)}</td>
                  <td>
                    {item.seeds.join("、") || "未限定"}
                    <small>{knowledgePlatformName(item.platform)}</small>
                  </td>
                  <td>{item.count}</td>
                  <td>{knowledgeStatusNames[item.status] ?? item.status}</td>
                  <td>
                    <Button
                      quiet
                      size="compact"
                      onClick={() =>
                        setQueryId(queryId === item.id ? "" : item.id)
                      }
                    >
                      {queryId === item.id ? "收起" : "查看档案"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !query.error && !query.loading ? (
        <Empty title="没有匹配的查询档案" compact />
      ) : null}
      {query.data ? (
        <Pagination
          label="查询档案分页"
          page={page}
          pageSize={query.data.pageSize}
          total={query.data.total}
          disabled={query.loading}
          onPageChange={(next) => {
            setPage(next);
            setQueryId("");
          }}
        />
      ) : null}
      {queryId ? (
        <KnowledgeSourceArchive key={queryId} queryId={queryId} />
      ) : null}
    </section>
  );
}

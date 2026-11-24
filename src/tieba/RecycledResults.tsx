import { ArrowUpRight, Archive } from "lucide-react";
import { useState } from "react";
import { tiebaDiscoveryPageSize, tiebaDiscoveryRecycleLimit, type TiebaRecycledFilters } from "../../shared/tieba-resource-discovery";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions } from "../state";
import { Button, Empty, LoadingState, Notice } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { ClearableField } from "../ui/ClearableField";
import { Select } from "../ui/Select";
import { AnalysisPages } from "./AnalysisPages";
import { formatAnalysisCount, formatAnalysisTime } from "./AnalysisThreadsTable";
import { DiscoveryPageRefresh } from "./DiscoveryPageRefresh";

const sourceLabels = { potential: "潜力帖", pending: "待观察", traffic: "流量帖" };
const reasonLabels = {
  belowThreshold: "复查流量未达标",
  observationExpired: "已超出观察期",
  resource: "复查未通过资源校验",
};

export function RecycledResults({ count, reviewReady, refreshSnapshot }: { count?: number; reviewReady: boolean; refreshSnapshot: () => void }) {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<TiebaRecycledFilters>({ source: "all", reason: "all", sort: "recycledAt" });
  const [viewsInput, setViewsInput] = useState("");
  const { command } = useAppActions();
  const filtering = filters.source !== "all" || filters.reason !== "all" || filters.minViews !== undefined;
  function filterBy(patch: Partial<TiebaRecycledFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  }
  const { data, error, loading, reload } = useIpcQuery("tieba.discovery.recycled", { page, ...filters }, {
    enabled: count !== undefined,
    revision: count,
    delay: 120,
    keepPrevious: true,
  });
  if (count === undefined) return <Notice warning>点击顶部「应用更新并重启」，启用回收贴。</Notice>;

  return (
    <>
      {reviewReady && count > 0 ? (
        <div className="tieba-discovery-list-toolbar">
          <div className="tieba-discovery-run-controls">
            <Select aria-label="按回收来源筛选" value={filters.source} items={[
              { value: "all", label: "全部来源" },
              ...Object.entries(sourceLabels).map(([value, label]) => ({ value, label })),
            ]} onValueChange={(source) => {
              if (source === "all" || source === "potential" || source === "pending" || source === "traffic") filterBy({ source });
            }} />
            <Select aria-label="按回收原因筛选" value={filters.reason} items={[
              { value: "all", label: "全部原因" },
              ...Object.entries(reasonLabels).map(([value, label]) => ({ value, label })),
            ]} onValueChange={(reason) => {
              if (reason === "all" || reason === "belowThreshold" || reason === "observationExpired" || reason === "resource") filterBy({ reason });
            }} />
            <div className="tieba-recycled-views-filter">
              <ClearableField type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1}
                aria-label="最低累计浏览量" placeholder="最低累计浏览" clearLabel="清除浏览量筛选"
                value={viewsInput} onValueChange={(value) => {
                  setViewsInput(value);
                  const views = Number(value);
                  filterBy({ minViews: value && Number.isSafeInteger(views) && views >= 0 ? views : undefined });
                }} />
            </div>
            <Select aria-label="回收贴排序" value={filters.sort}
              items={[{ value: "recycledAt", label: "最新回收优先" }, { value: "views", label: "累计浏览从高到低" }]}
              onValueChange={(sort) => {
                if (sort === "recycledAt" || sort === "views") filterBy({ sort });
              }} />
          </div>
          <DiscoveryPageRefresh
            disabled={loading}
            request={{ kind: "recycled", ids: data?.items.map(({ post }) => post.id) ?? [] }}
            onRefresh={() => { reload(); refreshSnapshot(); }}
          />
        </div>
      ) : null}
      <QueryError error={error} loading={loading} onRetry={reload} />
      {!data && !error ? <LoadingState label="正在读取回收贴…" layout="list" compact /> : null}
      {data?.total === 0 && !loading ? <Empty icon={Archive} title={filtering ? "没有符合筛选条件的回收贴" : "暂无回收贴"} compact>
        {filtering ? "可调整来源、回收原因或最低浏览量。" : "潜力帖、待观察和流量帖中被筛掉的帖子会出现在这里。"}
      </Empty> : null}
      {data?.total ? <p className="muted tieba-discovery-note">保留最近 {tiebaDiscoveryRecycleLimit} 条回收贴。</p> : null}
      {data?.total ? (
        <AnalysisPages
          page={data.page}
          total={data.total}
          pageSize={tiebaDiscoveryPageSize}
          label="回收贴分页"
          loading={loading}
          loadingLabel="正在读取回收贴…"
          onPageChange={setPage}
        >
          <div className="table-scroll">
            <table className="tieba-discovery-post-table tieba-recycled-table" aria-label="回收贴">
              <thead>
                <tr>
                  <th scope="col">帖子</th>
                  <th scope="col">来源</th>
                  <th scope="col">回收原因</th>
                  <th scope="col">累计浏览</th>
                  <th scope="col">回收时间</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map(({ post, source, reason, recycledAt }) => (
                  <tr key={post.id}>
                    <td>
                      <Button quiet size="compact" className="tieba-analysis-link" onClick={() => void command("system.external", { url: post.url })}>
                        <span>{post.title}</span><ArrowUpRight size={14} aria-hidden="true" />
                      </Button>
                      <small className="muted">{post.forum} · 发布于 {formatAnalysisTime(post.publishedAt)}</small>
                    </td>
                    <td>{sourceLabels[source]}</td>
                    <td>{reasonLabels[reason]}</td>
                    <td>
                      {formatAnalysisCount(post.views)}
                      {post.checkedAt != null ? <small className="muted" title="最近流量读取时间">读取 {formatAnalysisTime(post.checkedAt)}</small> : null}
                    </td>
                    <td>{formatAnalysisTime(recycledAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AnalysisPages>
      ) : null}
    </>
  );
}

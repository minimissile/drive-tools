import { ArrowUpRight, ClipboardCheck, Copy } from "lucide-react";
import { useState } from "react";
import {
  tiebaDiscoveryFilterAuditLimit as limit,
  tiebaDiscoveryPageSize as pageSize,
  type TiebaDiscoveryFilterAuditSummary,
  type TiebaDiscoveryFilterSample,
  type TiebaFilterAuditSort,
  type TiebaTrafficSortDirection,
} from "../../shared/tieba-resource-discovery";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions } from "../state";
import { Button, Empty, LoadingState, Notice } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { AnalysisPages } from "./AnalysisPages";
import { formatAnalysisCount, formatAnalysisTime } from "./AnalysisThreadsTable";
import { DiscoveryPageRefresh } from "./DiscoveryPageRefresh";

const rate = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const sortOptions = [
  { value: "sampledAt", label: "抽查时间" },
  { value: "views", label: "累计浏览" },
  { value: "publishedAt", label: "发帖时间" },
] satisfies { value: TiebaFilterAuditSort; label: string }[];

export function FilterAuditResults({
  audit,
  auto,
  starting,
  sortReady,
  onStart,
  refreshSnapshot,
}: {
  audit: TiebaDiscoveryFilterAuditSummary | null | undefined;
  auto: boolean;
  starting: boolean;
  sortReady: boolean;
  onStart(): void;
  refreshSnapshot(): void;
}) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<TiebaFilterAuditSort>("sampledAt");
  const [direction, setDirection] = useState<TiebaTrafficSortDirection>("asc");
  const { command, notify } = useAppActions();
  const query = useIpcQuery("tieba.discovery.filterAudit", { page, sort, direction }, {
    enabled: audit != null,
    revision: audit?.batch,
    keepPrevious: true,
  });
  const data = query.data?.batch === audit?.batch ? query.data : null;
  if (audit === undefined)
    return <Notice warning>点击顶部「应用更新并重启」，启用筛查抽查。</Notice>;

  const active = audit !== null && audit.count < limit;
  async function copyNumber(number: string) {
    try {
      await ipc("system.copyText", { text: number });
      notify(`已复制编号 ${number}`, "success");
    } catch {
      notify("复制编号失败，可选中文字手动复制。", "error");
    }
  }

  return (
    <>
      <div className="tieba-discovery-list-toolbar">
        <div>
          <strong role="status">
            {audit
              ? `${active ? "抽查中" : "本轮已完成"} · 已记录 ${audit.count} / ${limit} 条`
              : "尚未开始抽查"}
          </strong>
          <div className="muted">
            {audit && !active
              ? "开始新一轮会替换本轮样本。"
              : `记录开始后被筛掉的 ${limit} 篇不同帖子，抽满即停止。`}
          </div>
        </div>
        <div className="tieba-discovery-run-controls">
          {sortReady && !!audit?.count ? (
            <>
              <Select
                aria-label="抽查样本排序"
                value={sort}
                items={sortOptions}
                onValueChange={(value) => {
                  const option = sortOptions.find((item) => item.value === value);
                  if (!option || option.value === sort) return;
                  setSort(option.value);
                  setDirection(option.value === "sampledAt" ? "asc" : "desc");
                  setPage(1);
                }}
              />
              <Select
                aria-label="排序方向"
                value={direction}
                items={[
                  { value: "desc", label: sort === "views" ? "从高到低" : "最新优先" },
                  { value: "asc", label: sort === "views" ? "从低到高" : "最早优先" },
                ]}
                onValueChange={(value) => {
                  if (value !== "asc" && value !== "desc") return;
                  setDirection(value);
                  setPage(1);
                }}
              />
            </>
          ) : null}
          {audit ? (
            <DiscoveryPageRefresh
              disabled={query.loading}
              onRefresh={() => {
                query.reload();
                refreshSnapshot();
              }}
            />
          ) : null}
          <Button
            primary
            size="compact"
            disabled={active || starting}
            onClick={onStart}
          >
            {starting ? "正在开始…" : active ? "抽查中" : audit ? "开始新一轮" : "开始抽查"}
          </Button>
        </div>
      </div>
      <QueryError error={query.error} loading={query.loading} onRetry={query.reload} />
      {audit && !data && !query.error ? (
        <LoadingState label="正在读取抽查样本…" layout="list" compact />
      ) : null}
      {!audit || (data && !data.total) ? (
        <Empty icon={ClipboardCheck} title={audit ? "等待筛查样本" : "暂无抽查样本"} compact>
          {active && !auto
            ? "可以开始持续发现，或到「扫描日志」手动扫一轮。"
            : "持续发现或手动扫描时，被筛掉的帖子会按顺序出现在这里。"}
        </Empty>
      ) : null}
      {data?.total ? (
        <AnalysisPages
          page={data.page}
          total={data.total}
          pageSize={pageSize}
          label="筛查抽查分页"
          loading={query.loading}
          loadingLabel="正在读取抽查样本…"
          onPageChange={setPage}
        >
          <div className="table-scroll">
            <table className="tieba-discovery-post-table tieba-filter-audit-table" aria-label="筛查抽查样本">
              <thead>
                <tr>
                  <th scope="col">帖子</th>
                  <th scope="col">过滤原因</th>
                  <th scope="col">累计浏览</th>
                  <th scope="col">编号 · 抽查时间</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map(({ number, sampledAt, post, reason }) => (
                  <tr key={number}>
                    <td>
                      <Button
                        quiet
                        size="compact"
                        className="tieba-analysis-link"
                        onClick={() => void command("system.external", { url: post.url })}
                      >
                        <span>{post.title}</span>
                        <ArrowUpRight size={14} aria-hidden="true" />
                      </Button>
                      <small className="muted">{post.forum} · 发布于 {formatAnalysisTime(post.publishedAt)}</small>
                    </td>
                    <td><FilterReason reason={reason} /></td>
                    <td>{formatAnalysisCount(post.views)}</td>
                    <td>
                      <Button quiet size="compact" aria-label={`复制编号 ${number}`} onClick={() => void copyNumber(number)}>
                        {number}<Copy size={14} aria-hidden="true" />
                      </Button>
                      <small className="muted">{formatAnalysisTime(sampledAt)}</small>
                    </td>
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

function FilterReason({ reason }: { reason: TiebaDiscoveryFilterSample["reason"] }) {
  switch (reason.kind) {
    case "recentResource":
      return "常规扫描未识别到资源线索";
    case "recentDetailLink":
      return "列表无线索，详情与近期回复未发现网盘链接";
    case "oldResource":
      return "老帖标题、正文和近期回复未命中资源线索";
    case "oldTraffic":
      return (
        <>
          老帖流量初筛未达标
          <small className="muted">
            门槛 {formatAnalysisCount(reason.minViews)} 次累计浏览、{rate.format(reason.minDailyViews)} 次/天
            · 该帖 {rate.format(reason.dailyViews)} 次/天
          </small>
        </>
      );
  }
}

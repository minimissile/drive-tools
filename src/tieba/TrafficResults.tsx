import { ArrowUpRight, Check, Radar } from "lucide-react";
import { useState } from "react";
import {
  oldTrafficMinimumAgeDays,
  oldTrafficObservationDays,
  tiebaDiscoveryPageSize,
  type TiebaDiscoverySnapshot,
  type TiebaTrafficPostsView,
  type TiebaTrafficSort,
  type TiebaTrafficSortDirection,
  type TiebaOldResourceFilter,
  type TiebaOldTrafficPost,
} from "../../shared/tieba-resource-discovery";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions } from "../state";
import { useFeedbackActions } from "../state/feedback";
import { Button, Empty, LoadingState, Notice } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { DiscoveryPageRefresh } from "./DiscoveryPageRefresh";
import { formatDiscoveryResource } from "./discovery-resource-label";
import { AnalysisPages } from "./AnalysisPages";
import { PostExposureCell } from "./PostExposureCell";
import {
  formatAnalysisCount,
  formatAnalysisTime,
} from "./AnalysisThreadsTable";

const rate = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const day = 24 * 60 * 60 * 1000;
const resourceFilters = [
  { value: "all", label: "全部内容" },
  { value: "linked", label: "含网盘链接" },
  { value: "keywords", label: "仅关键词" },
] satisfies { value: TiebaOldResourceFilter; label: string }[];
const sortOptions = [
  { value: "archivedAt", label: "录入时间" },
  { value: "views", label: "累计浏览" },
  { value: "lifetimeDailyViews", label: "发帖以来日均" },
  { value: "dailyAddedViews", label: "实测日均新增" },
] satisfies { value: TiebaTrafficSort; label: string }[];

function resourceLabel(
  resource: TiebaOldTrafficPost["resource"],
  checkEnabled: boolean,
) {
  if (resource?.linkSources.length)
    return formatDiscoveryResource(resource);
  if (!checkEnabled && !resource?.checked) return "未校验资源";
  if (resource?.checked) return formatDiscoveryResource(resource);
  return resource?.keywords.length ? `待查详情 · ${formatDiscoveryResource(resource)}` : "待查详情";
}

export function TrafficResults({
  result,
  resourceReady,
  resourceAdmission,
  resourcePending,
  threshold,
  enabled,
  revision,
  refreshSnapshot,
  resourceCheckEnabled,
  progress,
  scanDisabled,
  onScan,
  onStop,
}: {
  result: TiebaDiscoverySnapshot["oldTraffic"];
  resourceReady: boolean;
  resourceAdmission: boolean;
  resourcePending?: number;
  threshold: number;
  enabled: boolean;
  revision?: number;
  refreshSnapshot: () => void;
  resourceCheckEnabled: boolean;
  progress: TiebaDiscoverySnapshot["historyProgress"];
  scanDisabled: boolean;
  onScan: () => void;
  onStop?: () => void;
}) {
  const { command } = useAppActions();
  const { notify } = useFeedbackActions();
  const [page, setPage] = useState(1);
  const [view, setView] = useState<Exclude<TiebaTrafficPostsView, "high">>("all");
  const [resource, setResource] = useState<TiebaOldResourceFilter>("all");
  const [sort, setSort] = useState<TiebaTrafficSort>("archivedAt");
  const [direction, setDirection] = useState<TiebaTrafficSortDirection>("desc");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [marking, setMarking] = useState<string | null>(null);
  const oldOnly = view === "screened" || view === "qualified";
  const ready = result?.total !== undefined && progress !== undefined;
  const { data, error, loading, reload } = useIpcQuery(
    "tieba.discovery.trafficPosts",
    { page, view, resource: oldOnly && resourceReady ? resource : "all", sort, direction },
    {
      enabled: enabled && ready,
      keepPrevious: true,
      revision: `${revision ?? ""}:${threshold}:${progress?.revision ?? ""}:${resourceCheckEnabled}`,
    },
  );
  const resourceMarkReady = data?.items[0]?.resourceRecorded !== undefined;

  async function markResource(id: string, recorded: boolean) {
    if (marking !== null) return;
    setMarking(id);
    try {
      await ipc("tieba.discovery.setResourceRecorded", { id, recorded });
      reload();
      notify(recorded ? "已标记为已入库" : "已取消入库标记", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存入库标记失败，请重试", "error");
    } finally {
      setMarking(null);
    }
  }

  async function deletePost(id: string) {
    if (deleting) return;
    setDeleting(id);
    try {
      await ipc("tieba.discovery.deleteOldResource", { id });
      reload();
      refreshSnapshot();
      notify("已删除老帖", "success");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "删除失败，请重试",
        "error",
      );
    } finally {
      setDeleting(null);
    }
  }
  if (!enabled) return null;
  if (!ready)
    return (
      <Notice warning>点击顶部「应用更新并重启」，加载新版流量帖。</Notice>
    );

  return (
    <>
      <div className="tieba-traffic-toolbar">
        <div className="tieba-discovery-run-controls">
          <Select
            aria-label="流量帖筛选"
            value={view}
            items={[
              { value: "all", label: "全部流量帖" },
              {
                value: "screened",
                label: `老帖 · 通过初筛 ${formatAnalysisCount(result.tracked)}`,
              },
              {
                value: "qualified",
                label: `老帖 · 实测达标 ${formatAnalysisCount(result.total)}`,
              },
            ]}
            onValueChange={(value) => {
              if (value === "all" || value === "screened" || value === "qualified")
                setView(value);
              setPage(1);
            }}
          />
          {oldOnly && resourceReady ? (
            <Select
              aria-label="资源线索"
              value={resource}
              items={resourceFilters}
              onValueChange={(value) => {
                const filter = resourceFilters.find((item) => item.value === value);
                if (!filter) return;
                setResource(filter.value);
                setPage(1);
              }}
            />
          ) : null}
          <Select
            aria-label="流量帖排序"
            value={sort}
            items={sortOptions}
            onValueChange={(value) => {
              const option = sortOptions.find((item) => item.value === value);
              if (!option) return;
              setSort(option.value);
              setPage(1);
            }}
          />
          <Select
            aria-label="排序方向"
            value={direction}
            items={[
              { value: "desc", label: sort === "archivedAt" ? "最新优先" : "从高到低" },
              { value: "asc", label: sort === "archivedAt" ? "最早优先" : "从低到高" },
            ]}
            onValueChange={(value) => {
              if (value !== "asc" && value !== "desc") return;
              setDirection(value);
              setPage(1);
            }}
          />
          {oldOnly ? <small className="muted">
            {resourcePending
              ? `${formatAnalysisCount(resourcePending)} 篇待核验 · `
              : ""}
            实测门槛为日均新增超过 {rate.format(threshold)} 次
          </small> : null}
        </div>
        {progress ? (
          <div className="tieba-discovery-run-controls">
            <small className="muted" role="status">
              {progress.forum
                ? `「${progress.forum}」第 ${progress.page} 页 · `
                : ""}
              已扫完 {progress.completed}/{progress.total} 个吧
            </small>
            <DiscoveryPageRefresh
              request={{
                kind: "trafficPosts",
                ids: data?.items.map(({ id }) => id) ?? [],
              }}
              disabled={loading}
              onRefresh={() => {
                reload();
                refreshSnapshot();
              }}
            />
            {progress.forum && onStop ? (
              <Button size="compact" onClick={onStop}>
                停止本次扫描
              </Button>
            ) : (
              <Button
                size="compact"
                disabled={
                  scanDisabled ||
                  !!progress.forum ||
                  progress.completed === progress.total
                }
                onClick={onScan}
              >
                扫描下一个吧
              </Button>
            )}
          </div>
        ) : null}
      </div>
      <QueryError error={/UNKNOWN_METHOD|不支持此操作|未注册.*操作/.test(error)
        ? "请在顶部点击「应用更新并重启」，然后重试。"
        : error} loading={loading} onRetry={reload} />
      {!data && !error ? (
        <LoadingState label="正在读取流量帖…" layout="list" compact />
      ) : null}
      {data?.items.length ? (
        <AnalysisPages
          page={data.page}
          pageSize={tiebaDiscoveryPageSize}
          total={data.total}
          loading={loading}
          loadingLabel="正在读取流量帖…"
          onPageChange={setPage}
          label="流量帖分页"
        >
          <div className="table-scroll">
            <table
              className="tieba-discovery-post-table tieba-traffic-table"
              aria-label="流量帖"
            >
              <thead>
                <tr>
                  <th scope="col">帖子</th>
                  <th scope="col">累计浏览</th>
                  <th scope="col">发帖以来日均</th>
                  <th scope="col">实测日均新增</th>
                  <th scope="col">观测跨度 · 最近读数</th>
                  {resourceMarkReady ? <th scope="col" className="tieba-traffic-mark">资源入库</th> : null}
                  {resourceAdmission ? <th scope="col" className="tieba-traffic-action">操作</th> : null}
                </tr>
              </thead>
              <tbody>
                {data.items.map((post) => (
                  <tr key={post.id}>
                    <td>
                      <Button
                        quiet
                        size="compact"
                        className="tieba-analysis-link"
                        onClick={() =>
                          void command("system.external", { url: post.url })
                        }
                      >
                        <span>{post.title}</span>
                        <ArrowUpRight size={14} aria-hidden="true" />
                      </Button>
                      <small className="muted">
                        {post.forum} · 发布于{" "}
                        {formatAnalysisTime(post.publishedAt)}
                        {post.kind === "high" && post.author ? ` · ${post.author}` : ""}
                      </small>
                      <small className="muted">
                        {post.kind === "old" ? "老帖流量" : post.fromPotential ? "累计高流量 · 由潜力帖转入" : "累计高流量"}
                        {post.kind === "old" && resourceReady
                          ? ` · ${resourceLabel(post.resource, resourceCheckEnabled)}`
                          : post.resource && post.kind === "high" ? ` · ${formatDiscoveryResource(post.resource)}` : ""}
                      </small>
                    </td>
                    <td><strong>{formatAnalysisCount(post.views)}</strong></td>
                    {post.kind === "old" ? <td>{rate.format(post.lifetimeDailyViews)} 次/天</td> : (
                      <PostExposureCell views={post.views} publishedAt={post.publishedAt}
                        observedAt={post.checkedAt} unit="day" />
                    )}
                    <td>
                      {post.kind === "high" ? <span className="muted" aria-label="无需复查">—</span>
                        : post.dailyAddedViews === null ? (
                        <span className="muted">待复查</span>
                      ) : (
                        <>
                          <strong>
                            {rate.format(post.dailyAddedViews)} 次/天
                          </strong>
                          <small className="muted">
                            +{formatAnalysisCount(post.addedViews)} 次
                            {post.sustained ? " · 持续增长" : ""}
                          </small>
                        </>
                      )}
                    </td>
                    <td>
                      {post.kind === "old" && post.baselineAt !== null ? (
                        <span
                          title={`${formatAnalysisTime(post.baselineAt)} 至 ${formatAnalysisTime(post.observationAt ?? post.checkedAt)}`}
                        >
                          {rate.format(
                            ((post.observationAt ?? post.checkedAt) -
                              post.baselineAt) /
                              day,
                          )}{" "}
                          天
                        </span>
                      ) : null}
                      <small className="muted">
                        <time dateTime={new Date(post.checkedAt).toISOString()}>
                          {formatAnalysisTime(post.checkedAt)}
                        </time>
                      </small>
                      {post.archivedAt != null ? (
                        <small className="muted">录入 {formatAnalysisTime(post.archivedAt)}</small>
                      ) : null}
                    </td>
                    {resourceMarkReady ? (
                      <td className="tieba-traffic-mark">
                        <Button
                          size="compact"
                          className="tieba-traffic-mark-button"
                          aria-label={`已入库标记 ${post.title}`}
                          aria-pressed={post.resourceRecorded === true}
                          title={post.resourceRecorded ? "取消已入库标记" : "标为已入库"}
                          disabled={loading || marking !== null || deleting === post.id}
                          onClick={() => void markResource(post.id, !post.resourceRecorded)}
                        >
                          {post.resourceRecorded ? <Check size={14} aria-hidden="true" /> : null}
                          {marking === post.id ? "保存中…" : post.resourceRecorded ? "已入库" : "标为已入库"}
                        </Button>
                      </td>
                    ) : null}
                    {resourceAdmission ? (
                      <td className="tieba-traffic-action">
                        {post.kind === "old" ? <Button
                          quiet
                          size="compact"
                          disabled={loading || deleting !== null || marking === post.id}
                          aria-label={`删除老帖 ${post.title}`}
                          onClick={() => void deletePost(post.id)}
                        >
                          {deleting === post.id ? "删除中…" : "删除"}
                        </Button> : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AnalysisPages>
      ) : data ? (
        <Empty
          icon={Radar}
          title={
            oldOnly && resource !== "all"
              ? "没有符合筛选的帖子"
              : view === "qualified"
                ? "暂无实测达标老帖"
                : view === "screened" ? "暂无通过初筛的老帖"
                  : "暂无流量帖"
          }
          compact
        >
          {oldOnly && resource !== "all"
            ? "可切换到「全部内容」查看已入库帖子。"
            : view === "all"
              ? "达到收录条件的帖子会显示在这里。"
              : result.tracked
              ? `两次读数相隔至少 ${oldTrafficObservationDays} 天后，按实际间隔计算日均新增。关闭应用期间的间隔也计入。`
              : `发帖满 ${oldTrafficMinimumAgeDays} 天的帖子需通过流量初筛${resourceCheckEnabled ? "和资源检查" : ""}。`}
        </Empty>
      ) : null}
    </>
  );
}


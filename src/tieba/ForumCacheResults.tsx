import { useEffect, useState } from "react";
import { ArrowUpRight, Search } from "lucide-react";
import {
  tiebaForumCachePageSize,
  tiebaForumCacheSorts,
  type TiebaForumCacheSort,
} from "../../shared/tieba-analysis";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions } from "../state";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Button, Empty, Loading, LoadingState, Panel } from "../ui/primitives";
import { AnalysisPages } from "./AnalysisPages";
import {
  AnalysisThreadsTable,
  formatAnalysisCount,
} from "./AnalysisThreadsTable";

const sortItems = [
  { value: "published", label: "发布时间从新到旧" },
  { value: "replied", label: "最近回复优先" },
  { value: "views", label: "浏览量从高到低" },
  { value: "exposure", label: "曝光潜力从高到低" },
];

export function ForumCacheResults({
  name,
  revision,
  changing,
  actionError,
  onControl,
  onFindAuthor,
}: {
  name: string;
  revision: number;
  changing: boolean;
  actionError: string;
  onControl(action: "start" | "pause" | "restart"): void;
  onFindAuthor(target: string): void;
}) {
  const { command } = useAppActions();
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<TiebaForumCacheSort>("views");
  const { data, loading, error, reload } = useIpcQuery(
    "tieba.analysis.forumCache",
    { name, page, sort },
    { enabled: !!name, revision, keepPrevious: true },
  );
  const status = data?.status;
  useEffect(() => {
    if (status !== "reading" || loading || error) return;
    const timer = setTimeout(reload, 2500);
    return () => clearTimeout(timer);
  }, [status, loading, error, reload]);
  if (!name)
    return (
      <Panel>
        <Empty icon={Search} title="等待整吧读取" compact>
          输入吧名或首页链接，查询后开始缓存公开主题帖。
        </Empty>
      </Panel>
    );
  const url = data?.forum?.url;
  const queryError = /UNKNOWN_METHOD|不支持此操作|未注册.*操作/.test(error)
    ? "请在顶部点击「应用更新并重启」，然后重试。"
    : error;
  const needsRead = !data && !queryError && !actionError;
  return (
    <Panel
      title={`${data?.forum?.name ?? name} · 整吧缓存`}
      extra={
        url ? (
          <Button
            quiet
            size="compact"
            onClick={() => void command("system.external", { url })}
          >
            打开贴吧 <ArrowUpRight size={14} aria-hidden="true" />
          </Button>
        ) : null
      }
    >
      <QueryError
        error={actionError || queryError || data?.error || ""}
        title={status === "error" ? "整吧读取已暂停" : "暂时无法读取整吧缓存"}
        loading={changing}
        onRetry={() =>
          actionError || data?.error ? onControl("start") : reload()
        }
      />
      {data ? (
        <div className="tieba-analysis-toolbar tieba-forum-cache-toolbar">
          <Select
            aria-label="整吧缓存排序"
            items={sortItems}
            value={sort}
            onValueChange={(value) => {
              const next = tiebaForumCacheSorts.find((item) => item === value);
              if (next && next !== sort) {
                setSort(next);
                setPage(1);
              }
            }}
          />
          <div className="tieba-forum-cache-progress">
            <span role="status" className="muted">
              已加载 <strong>{formatAnalysisCount(data.total)}</strong> 篇
              {data.scannedPages
                ? ` · 已读 ${formatAnalysisCount(data.scannedPages)} 页`
                : ""}
              {status === "reading" || changing ? (
                <Loading label="正在读取…" announce={false} />
              ) : status === "complete" ? (
                " · 已读完公开列表"
              ) : status === "paused" ? (
                " · 已暂停"
              ) : (
                ""
              )}
            </span>
            {status === "complete" || status === "paused" ? (
              <Button
                size="compact"
                disabled={changing}
                onClick={() =>
                  onControl(status === "complete" ? "restart" : "start")
                }
              >
                {status === "complete" ? "重新读取" : "继续读取"}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {data?.threads.length ? (
        <AnalysisPages
          page={data.page}
          pageSize={tiebaForumCachePageSize}
          total={data.total}
          loading={loading && data.page !== page}
          label="整吧缓存分页"
          onPageChange={setPage}
        >
          <AnalysisThreadsTable
            threads={data.threads}
            scope="forum"
            observedAt={data.observedAt}
            onFindAuthor={onFindAuthor}
          />
        </AnalysisPages>
      ) : status === "reading" || changing || needsRead ? (
        <LoadingState label="正在加载公开主题帖…" layout="list" compact />
      ) : !queryError && !actionError && status !== "error" ? (
        <Empty title="整吧缓存暂无帖子" compact />
      ) : null}
    </Panel>
  );
}

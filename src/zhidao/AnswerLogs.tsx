import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, RefreshCw, ScrollText } from "lucide-react";
import { useIpcQuery } from "../api/useIpcQuery";
import { Button, Empty, LoadingState, Panel } from "../ui/primitives";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { formatTime } from "../lib/format";

const levels = {
  info: "信息",
  success: "成功",
  warning: "提醒",
  error: "错误",
};

export function AnswerLogs({
  runId,
  running,
}: {
  runId: string;
  running: boolean;
}) {
  const [page, setPage] = useState(1);
  const [follow, setFollow] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const logs = useIpcQuery(
    "zhidao.answer.logs",
    { id: runId, page },
    {
      enabled: !!runId,
      refreshInterval: running ? 2000 : 0,
      keepPrevious: true,
    },
  );
  const data = logs.data?.runId === runId ? logs.data : null;
  const lastId = data?.items.at(-1)?.id;
  useEffect(() => {
    if (!follow || page !== 1 || !viewport.current) return;
    viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [lastId, follow, page]);
  return (
    <Panel
      title="回答日志"
      className="answer-logs"
      extra={
        <div className="answer-monitor-actions">
          <Button
            quiet
            size="compact"
            disabled={!runId || logs.loading}
            onClick={logs.reload}
            aria-label="刷新回答日志"
            title="刷新日志"
          >
            <RefreshCw size={14} />
          </Button>
          <Button
            quiet
            size="compact"
            disabled={!runId}
            aria-pressed={follow && page === 1}
            onClick={() => {
              setPage(1);
              setFollow(true);
            }}
          >
            <ArrowDownToLine size={14} />
            {follow && page === 1 ? "跟随最新" : "回到最新"}
          </Button>
        </div>
      }
    >
      <QueryError
        title="回答日志读取失败"
        error={logs.error}
        loading={logs.loading}
        onRetry={logs.reload}
      />
      <div
        className="answer-log-window"
        data-empty={!data?.items.length || undefined}
        ref={viewport}
        role="log"
        aria-label="回答执行日志"
        aria-live="off"
        tabIndex={0}
        onScroll={(event) => {
          const node = event.currentTarget;
          if (page === 1)
            setFollow(
              node.scrollHeight - node.scrollTop - node.clientHeight < 40,
            );
        }}
      >
        {!runId ? (
          <Empty title="等待开始回答" compact icon={ScrollText}>
            开始后会在这里记录取题、生成、提交和异常信息。
          </Empty>
        ) : !data && !logs.error ? (
          <LoadingState compact label="正在读取回答日志…" />
        ) : data?.items.length ? (
          <ol className="answer-log-lines">
            {data.items.map((entry) => (
              <li key={entry.id} data-level={entry.level}>
                <time
                  dateTime={entry.createdAt}
                  title={formatTime(entry.createdAt)}
                >
                  {new Date(entry.createdAt).toLocaleTimeString("zh-CN", {
                    hour12: false,
                  })}
                </time>
                <span className="answer-log-level">{levels[entry.level]}</span>
                <span>{entry.message}</span>
              </li>
            ))}
          </ol>
        ) : data && !logs.error ? (
          <Empty title="此记录尚无逐步日志" compact icon={ScrollText}>
            新执行步骤会自动记录；已有回答和最后进度仍然保留。
          </Empty>
        ) : null}
      </div>
      {data && data.total > 0 ? (
        <div className="answer-log-footer">
          <small>共{data.total}条 · 最新日志在第1页</small>
          {data.total > data.pageSize ? (
            <Pagination
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              onPageChange={(next) => {
                setFollow(next === 1);
                setPage(next);
              }}
              label="回答日志分页"
            />
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

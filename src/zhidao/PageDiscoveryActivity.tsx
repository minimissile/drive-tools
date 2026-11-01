import { RefreshCw, ScrollText } from "lucide-react";
import { useState } from "react";
import { Pagination } from "../ui/Pagination";
import { Button, Empty, Panel, Status } from "../ui/primitives";
import type { PageDiscoveryRun } from "../../shared/zhidao-page-discovery";
import { useOperationAction } from "./hooks";
export function PageDiscoveryProgress({
  run,
  refresh,
  loading,
}: {
  run: PageDiscoveryRun;
  refresh(): void;
  loading: boolean;
}) {
  const action = useOperationAction();
  const busy = !!action.pending;
  const running = run.status === "running";
  const query = { reload: refresh, loading };
  return (
    <Panel
      title="本轮进度"
      className="page-discovery-progress"
      extra={
        <Button
          quiet
          size="compact"
          disabled={query.loading}
          onClick={query.reload}
        >
          <RefreshCw size={14} />
          刷新记录
        </Button>
      }
    >
      <div className="page-discovery-status">
        <Status
          kind={
            running ? "normal" : run.status === "paused" ? "warning" : "good"
          }
        >
          {running ? "检索中" : run.status === "paused" ? "已暂停" : "本轮结束"}
        </Status>
        <strong>{run.items.length} 个回答页</strong>
        <span>
          检索 {run.searchPages} 页 · 检查 {run.checked} 页 · 异常 {run.failed}{" "}
          页
        </span>
        <div>
          {running ? (
            <Button
              disabled={busy}
              size="compact"
              onClick={() =>
                void action.run(
                  "zhidaoPages.pause",
                  { id: run.id },
                  query.reload,
                )
              }
            >
              停止读取
            </Button>
          ) : run.status === "paused" ? (
            <Button
              disabled={busy}
              size="compact"
              onClick={() =>
                void action.run(
                  "zhidaoPages.resume",
                  { id: run.id },
                  query.reload,
                )
              }
            >
              继续检索
            </Button>
          ) : null}
          <Button
            quiet
            size="compact"
            disabled={running || busy}
            onClick={() => void action.run("zhidaoPages.browser", undefined)}
          >
            查看读取页面
          </Button>
        </div>
      </div>
      <p
        className={
          run.status === "paused"
            ? "page-discovery-warning"
            : "page-discovery-hint"
        }
      >
        {run.message}
      </p>
      <small className="page-discovery-hint">
        当前队列已处理 {run.cursor} / {run.jobs.length}{" "}
        项；搜索到新候选时队列会增加。
        {run.items.filter((v) => v.origin === "specified").length
          ? ` 含${run.items.filter((v) => v.origin === "specified").length}个指定页面结果。`
          : ""}
      </small>
    </Panel>
  );
}
export function PageDiscoveryLogs({ run }: { run: PageDiscoveryRun }) {
  const [page, setPage] = useState(1);
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(run.logs.length / 100)),
  );
  return (
    <Panel
      title="读取日志"
      className="page-discovery-logs"
      extra={<small className="page-discovery-hint">保留最近300条</small>}
    >
      {run.logs.length ? (
        <>
          <ol>
            {run.logs
              .slice()
              .reverse()
              .slice((currentPage - 1) * 100, currentPage * 100)
              .map((log, index) => (
                <li key={`${log.at}:${index}`} data-kind={log.kind}>
                  <time>
                    {new Date(log.at).toLocaleTimeString("zh-CN", {
                      hour12: false,
                    })}
                  </time>
                  <span>
                    {log.message}
                    {log.url ? <small>{log.url}</small> : null}
                  </span>
                </li>
              ))}
          </ol>
          <Pagination
            page={currentPage}
            pageSize={100}
            total={run.logs.length}
            onPageChange={setPage}
            label="读取日志分页"
          />
        </>
      ) : (
        <Empty icon={ScrollText} compact title="等待开始读取">
          执行后会记录搜索、正文检查、去重和异常原因。
        </Empty>
      )}
    </Panel>
  );
}

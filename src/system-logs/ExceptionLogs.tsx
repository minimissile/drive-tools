import { useState } from "react";
import {
  ChevronDown,
  Copy,
  LoaderCircle,
  RefreshCw,
  ScrollText,
} from "lucide-react";
import {
  systemLogDomainLabel,
  systemLogQuery,
  type SystemLogEntry,
} from "../../shared/system-logs";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions, useAppData } from "../state";
import { formatTime } from "../lib/format";
import { DataState, LoadingState } from "../ui/DataState";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Button, Field, Header, Notice, Panel, Status } from "../ui/primitives";
import "./system-logs.css";

const formatEntry = (entry: SystemLogEntry) =>
  `[${formatTime(entry.createdAt)}] ${entry.level === "error" ? "错误" : "警告"} · ${systemLogDomainLabel(entry.domain)}\n${entry.message}\n${JSON.stringify({ event: entry.event, taskId: entry.taskId, accountId: entry.accountId, ...entry.details }, null, 2)}`;

export default function ExceptionLogs() {
  const { data } = useAppData(),
    { notify } = useAppActions();
  const filters = useLocalDraft(
    `panxu-system-logs-v1:${data!.dataPath}`,
    systemLogQuery.parse({}),
    (value) => systemLogQuery.parse(value),
  );
  const query = useIpcQuery("systemLogs.list", filters.value, {
    keepPrevious: true,
    delay: 150,
    refreshInterval: 10000,
  });
  const result = query.data;
  const [copying, setCopying] = useState("");
  const copy = async (key: string, items: SystemLogEntry[]) => {
    if (copying) return;
    setCopying(key);
    try {
      await ipc("system.copyText", {
        text: items.map(formatEntry).join("\n\n"),
      });
      notify("异常详情已复制。", "success");
    } catch {
      notify("复制失败，请选择日志文字手动复制。", "error");
    } finally {
      setCopying("");
    }
  };
  const domains = [
    ...new Set([
      ...(result?.domains ?? []),
      ...(filters.value.domain ? [filters.value.domain] : []),
    ]),
  ];
  return (
    <>
      <Header
        title="异常日志"
        description="集中查看运行错误与警告，展开记录可复制排查详情。"
        action={
          <Button
            disabled={query.loading}
            aria-busy={query.loading || undefined}
            onClick={query.reload}
          >
            {query.loading ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <RefreshCw size={14} />
            )}{" "}
            {query.loading ? "正在刷新…" : "刷新日志"}
          </Button>
        }
      />
      <Panel className="system-logs">
        <div className="system-log-filters">
          <Field label="搜索异常">
            <input
              placeholder="错误内容、模型或调用编号"
              maxLength={200}
              value={filters.value.search}
              onChange={(e) =>
                filters.update({ search: e.target.value, page: 1 })
              }
            />
          </Field>
          <Field label="来源模块">
            <Select
              value={filters.value.domain}
              items={[
                { value: "", label: "全部模块" },
                ...domains.map((domain) => ({
                  value: domain,
                  label: systemLogDomainLabel(domain),
                })),
              ]}
              onValueChange={(domain) => filters.update({ domain, page: 1 })}
            />
          </Field>
          <Field label="级别">
            <Select
              value={filters.value.level}
              items={[
                { value: "issues", label: "错误与警告" },
                { value: "error", label: "仅错误" },
                { value: "warning", label: "仅警告" },
              ]}
              onValueChange={(level) =>
                filters.update({
                  level: level as typeof filters.value.level,
                  page: 1,
                })
              }
            />
          </Field>
          <Field label="时间范围">
            <Select
              value={filters.value.range}
              items={[
                { value: "24h", label: "最近 24 小时" },
                { value: "7d", label: "最近 7 天" },
                { value: "30d", label: "最近 30 天" },
                { value: "all", label: "全部时间" },
              ]}
              onValueChange={(range) =>
                filters.update({
                  range: range as typeof filters.value.range,
                  page: 1,
                })
              }
            />
          </Field>
        </div>
        <div className="system-log-summary">
          <span className="muted">
            {result
              ? `共 ${result.total} 条异常记录 · 每 10 秒更新`
              : "正在读取异常记录…"}
          </span>
          <Button
            size="compact"
            disabled={!result?.items.length || !!copying}
            onClick={() => void copy("page", result!.items)}
          >
            {copying === "page" ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Copy size={14} />
            )}{" "}
            复制本页
          </Button>
        </div>
        {filters.error ? <Notice warning>{filters.error}</Notice> : null}
        <QueryError
          error={
            query.error === "不支持此操作。"
              ? "日志功能尚未加载，请点击顶部“应用更新并重启”。"
              : query.error
          }
          loading={query.loading}
          onRetry={query.reload}
          title="异常日志读取失败"
        />
        {!result && !query.error ? (
          <LoadingState label="正在读取本地异常日志…" compact />
        ) : null}
        {result?.items.length ? (
          <>
            <div className="system-log-columns" aria-hidden="true">
              <span>发生时间</span>
              <span>级别</span>
              <span>来源</span>
              <span>异常内容</span>
              <span />
            </div>
            <ol className="system-log-list" aria-label="异常记录">
              {result.items.map((entry) => (
                <li key={entry.id}>
                  <details>
                    <summary>
                      <time dateTime={entry.createdAt}>
                        {formatTime(entry.createdAt)}
                      </time>
                      <span>
                        <Status
                          kind={entry.level === "error" ? "danger" : "warning"}
                        >
                          {entry.level === "error" ? "错误" : "警告"}
                        </Status>
                      </span>
                      <span>{systemLogDomainLabel(entry.domain)}</span>
                      <span className="system-log-message">
                        {entry.message}
                      </span>
                      <ChevronDown
                        size={14}
                        className="system-log-chevron"
                        aria-hidden="true"
                      />
                    </summary>
                    <div className="system-log-detail">
                      <div className="system-log-detail-heading">
                        <strong>排查详情</strong>
                        <Button
                          size="compact"
                          disabled={!!copying}
                          onClick={() => void copy(entry.id, [entry])}
                        >
                          <Copy size={13} />
                          复制此条
                        </Button>
                      </div>
                      {entry.details.model ? (
                        <p>
                          模型：{String(entry.details.model)}
                          {entry.details.finishReason
                            ? ` · 结束状态：${String(entry.details.finishReason)}`
                            : ""}
                        </p>
                      ) : null}
                      <pre tabIndex={0} aria-label="异常详细信息">
                        {JSON.stringify(
                          {
                            event: entry.event,
                            ...(entry.taskId ? { taskId: entry.taskId } : {}),
                            ...(entry.accountId
                              ? { accountId: entry.accountId }
                              : {}),
                            ...entry.details,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </div>
                  </details>
                </li>
              ))}
            </ol>
            <Pagination
              label="异常日志分页"
              page={result.page}
              pageSize={result.pageSize}
              total={result.total}
              disabled={query.loading}
              onPageChange={(page) => filters.update({ page })}
            />
          </>
        ) : result && !query.error && !query.loading ? (
          <DataState
            kind="empty"
            compact
            icon={ScrollText}
            title="没有匹配的异常记录"
          >
            可调整筛选，或稍后查看新的运行记录。
          </DataState>
        ) : null}
      </Panel>
    </>
  );
}

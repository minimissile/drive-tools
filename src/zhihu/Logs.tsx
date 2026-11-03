import { ScrollText } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import type {
  RuntimeLogEntry,
  RuntimeLogPage,
} from "../../shared/runtime-logs";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { formatTime } from "../lib/format";
import { DataState, Loading, LoadingState } from "../ui/DataState";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { LogWindow } from "../ui/LogWindow";
import { Dialog } from "../ui/Dialog";
import { CheckboxField } from "../ui/CheckboxField";
import { useAppActions } from "../state";
import { Button, Field, Notice, Panel, Status } from "../ui/primitives";

const filters = z.object({
  accountId: z.string().default(""),
  level: z.enum(["all", "info", "warning", "error"]).default("all"),
  page: z.number().int().min(1).default(1),
  search: z.string().max(200).default(""),
  excludeHeartbeats: z.boolean().default(true),
});
type Account = { id: string; alias: string; nickname?: string | null };

export function ZhihuLogRows({
  items,
  accounts,
}: {
  items: RuntimeLogEntry[];
  accounts: Account[];
}) {
  const names = new Map(accounts.map((a) => [a.id, a.nickname || a.alias]));
  return (
    <ol className="zhihu-log-list">
      {items.map((item) => (
        <li key={item.id} className="zhihu-log-row">
          <time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time>
          <Status
            kind={
              item.level === "error"
                ? "danger"
                : item.level === "warning"
                  ? "warning"
                  : "normal"
            }
          >
            {item.level === "error"
              ? "错误"
              : item.level === "warning"
                ? "注意"
                : "信息"}
          </Status>
          <div className="zhihu-log-message">
            <strong>{item.message}</strong>
            <small>
              {item.accountId
                ? names.get(item.accountId) || "历史账号"
                : "调度器"}{" "}
              · {item.event}
            </small>
            {Object.keys(item.details).length || item.taskId ? (
              <details>
                <summary>
                  查看详情{item.taskId ? ` · ${item.taskId.slice(0, 8)}` : ""}
                </summary>
                <pre>
                  {JSON.stringify(
                    {
                      ...item.details,
                      ...(item.taskId ? { taskId: item.taskId } : {}),
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function ZhihuLogs({
  accounts,
  workspace,
}: {
  accounts: Account[];
  workspace: string;
}) {
  const draft = useLocalDraft(
    `panxu-zhihu-logs-v1:${workspace}`,
    filters.parse({}),
    (value) => filters.parse(value),
  );
  const { notify } = useAppActions();
  const [fullscreen, setFullscreen] = useState(false);
  const [follow, setFollow] = useState(true);
  const [held, setHeld] = useState<{
    key: string;
    data: RuntimeLogPage;
  } | null>(null);
  const key = JSON.stringify(draft.value);
  const paused = held?.key === key;
  const query = useIpcQuery("zhihu.logs", draft.value, {
    keepPrevious: true,
    refreshInterval: paused ? 0 : 5000,
    delay: 180,
  });
  // The shared change subscription may still receive new data while paused.
  // Freeze only presentation so text selection and historical inspection stay stable.
  const data = paused ? held!.data : query.data;
  const names = new Map(accounts.map((a) => [a.id, a.nickname || a.alias]));
  const context = (e: RuntimeLogEntry) =>
    e.accountId ? names.get(e.accountId) || "历史账号" : "调度器";
  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(
        [...data.items]
          .reverse()
          .map(
            (e) =>
              `[${formatTime(e.createdAt)}] [${e.level.toUpperCase()}] [${context(e)}] ${e.event} ${e.message}${e.taskId ? ` · ${e.taskId}` : ""}\n${JSON.stringify(e.details)}`,
          )
          .join("\n"),
      );
      notify("当前页日志已复制", "success");
    } catch {
      notify("无法写入剪贴板，可选中日志文字手动复制", "error");
    }
  };
  const controls = (
    <div className="row compact">
      <Button
        size="compact"
        disabled={!data}
        onClick={() => {
          if (paused) {
            setHeld(null);
            query.reload();
          } else if (data) {
            setHeld({ key, data });
            setFollow(false);
          }
        }}
      >
        {paused ? "继续显示" : "暂停显示"}
      </Button>
      <Button
        size="compact"
        disabled={!data?.items.length}
        onClick={() => void copy()}
      >
        复制本页
      </Button>
      <Button
        size="compact"
        disabled={query.loading || paused}
        onClick={query.reload}
      >
        刷新日志
      </Button>
    </div>
  );
  const body = (
    <div className="zhihu-log-workspace">
      <div className="zhihu-log-filters">
        <Field label="账号">
          <Select
            value={draft.value.accountId}
            items={[
              { value: "", label: "全部账号与调度器" },
              ...accounts.map((a) => ({
                value: a.id,
                label: a.nickname || a.alias,
              })),
            ]}
            onValueChange={(accountId) => draft.update({ accountId, page: 1 })}
          />
        </Field>
        <Field label="级别">
          <Select
            value={draft.value.level}
            items={[
              { value: "all", label: "全部级别" },
              { value: "info", label: "信息" },
              { value: "warning", label: "注意" },
              { value: "error", label: "错误" },
            ]}
            onValueChange={(level) =>
              draft.update({ level: filters.shape.level.parse(level), page: 1 })
            }
          />
        </Field>
        <Field label="搜索日志">
          <input
            value={draft.value.search}
            maxLength={200}
            placeholder="消息、事件或任务 ID"
            onChange={(e) => draft.update({ search: e.target.value, page: 1 })}
          />
        </Field>
      </div>
      <div className="zhihu-log-options">
        <CheckboxField
          label="隐藏调度心跳"
          checked={draft.value.excludeHeartbeats}
          onChange={(e) =>
            draft.update({ excludeHeartbeats: e.target.checked, page: 1 })
          }
        />
        <CheckboxField
          label="跟随最新"
          checked={follow && draft.value.page === 1}
          onChange={(e) => {
            setFollow(e.target.checked);
            if (e.target.checked) {
              setHeld(null);
              draft.update({ page: 1 });
            }
          }}
        />
        <span className="muted">
          {paused
            ? "显示已暂停，后台任务不受影响"
            : "每5秒读取本地日志 · 本页从旧到新排列"}
        </span>
        {data ? (
          <span className="muted">
            匹配 {data.total} 条 · 本页 {data.items.length} 条
          </span>
        ) : null}
      </div>
      {draft.error ? <Notice warning>{draft.error}</Notice> : null}
      <QueryError
        error={paused ? "" : query.error}
        loading={!paused && query.loading}
        onRetry={query.reload}
        title="日志读取失败"
      />
      {!data && !query.error ? (
        <LoadingState label="正在读取运行日志…" compact />
      ) : null}
      {data && query.loading && !paused ? (
        <Loading label="正在更新日志…" />
      ) : null}
      {data ? (
        <>
          {data.items.length ? (
            <LogWindow
              key={JSON.stringify([
                draft.value.accountId,
                draft.value.level,
                draft.value.search,
                draft.value.excludeHeartbeats,
                draft.value.page,
                fullscreen,
              ])}
              items={data.items}
              label="知乎运行日志输出"
              context={context}
              follow={follow && draft.value.page === 1 && !paused}
              onFollowChange={setFollow}
            />
          ) : !query.loading && !query.error ? (
            <DataState
              kind="empty"
              title="没有符合条件的日志"
              compact
              icon={ScrollText}
            >
              启动调度、检查等级或执行发布后，事件会记录在这里。可切换账号或级别查看其他记录。
            </DataState>
          ) : null}
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            disabled={query.loading}
            onPageChange={(page) => {
              setFollow(false);
              draft.update({ page });
            }}
            label="运行日志分页"
          />
          <p className="zhihu-log-location">
            本地文件 <span>{data.folder}</span>
            <small>
              按北京时间每日保存
              JSONL；搜索覆盖消息、事件和任务ID，不删除或改写原日志。
            </small>
          </p>
        </>
      ) : null}
    </div>
  );
  return (
    <>
      <Panel
        title="运行日志"
        className="zhihu-log-panel"
        extra={
          <div className="row compact">
            {controls}
            <Button size="compact" onClick={() => setFullscreen(true)}>
              全屏日志
            </Button>
          </div>
        }
      >
        {fullscreen ? <p className="muted">日志正在全屏窗口中显示。</p> : body}
      </Panel>
      {fullscreen ? (
        <Dialog
          title="知乎运行日志"
          size="fullscreen"
          className="zhihu-log-dialog"
          onClose={() => setFullscreen(false)}
          footer={controls}
        >
          {body}
        </Dialog>
      ) : null}
    </>
  );
}

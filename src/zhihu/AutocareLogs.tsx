import { useState } from "react";
import type { RuntimeLogPage } from "../../shared/runtime-logs";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions } from "../state";
import { formatRuntimeLogs } from "../lib/runtime-log";
import { Button, Empty, Field, LoadingState, Panel } from "../ui/primitives";
import { CheckboxField } from "../ui/CheckboxField";
import { QueryError } from "../ui/QueryError";
import { LogWindow } from "../ui/LogWindow";
import { Dialog } from "../ui/Dialog";
import { Pagination } from "../ui/Pagination";
export function AutocareLogs({ names }: { names: Map<string, string> }) {
  const [search, setSearch] = useState(""),
    [onlyErrors, setOnlyErrors] = useState(false),
    [page, setPage] = useState(1),
    [follow, setFollow] = useState(true),
    [full, setFull] = useState(false),
    [held, setHeld] = useState<{ key: string; data: RuntimeLogPage } | null>(
      null,
    );
  const key = JSON.stringify([search, onlyErrors, page]),
    paused = held?.key === key;
  const q = useIpcQuery(
    "zhihu.autocare.logs",
    { search, page, level: onlyErrors ? "issues" : "all" },
    { keepPrevious: true, delay: 150, refreshInterval: paused ? 0 : 3000 },
  );
  const data = paused ? held!.data : q.data;
  const { notify } = useAppActions();
  const context = (e: { accountId: string | null }) =>
    e.accountId ? names.get(e.accountId) || "历史账号" : "系统";
  const controls = (
    <div className="row compact">
      <Button
        size="compact"
        disabled={!data}
        onClick={() => {
          if (paused) {
            setHeld(null);
            q.reload();
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
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(
              formatRuntimeLogs(data!.items, context),
            );
            notify("本页日志已复制", "success");
          } catch {
            notify("无法复制，可选择文字手动复制", "error");
          }
        }}
      >
        复制
      </Button>
      <Button
        size="compact"
        onClick={() => {
          setHeld(null);
          setFollow(true);
          setPage(1);
          q.reload();
        }}
      >
        查看最新
      </Button>
    </div>
  );
  const body = (
    <div className="autocare-log-body">
      <div className="autocare-log-tools">
        <Field label="搜索日志">
          <input
            value={search}
            placeholder="消息、动作或任务ID"
            maxLength={200}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
              setHeld(null);
            }}
          />
        </Field>
        <CheckboxField
          label="只看异常"
          checked={onlyErrors}
          onChange={(e) => {
            setOnlyErrors(e.target.checked);
            setPage(1);
            setHeld(null);
          }}
        />
        <CheckboxField
          label="跟随最新"
          checked={follow && !paused && page === 1}
          onChange={(e) => {
            setFollow(e.target.checked);
            if (e.target.checked) {
              setHeld(null);
              setPage(1);
            }
          }}
        />
      </div>
      <QueryError
        error={paused ? "" : q.error}
        loading={!paused && q.loading}
        onRetry={q.reload}
      />
      {!data && !q.error ? (
        <LoadingState compact label="正在读取运行日志…" />
      ) : null}
      {data?.items.length ? (
        <LogWindow
          items={data.items}
          label="自动养号运行日志"
          context={context}
          follow={follow && !paused && page === 1}
          onFollowChange={setFollow}
        />
      ) : data ? (
        <Empty
          compact
          title={search || onlyErrors ? "没有匹配日志" : "尚未运行"}
        >
          开启后会在这里显示采集、生成、随机排期与发布结果。
        </Empty>
      ) : null}
      {paused ? (
        <small className="muted">只暂停日志显示，后台任务继续运行。</small>
      ) : null}
      {data ? (
        <>
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPageChange={(p) => {
              setPage(p);
              setHeld(null);
              setFollow(false);
            }}
            label="养号日志分页"
          />
          <small className="muted autocare-wrap">本地日志：{data.folder}</small>
        </>
      ) : null}
    </div>
  );
  return (
    <>
      <Panel
        title="运行日志"
        extra={
          <div className="row compact">
            {controls}
            <Button size="compact" onClick={() => setFull(true)}>
              全屏
            </Button>
          </div>
        }
      >
        {full ? <p className="muted">日志正在全屏窗口显示。</p> : body}
      </Panel>
      {full ? (
        <Dialog
          title="自动养号运行日志"
          size="fullscreen"
          className="autocare-log-dialog"
          onClose={() => setFull(false)}
          footer={controls}
        >
          {body}
        </Dialog>
      ) : null}
    </>
  );
}

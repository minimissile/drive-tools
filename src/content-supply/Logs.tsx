import { useState } from "react";
import type {
  RuntimeLogEntry,
  RuntimeLogPage,
} from "../../shared/runtime-logs";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions } from "../state";
import { formatRuntimeLogs } from "../lib/runtime-log";
import { Button, Empty, Field, LoadingState, Panel } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { CheckboxField } from "../ui/CheckboxField";
import { Dialog } from "../ui/Dialog";
import { LogWindow } from "../ui/LogWindow";
import { Pagination } from "../ui/Pagination";

const context = (entry: RuntimeLogEntry) =>
  entry.accountId ? "账号供稿" : "公共素材";
export function SupplyLogs() {
  const [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [follow, setFollow] = useState(true),
    [fullscreen, setFullscreen] = useState(false),
    [held, setHeld] = useState<{ key: string; data: RuntimeLogPage } | null>(
      null,
    );
  const { notify } = useAppActions();
  const key = JSON.stringify([page, search]),
    paused = held?.key === key;
  const query = useIpcQuery(
    "contentSupply.logs",
    { page, search },
    { delay: 150, keepPrevious: true, refreshInterval: paused ? 0 : 3000 },
  );
  const data = paused ? held!.data : query.data;
  const latest = () => {
    setHeld(null);
    setPage(1);
    setFollow(true);
    query.reload();
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
        onClick={async () => {
          if (!data) return;
          try {
            await navigator.clipboard.writeText(
              formatRuntimeLogs(data.items, context),
            );
            notify("当前页供稿日志已复制", "success");
          } catch {
            notify("无法写入剪贴板，可选中日志文字手动复制", "error");
          }
        }}
      >
        复制本页
      </Button>
      <Button size="compact" onClick={latest}>
        查看最新
      </Button>
    </div>
  );
  const body = (
    <div className="supply-log-workspace">
      <Field label="搜索事件、消息或任务ID">
        <input
          aria-label="搜索供稿日志"
          maxLength={200}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
            setHeld(null);
          }}
        />
      </Field>
      <div className="row">
        <CheckboxField
          label="跟随最新"
          checked={follow && page === 1 && !paused}
          onChange={(event) => {
            setFollow(event.target.checked);
            if (event.target.checked) latest();
          }}
        />
        <small className="supply-muted">
          {paused
            ? "显示已暂停，后台任务继续运行"
            : "每3秒读取本地日志 · 本页从旧到新排列"}
        </small>
      </div>
      <QueryError
        error={paused ? "" : query.error}
        loading={!paused && query.loading}
        onRetry={query.reload}
      />
      {!data && !query.error ? (
        <LoadingState label="正在读取供稿日志…" />
      ) : null}
      {data ? (
        <>
          {data.items.length ? (
            <LogWindow
              key={JSON.stringify([page, search, fullscreen])}
              items={data.items}
              label="供稿运行日志"
              context={context}
              follow={follow && page === 1 && !paused}
              onFollowChange={setFollow}
            />
          ) : (
            <Empty title={search ? "没有匹配的供稿日志" : "尚无供稿运行记录"}>
              采集、编辑保存、生成与交付的实际结果会记录在这里。
            </Empty>
          )}
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            disabled={query.loading && !paused}
            onPageChange={(next) => {
              setPage(next);
              setFollow(next === 1);
              setHeld(null);
            }}
            label="供稿日志分页"
          />
          <p className="supply-muted supply-log-path">
            本地日志：{data.folder}
          </p>
        </>
      ) : null}
    </div>
  );
  return (
    <>
      <Panel
        title="供稿运行日志"
        extra={
          <div className="row compact">
            {controls}
            <Button size="compact" onClick={() => setFullscreen(true)}>
              全屏日志
            </Button>
          </div>
        }
      >
        {fullscreen ? (
          <p className="supply-muted">日志正在全屏窗口中显示。</p>
        ) : (
          body
        )}
      </Panel>
      {fullscreen ? (
        <Dialog
          title="供稿运行日志"
          size="fullscreen"
          className="supply-log-dialog"
          onClose={() => setFullscreen(false)}
          footer={controls}
        >
          {body}
        </Dialog>
      ) : null}
    </>
  );
}

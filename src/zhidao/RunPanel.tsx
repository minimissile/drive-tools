import { useState, useRef, useEffect, type ReactNode } from "react";
import { Button, Empty, LoadingState, Panel, Status } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Pagination } from "../ui/Pagination";
import { ResumeRunDialog } from "./ResumeRunDialog";
import { useOperationAction, type OperationModel } from "./hooks";
import type { OperationItem, OperationRun } from "../../shared/zhidao";
import { formatTime } from "../lib/format";
import { PublishAudit } from "./PublishAudit";

export function RunPanel({
  model,
  children,
}: {
  model: OperationModel;
  children?: (items: OperationItem[]) => ReactNode;
}) {
  const action = useOperationAction();
  const [resume, setResume] = useState<OperationRun | null>(null);
  const [stopping, setStopping] = useState("");
  const detail = model.detail.data;
  const history = model.history.data;
  const focusHost = useRef<HTMLElement>(null);
  useEffect(() => {
    if (detail?.run.id === stopping && detail.run.status !== "running")
      setStopping("");
  }, [detail?.run.id, detail?.run.status, stopping]);
  useEffect(() => {
    if (!model.focusRunId || detail?.run.id !== model.focusRunId) return;
    focusHost.current?.scrollIntoView({ block: "start" });
    focusHost.current?.focus({ preventScroll: true });
    model.clearFocus();
  }, [model.focusRunId, detail?.run.id, model.clearFocus]);
  return (
    <Panel
      ref={focusHost}
      tabIndex={-1}
      aria-label="任务与结果"
      title="任务与结果"
      extra={
        <Button quiet size="compact" onClick={model.refresh}>
          刷新本地记录
        </Button>
      }
    >
      <QueryError
        error={model.history.error}
        loading={model.history.loading}
        onRetry={model.history.reload}
      />
      {!history && !model.history.error ? (
        <LoadingState label="正在读取任务记录…" compact />
      ) : history ? (
        <>
          <Select
            aria-label="选择历史运营任务"
            value={model.id}
            onValueChange={(id) => model.pick({ id })}
            items={[
              { value: "", label: "选择历史任务" },
              ...(detail &&
              !history.items.some((run) => run.id === detail.run.id)
                ? [{ value: detail.run.id, label: detail.run.title }]
                : []),
              ...history.items.map((run) => ({
                value: run.id,
                label: `${run.title} · ${formatTime(run.createdAt)}`,
              })),
            ]}
          />
          {history.total > 20 ? (
            <Pagination
              page={model.historyPage}
              pageSize={20}
              total={history.total}
              onPageChange={model.setHistoryPage}
              label="任务历史分页"
            />
          ) : null}
        </>
      ) : null}
      <QueryError
        error={model.history.error ? "" : model.detail.error}
        loading={model.detail.loading}
        onRetry={model.detail.reload}
      />
      {model.id && !detail && !model.detail.error ? (
        <LoadingState label="正在打开任务结果…" />
      ) : !model.id ? (
        <Empty title="开始新任务，或打开历史记录" compact>
          已完成的结果和未完成进度都会保存在本机。
        </Empty>
      ) : detail ? (
        <>
          <div className="operation-run-status">
            <div>
              <Status
                kind={
                  detail.run.status === "completed"
                    ? "good"
                    : detail.run.status === "running"
                      ? "normal"
                      : "warning"
                }
              >
                {
                  {
                    draft: "待开始",
                    running: "进行中",
                    paused: "已暂停",
                    completed: "已完成",
                    failed: "执行失败",
                  }[detail.run.status]
                }
              </Status>
              <strong>{detail.run.title}</strong>
              <span>
                {detail.run.done} / {detail.run.total}
              </span>
            </div>
            <div>
              {model.running ? (
                <Button
                  disabled={!!action.pending || stopping === model.id}
                  onClick={() =>
                    void action.run("zhidao.pause", { id: model.id }, (run) => {
                      setStopping(run.status === "running" ? run.id : "");
                      model.refresh();
                    })
                  }
                >
                  {stopping === model.id ? "正在停止…" : "停止并保留结果"}
                </Button>
              ) : detail.run.status !== "completed" ? (
                <Button
                  disabled={!!action.pending}
                  onClick={() => {
                    setResume(detail.run);
                  }}
                >
                  {model.kind === "template" ? "重试未完成项" : "继续任务"}
                </Button>
              ) : null}
              {model.kind === "answer" &&
              typeof detail.run.config.accountId === "string" &&
              detail.run.config.accountId ? (
                <Button
                  quiet
                  disabled={!!action.pending || model.running}
                  onClick={() =>
                    void action.run("zhidao.account.login", {
                      id: detail.run.config.accountId as string,
                    })
                  }
                >
                  打开账号窗口
                </Button>
              ) : null}
              <Button
                disabled={!!action.pending || !detail.total}
                onClick={() =>
                  void action.run(
                    "zhidao.export",
                    { id: model.id, format: "xlsx" },
                    (path) => {
                      if (path) model.refresh();
                    },
                  )
                }
              >
                导出 XLSX
              </Button>
              <Button
                quiet
                disabled={!!action.pending || !detail.total}
                onClick={() =>
                  void action.run("zhidao.export", {
                    id: model.id,
                    format: model.kind === "mine" ? "txt" : "csv",
                  })
                }
              >
                {model.kind === "mine" ? "导出 TXT" : "导出 CSV"}
              </Button>
            </div>
          </div>
          <p className="operation-run-message" role="status">
            {detail.run.message || "等待处理"}
          </p>
          {model.kind === "publish" && detail.total > 0 ? (
            <PublishAudit
              key={detail.run.id}
              run={detail.run}
              onChanged={model.refresh}
            />
          ) : null}
          {detail.total ? (
            children?.(detail.items)
          ) : model.running ? (
            <LoadingState label="任务正在运行，结果将逐条显示…" />
          ) : (
            <Empty
              title={
                detail.run.status === "completed"
                  ? detail.run.done > 0
                    ? "当前结果列表为空"
                    : "本轮没有新增结果"
                  : "本次任务暂无结果"
              }
              compact
            >
              {detail.run.status === "completed"
                ? detail.run.done > 0
                  ? "任务已结束，当前没有可展示的本地结果。"
                  : "本轮已结束，未找到可新增的结果。具体原因可查看上方任务说明。"
                : "已保留任务配置，处理上方提示后可继续原任务。"}
            </Empty>
          )}
          <Pagination
            page={detail.page}
            pageSize={detail.pageSize}
            total={detail.total}
            onPageChange={model.setPage}
            label="运营结果分页"
          />
        </>
      ) : null}
      {resume ? (
        <ResumeRunDialog
          run={resume}
          onClose={() => setResume(null)}
          onResumed={model.refresh}
        />
      ) : null}
    </Panel>
  );
}

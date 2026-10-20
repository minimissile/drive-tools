import { useState, type ReactNode } from "react";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  Panel,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Pagination } from "../ui/Pagination";
import { Dialog } from "../ui/Dialog";
import { useOperationAction, type OperationModel } from "./hooks";
import type { OperationItem } from "../../shared/zhidao";
import { formatTime } from "../lib/format";

export function RunPanel({
  model,
  children,
}: {
  model: OperationModel;
  children?: (items: OperationItem[]) => ReactNode;
}) {
  const action = useOperationAction();
  const [resume, setResume] = useState(false),
    [consent, setConsent] = useState(false);
  const detail = model.detail.data;
  const history = model.history.data;
  return (
    <Panel
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
                  disabled={!!action.pending}
                  onClick={() =>
                    void action.run(
                      "zhidao.pause",
                      { id: model.id },
                      model.refresh,
                    )
                  }
                >
                  停止并保留结果
                </Button>
              ) : detail.run.status !== "completed" ? (
                <Button
                  disabled={!!action.pending}
                  onClick={() => {
                    setConsent(false);
                    setResume(true);
                  }}
                >
                  继续任务
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
          {detail.total ? (
            children?.(detail.items)
          ) : model.running ? (
            <LoadingState label="任务正在运行，结果将逐条显示…" />
          ) : (
            <Empty title="本次任务没有结果" compact>
              可查看上方任务状态，检查配置后重新开始。
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
        <Dialog
          title="继续运营任务"
          onClose={() => setResume(false)}
          busy={!!action.pending}
        >
          <Notice>
            将从已保存进度继续。AI
            任务可能产生新的费用；答题和发布任务可能提交内容，结果未知的条目会等待人工核对。
          </Notice>
          <Field label="继续授权">
            <span className="check">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              我已核对账号、任务内容和已提交结果
            </span>
          </Field>
          <div className="dialog-actions">
            <Button onClick={() => setResume(false)}>取消</Button>
            <Button
              primary
              disabled={!consent || !!action.pending}
              onClick={() =>
                void action.run(
                  "zhidao.resume",
                  { id: model.id, authorized: true },
                  () => {
                    setResume(false);
                    model.refresh();
                  },
                  "任务已继续",
                )
              }
            >
              确认继续
            </Button>
          </div>
        </Dialog>
      ) : null}
    </Panel>
  );
}

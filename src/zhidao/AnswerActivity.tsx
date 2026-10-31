import { useEffect, useRef, useState } from "react";
import { Copy, MessageSquareText, Pause, Play, RefreshCw } from "lucide-react";
import type { OperationItem, OperationRun } from "../../shared/zhidao";
import { answerInput } from "../../shared/zhidao";
import {
  Button,
  Empty,
  LoadingState,
  Notice,
  Panel,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Pagination } from "../ui/Pagination";
import { formatTime } from "../lib/format";
import { useOperationAction, type OperationModel } from "./hooks";
import { ResumeRunDialog } from "./ResumeRunDialog";
import { ResolveItemDialog } from "./ResolveItemDialog";
import { ItemEditor } from "./ItemEditor";

const statusLabels = {
  draft: "待开始",
  running: "回答中",
  paused: "已暂停",
  completed: "已结束",
  failed: "执行失败",
};

export function AnswerActivity({ model }: { model: OperationModel }) {
  const action = useOperationAction();
  const [resume, setResume] = useState<OperationRun | null>(null);
  const [editing, setEditing] = useState<OperationItem | null>(null);
  const [resolving, setResolving] = useState<OperationItem | null>(null);
  const [stopping, setStopping] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const detail = model.detail.data;
  const history = model.history.data;
  const run = detail?.run;
  const pick = model.pick;
  useEffect(() => {
    if (!model.id && history?.items[0]) pick(history.items[0]);
  }, [model.id, history, pick]);
  useEffect(() => {
    if (stopping && run?.id === stopping && run.status !== "running")
      setStopping("");
  }, [stopping, run?.id, run?.status]);
  useEffect(() => {
    if (!model.focusRunId || run?.id !== model.focusRunId) return;
    host.current?.scrollIntoView({ block: "nearest" });
    host.current?.focus({ preventScroll: true });
    model.clearFocus();
  }, [model.focusRunId, run?.id, model.clearFocus]);
  const automatic = run?.config.mode === "auto";
  const configuration = run ? answerInput.safeParse(run.config) : null;
  const resumeIssue =
    configuration && !configuration.success
      ? configuration.error.issues[0].message
      : "";
  const manualAnswer =
    run && !automatic ? detail.items.find((item) => item.answer) : null;
  const done = run ? Math.max(0, Math.min(run.done, run.total)) : 0;
  const percent = run?.total ? Math.round((done / run.total) * 100) : 0;
  const historyPicker = history?.items.length ? (
    <Select
      aria-label="查看回答记录"
      value={model.id}
      onValueChange={(id) => model.pick({ id })}
      items={[
        ...(run && !history.items.some((entry) => entry.id === run.id)
          ? [
              {
                value: run.id,
                label: `${run.title} · ${formatTime(run.createdAt)}`,
              },
            ]
          : []),
        ...history.items.map((entry) => ({
          value: entry.id,
          label: `${entry.title} · ${formatTime(entry.createdAt)}`,
        })),
      ]}
    />
  ) : null;
  return (
    <div
      className="answer-monitor"
      ref={host}
      tabIndex={-1}
      aria-label="回答执行状态"
    >
      <Panel
        title="回答进度"
        className="answer-progress-panel"
        extra={
          <div className="answer-progress-tools">
            {historyPicker}
            <Button
              quiet
              size="compact"
              onClick={model.refresh}
              disabled={model.detail.loading || model.history.loading}
              aria-label="刷新回答进度"
              title="刷新进度"
            >
              <RefreshCw size={14} />
            </Button>
          </div>
        }
      >
        <QueryError
          title="无法读取回答记录"
          error={model.history.error}
          loading={model.history.loading}
          onRetry={model.history.reload}
        />
        {!history && !model.history.error ? (
          <LoadingState compact label="正在读取回答记录…" />
        ) : history?.items.length ? (
          <>
            {history.total > 20 ? (
              <Pagination
                page={model.historyPage}
                pageSize={20}
                total={history.total}
                onPageChange={model.setHistoryPage}
                label="回答记录分页"
              />
            ) : null}
          </>
        ) : null}
        <QueryError
          title="无法读取回答进度"
          error={model.detail.error}
          loading={model.detail.loading}
          onRetry={model.detail.reload}
        />
        {model.id && !run && !model.detail.error ? (
          <LoadingState compact label="正在读取回答进度…" />
        ) : run ? (
          <>
            <div className="answer-progress-overview">
              <div className="answer-progress-meter">
                <div className="answer-progress-summary">
                  <Status
                    kind={
                      run.status === "completed"
                        ? "good"
                        : run.status === "running"
                          ? "normal"
                          : "warning"
                    }
                  >
                    {statusLabels[run.status]}
                  </Status>
                  <span>
                    <strong>{done}</strong> / {run.total}{" "}
                    {automatic ? "已提交" : "已生成"}
                  </span>
                  <span>{percent}%</span>
                </div>
                <progress
                  className="answer-progress-bar"
                  data-status={run.status}
                  value={done}
                  max={Math.max(1, run.total)}
                  aria-label={automatic ? "自动回答提交进度" : "回答生成进度"}
                  aria-valuetext={`${done} / ${run.total}条，${statusLabels[run.status]}`}
                />
              </div>
              <div className="answer-monitor-actions">
                {run.status === "running" ? (
                  <Button
                    size="compact"
                    disabled={!!action.pending || stopping === run.id}
                    onClick={() =>
                      void action.run(
                        "zhidao.pause",
                        { id: run.id },
                        (result) => {
                          setStopping(
                            result.status === "running" ? result.id : "",
                          );
                          model.refresh();
                        },
                      )
                    }
                  >
                    <Pause size={14} />
                    {stopping === run.id ? "正在停止…" : "停止回答"}
                  </Button>
                ) : run.status !== "completed" ? (
                  <Button
                    size="compact"
                    disabled={!!action.pending || !!resumeIssue}
                    onClick={() => setResume(run)}
                  >
                    <Play size={14} />
                    继续回答
                  </Button>
                ) : null}
                {automatic &&
                typeof run.config.accountId === "string" &&
                run.config.accountId ? (
                  <Button
                    quiet
                    size="compact"
                    disabled={!!action.pending || model.running}
                    onClick={() =>
                      void action.run("zhidao.account.login", {
                        id: run.config.accountId as string,
                      })
                    }
                  >
                    打开账号窗口
                  </Button>
                ) : null}
              </div>
            </div>
            <p className="answer-progress-message" role="status">
              {run.message || "正在准备回答…"}
            </p>
            {resumeIssue ? (
              <Notice warning>
                {resumeIssue}。请在上方修正设置后重新开始，原回答记录会保留。
              </Notice>
            ) : null}

            {manualAnswer ? (
              <section className="answer-manual-output" aria-label="生成的回答">
                <h3>{manualAnswer.question}</h3>
                <p>{manualAnswer.answer}</p>
                <div className="answer-monitor-actions">
                  <Button
                    quiet
                    size="compact"
                    onClick={() =>
                      void action.run(
                        "system.copyText",
                        { text: manualAnswer.answer },
                        undefined,
                        "已复制回答",
                      )
                    }
                    disabled={!!action.pending}
                  >
                    <Copy size={14} />
                    复制回答
                  </Button>
                  <Button
                    quiet
                    size="compact"
                    disabled={model.running}
                    onClick={() => setEditing(manualAnswer)}
                  >
                    编辑回答
                  </Button>
                </div>
              </section>
            ) : null}
            {automatic && !model.running && detail.answerAttention?.length ? (
              <details className="answer-attention">
                <summary>{detail.answerAttention.length}条回答待处理</summary>
                <ul>
                  {detail.answerAttention.map((item) => (
                    <li key={item.id}>
                      <p>{item.question || item.name}</p>
                      <small>{item.message || "回答已生成，尚未提交"}</small>
                      <Button
                        size="compact"
                        quiet
                        onClick={() =>
                          item.status === "uncertain"
                            ? setResolving(item)
                            : setEditing(item)
                        }
                      >
                        {item.status === "uncertain"
                          ? "核对提交结果"
                          : "编辑回答"}
                      </Button>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        ) : !model.id && history && !model.history.error ? (
          <Empty title="尚未开始回答" compact icon={MessageSquareText}>
            完成上方设置后开始，提交进度会实时显示在这里。
          </Empty>
        ) : null}
      </Panel>
      {resume ? (
        <ResumeRunDialog
          run={resume}
          onClose={() => setResume(null)}
          onResumed={model.refresh}
        />
      ) : null}
      {editing ? (
        <ItemEditor
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            model.refresh();
          }}
        />
      ) : null}
      {resolving ? (
        <ResolveItemDialog
          item={resolving}
          onClose={() => setResolving(null)}
          onChanged={model.refresh}
        />
      ) : null}
    </div>
  );
}

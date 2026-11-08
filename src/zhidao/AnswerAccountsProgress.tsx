import type { OperationRun, ZhidaoAccount } from "../../shared/zhidao";
import { zhidaoAccountLabel } from "../../shared/zhidao";
import { Button, Status } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { useOperationAction } from "./hooks";

export function AnswerAccountsProgress({
  sessions,
  accounts,
  selected,
  currentId,
  onPick,
  onChanged,
  error,
  loading,
  onRetry,
}: {
  sessions: OperationRun[];
  accounts: ZhidaoAccount[];
  selected: string[];
  currentId: string;
  onPick(run: { id: string }): void;
  onChanged(): void;
  error: string;
  loading: boolean;
  onRetry(): void;
}) {
  const action = useOperationAction();
  const rows = sessions.filter(
    (run) =>
      run.status === "running" ||
      selected.includes(String(run.config.accountId)),
  );
  if (!rows.length && !error) return null;
  return (
    <section className="answer-account-runs" aria-label="各账号回答进度">
      <QueryError
        title="无法读取各账号进度"
        error={error}
        loading={loading}
        onRetry={onRetry}
      />
      {rows.length > 0 ? (
        <>
          <p className="answer-field-help">
            各账号独立执行，点击账号查看详细进度与日志。
          </p>
          {rows.map((run) => {
            const account = accounts.find((a) => a.id === run.config.accountId);
            return (
              <div
                className="answer-account-run"
                key={run.id}
                data-selected={run.id === currentId || undefined}
              >
                <Button
                  quiet
                  className="answer-account-run-pick"
                  aria-pressed={run.id === currentId}
                  onClick={() => onPick(run)}
                >
                  <strong>
                    {account ? zhidaoAccountLabel(account) : run.title}
                  </strong>
                  <Status
                    kind={
                      run.status === "completed"
                        ? "good"
                        : run.status === "running"
                          ? "normal"
                          : "warning"
                    }
                  >
                    {
                      {
                        running: "回答中",
                        paused: "已暂停",
                        failed: "执行失败",
                        completed: "已结束",
                        draft: "待开始",
                      }[run.status]
                    }
                  </Status>
                  <span>
                    {run.done} / {run.total} 已提交
                  </span>
                </Button>
                {run.status === "running" ? (
                  <Button
                    quiet
                    size="compact"
                    disabled={!!action.pending}
                    onClick={() =>
                      void action.run("zhidao.pause", { id: run.id }, onChanged)
                    }
                  >
                    停止此账号
                  </Button>
                ) : null}
              </div>
            );
          })}
        </>
      ) : null}
    </section>
  );
}

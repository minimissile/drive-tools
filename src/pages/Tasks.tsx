import { Select } from "../ui/Select";
import { Tabs, TabList } from "../ui/Tabs";
import { TaskSection } from "../tasks/TaskSection";
import { taskGroup, type TaskFilter } from "../tasks/task-state";
import { useState, useEffect } from "react";
import { useTaskFocus } from "../tasks/TaskFocus";
import { FileText, LogIn, RefreshCw, Square } from "lucide-react";
import {
  useAppActions,
  useAppActivity,
  useAppData,
  useAppNavigation,
} from "../state";
import { Button, Empty, Header, Notice, Panel, Status } from "../ui/primitives";
import { RecoverShare } from "../resources/components";
import { accountLabel, stageName } from "../resources/labels";
import { formatTime } from "../lib/format";
import type { Job } from "../../shared/types";
export default function Tasks() {
  const { data } = useAppData(),
    { navigate } = useAppNavigation(),
    { command } = useAppActions(),
    { busy } = useAppActivity(),
    [logs, setLogs] = useState<string | null>(null),
    [accountFilter, setAccountFilter] = useState("all");
  const [filter, setFilter] = useState<TaskFilter>(() =>
    data!.jobs.some((j) => taskGroup(j.stage) === "attention")
      ? "attention"
      : "all",
  );
  const { focus } = useTaskFocus();
  useEffect(() => {
    if (focus?.kind !== "job") return;
    setFilter("all");
    setAccountFilter("all");
    setLogs(focus.id);
  }, [focus]);
  const accountJobs = data!.jobs.filter(
    (j) => accountFilter === "all" || j.accountId === accountFilter,
  );
  const jobs = accountJobs
    .filter((j) => filter === "all" || taskGroup(j.stage) === filter)
    .sort(
      (a, b) =>
        (taskGroup(a.stage) === "attention"
          ? 0
          : taskGroup(a.stage) === "active"
            ? 1
            : 2) -
        (taskGroup(b.stage) === "attention"
          ? 0
          : taskGroup(b.stage) === "active"
            ? 1
            : 2),
    );
  return (
    <>
      <Header
        title="转存有进度，失败有去向。"
        description="转存、核验、本人分享与本地归档分步记录；恢复任务先核对远端结果。"
      />
      <div className="toolbar">
        <Select
          aria-label="任务账号筛选"
          value={accountFilter}
          onValueChange={(nextValue) => setAccountFilter(nextValue)}
          items={[
            { value: "all", label: "全部账号任务" },
            ...data!.accounts.map((a) => ({ value: a.id, label: a.alias })),
          ]}
        />
        <small>按账号串行执行，切换工作账号不会改变这里的任务归属。</small>
      </div>
      <Tabs<TaskFilter> value={filter} onChange={setFilter}>
        <TabList
          label="任务状态"
          items={(
            [
              ["attention", "需要处理"],
              ["active", "进行中"],
              ["completed", "已完成"],
              ["all", "全部任务"],
            ] as const
          ).map(
            ([id, label]) =>
              [
                id,
                `${label} ${accountJobs.filter((j) => id === "all" || taskGroup(j.stage) === id).length}`,
              ] as const,
          )}
        />
      </Tabs>
      {jobs.length ? (
        jobs.map((job) => {
          if (job.kind !== "transfer")
            return <OperationTask key={job.id} job={job} />;
          const copy = data!.resources
            .flatMap((r) => r.copies)
            .find((c) => c.id === job.copyId);
          const finished = job.stage === "completed";
          const paused = [
            "failed",
            "needs_review",
            "waiting_login",
            "cancelled",
          ].includes(job.stage);
          const stageIndex = finished
            ? 5
            : ((
                {
                  queued: 0,
                  preflight: 0,
                  transferring: 1,
                  verifying: 2,
                  sharing: 3,
                  archiving: 4,
                } as Record<string, number>
              )[job.stage] ??
              (
                {
                  new: 0,
                  folder_ready: 1,
                  transfer_requested: 1,
                  remote_task: 1,
                  transferred: 2,
                  verified: 3,
                  share_requested: 3,
                  shared: 4,
                } as Record<string, number>
              )[job.checkpoint] ??
              0);
          return (
            <TaskSection key={job.id} job={job}>
              <Panel className="task-panel">
                <div className="task-header">
                  <div>
                    <h3>{job.title}</h3>
                    <p>
                      {accountLabel(data!.accounts, job.accountId)}
                      <span className="tag">目标账号已锁定</span>
                    </p>
                    <small>{copy?.directory}</small>
                  </div>
                  <Status
                    kind={finished ? "good" : paused ? "warning" : "normal"}
                  >
                    {stageName(job.stage)}
                  </Status>
                </div>
                <div className="task-stages">
                  {["预检", "转存", "核验文件", "本人分享", "本地归档"].map(
                    (x, i) => (
                      <span
                        key={x}
                        className={
                          i < stageIndex
                            ? "done"
                            : i === stageIndex
                              ? "active"
                              : ""
                        }
                      >
                        {i < stageIndex ? "✓ " : ""}
                        {x}
                      </span>
                    ),
                  )}
                </div>
                {job.error ? <Notice warning>{job.error}</Notice> : null}
                <div className="row task-actions">
                  {job.stage === "waiting_login" ? (
                    <>
                      <Button
                        primary
                        disabled={busy > 0}
                        onClick={() =>
                          void command("account.login", { id: job.accountId })
                        }
                      >
                        <LogIn size={14} />
                        登录原账号
                      </Button>
                      <Button
                        disabled={busy > 0}
                        onClick={() =>
                          void command(
                            "account.check",
                            { id: job.accountId },
                            "UID核验完成，任务可恢复。",
                          )
                        }
                      >
                        核验并恢复
                      </Button>
                    </>
                  ) : paused ? (
                    <Button
                      primary
                      disabled={busy > 0}
                      onClick={() =>
                        void command(
                          "job.retry",
                          { id: job.id },
                          "已恢复查询；已有检查点会用于核对结果。",
                        )
                      }
                    >
                      <RefreshCw size={14} />
                      核对并恢复
                    </Button>
                  ) : null}
                  {!finished && job.stage !== "cancelled" ? (
                    <Button
                      disabled={busy > 0}
                      onClick={() =>
                        void command(
                          "job.cancel",
                          { id: job.id },
                          "已停止本地等待；网盘已执行的操作不会自动撤销。",
                        )
                      }
                    >
                      <Square size={13} />
                      停止本地等待
                    </Button>
                  ) : null}
                  <Button
                    quiet
                    onClick={() => setLogs(logs === job.id ? null : job.id)}
                  >
                    <FileText size={14} />
                    {logs === job.id ? "收起日志" : "查看日志"}
                  </Button>
                  {paused && copy ? <RecoverShare copy={copy} /> : null}
                  <Button quiet onClick={() => navigate("library")}>
                    资源库
                  </Button>
                </div>
                {logs === job.id ? (
                  <div className="task-log">
                    {job.logs.length ? (
                      job.logs.map((l, i) => (
                        <div key={i}>
                          <time>{formatTime(l.at)}</time>
                          {l.message}
                        </div>
                      ))
                    ) : (
                      <span>任务已建立，尚未执行远端操作。</span>
                    )}
                    <small>
                      检查点：{job.checkpoint} · 恢复次数：{job.attempts}
                    </small>
                  </div>
                ) : null}
              </Panel>
            </TaskSection>
          );
        })
      ) : (
        <Empty
          title={data!.jobs.length ? "此筛选下没有任务" : "暂时没有转存任务"}
          action={
            data!.jobs.length ? (
              <Button
                onClick={() => {
                  setAccountFilter("all");
                  setFilter("all");
                }}
              >
                查看全部任务
              </Button>
            ) : (
              <Button primary onClick={() => navigate("intake")}>
                录入资源
              </Button>
            )
          }
        >
          开始转存后，账号、阶段与处理日志都会保存在本地。
        </Empty>
      )}
    </>
  );
}
function OperationTask({ job }: { job: Job }) {
  const { command } = useAppActions(),
    { busy } = useAppActivity(),
    [logs, setLogs] = useState(false);
  const title = {
    batch_inspect: "批量预检",
    split_preview: "拆分预览",
    split_share: "子链接创建",
    transfer: "转存",
  }[job.kind];
  const paused = [
    "failed",
    "needs_review",
    "waiting_login",
    "cancelled",
  ].includes(job.stage);
  return (
    <TaskSection job={job}>
      <Panel className="task-panel">
        <div className="row spread">
          <h3>
            {title} · {job.title}
          </h3>
          <Status
            kind={
              job.stage === "completed" ? "good" : paused ? "warning" : "normal"
            }
          >
            {stageName(job.stage)}
          </Status>
        </div>
        <small>
          {job.kind === "split_share"
            ? "仅为本人已有文件创建或恢复分享，不重新转存。"
            : "此任务只读取目录和记录预检，不转存或创建分享。"}
        </small>
        {job.error ? <Notice warning>{job.error}</Notice> : null}
        <div className="actions">
          {paused ? (
            <Button
              disabled={busy > 0}
              onClick={() => void command("job.retry", { id: job.id })}
            >
              核对并恢复
            </Button>
          ) : null}
          {!["completed", "cancelled"].includes(job.stage) ? (
            <Button
              disabled={busy > 0}
              onClick={() => void command("job.cancel", { id: job.id })}
            >
              停止本地等待
            </Button>
          ) : null}
          <Button quiet onClick={() => setLogs((v) => !v)}>
            {logs ? "收起日志" : "查看日志"}
          </Button>
        </div>
        {logs ? (
          <div className="task-log">
            {job.logs.map((l, i) => (
              <div key={i}>
                <time>{formatTime(l.at)}</time>
                {l.message}
              </div>
            ))}
            <small>检查点：{job.checkpoint}</small>
          </div>
        ) : null}
      </Panel>
    </TaskSection>
  );
}

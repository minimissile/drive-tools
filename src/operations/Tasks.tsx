import { useState } from "react";
import {
  operationsTaskQuery,
  operationsTaskStatuses,
  type OperationsSnapshot,
  type OperationsTask,
} from "../../shared/intelligent-operations";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { formatTime } from "../lib/format";
import type { Page } from "../state";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  Panel,
  Status,
} from "../ui/primitives";
import { Select } from "../ui/Select";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { channelNames, taskNames, stateKind, stateNames } from "./labels";
import type { OperationAction } from "./useOperationAction";
import { TaskDialog } from "./TaskDialog";

export function OperationsTasks({
  snapshot: s,
  workspace,
  busy,
  run,
  createPlan,
  navigate,
}: {
  snapshot: OperationsSnapshot;
  workspace: string;
  busy: boolean;
  run: OperationAction;
  createPlan(): void;
  navigate(page: Page): void;
}) {
  const filters = useLocalDraft(
    `panxu-operations-tasks-v1:${workspace}`,
    operationsTaskQuery.parse({}),
    (v) => operationsTaskQuery.parse(v),
  );
  const query = useIpcQuery("intelligentOps.tasks", filters.value, {
    keepPrevious: true,
    refreshInterval: 5000,
  });
  const [dialog, setDialog] = useState<{
    task: OperationsTask;
    kind: "schedule" | "review" | "handoff";
  } | null>(null);
  const data = query.data;
  return (
    <Panel
      title="统一任务计划"
      extra={
        <div className="operations-actions">
          <Button
            size="compact"
            disabled={busy || !s.plans.length}
            onClick={() =>
              void run(
                () =>
                  ipc(
                    "intelligentOps.replan",
                    filters.value.planId
                      ? { planId: filters.value.planId }
                      : {},
                  ),
                "已按当前规则重新计算任务计划",
              ).then((r) => {
                if (r.ok) query.reload();
              })
            }
          >
            重新规划
          </Button>
          <Button size="compact" onClick={createPlan}>
            创建运营计划
          </Button>
        </div>
      }
    >
      <div className="operations-toolbar operations-task-filters">
        <Field label="运营计划">
          <Select
            value={filters.value.planId}
            items={[
              { value: "", label: "全部运营计划" },
              ...s.plans.map((p) => ({ value: p.id, label: p.name })),
            ]}
            onValueChange={(planId) => filters.update({ planId, page: 1 })}
          />
        </Field>
        <Field label="时间范围">
          <Select
            value={filters.value.horizon}
            items={[
              { value: "today", label: "今日" },
              { value: "week", label: "未来7天" },
              { value: "all", label: "全部与历史" },
            ]}
            onValueChange={(horizon) =>
              filters.update({
                horizon: horizon as typeof filters.value.horizon,
                page: 1,
              })
            }
          />
        </Field>
        <Field label="渠道">
          <Select
            value={filters.value.channel}
            items={[
              { value: "all", label: "全部渠道" },
              ...Object.entries(channelNames).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
            onValueChange={(channel) =>
              filters.update({
                channel: channel as typeof filters.value.channel,
                accountId: "",
                page: 1,
              })
            }
          />
        </Field>
        <Field label="任务状态">
          <Select
            value={filters.value.status}
            items={[
              { value: "all", label: "全部状态" },
              ...operationsTaskStatuses.map((value) => ({
                value,
                label: stateNames[value] || value,
              })),
            ]}
            onValueChange={(status) =>
              filters.update({
                status: status as typeof filters.value.status,
                page: 1,
              })
            }
          />
        </Field>
        <Field label="账号或交接渠道">
          <Select
            value={filters.value.accountId}
            items={[
              { value: "", label: "全部账号" },
              ...s.accounts
                .filter(
                  (a) =>
                    filters.value.channel === "all" ||
                    a.channel === filters.value.channel,
                )
                .map((a) => ({ value: a.id, label: a.label })),
            ]}
            onValueChange={(accountId) =>
              filters.update({ accountId, page: 1 })
            }
          />
        </Field>
        <Field label="任务类型">
          <Select
            value={filters.value.kind}
            items={[
              { value: "all", label: "全部类型" },
              ...[
                "publish",
                "progress",
                "statistics",
                "reconcile",
                "handoff",
                "supply",
              ].map((value) => ({ value, label: taskNames[value] })),
            ]}
            onValueChange={(kind) =>
              filters.update({
                kind: kind as typeof filters.value.kind,
                page: 1,
              })
            }
          />
        </Field>
      </div>
      {filters.error ? <Notice warning>{filters.error}</Notice> : null}
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
        title="任务计划读取失败"
      />
      {!data && !query.error ? (
        <LoadingState label="正在读取任务计划…" compact />
      ) : null}
      {data?.items.length ? (
        <>
          <div className="operations-table-scroll">
            <table className="operations-table">
              <thead>
                <tr>
                  <th>预计时间</th>
                  <th>账号 / 计划</th>
                  <th>任务、内容与安排原因</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((t) => {
                  const mutable =
                    !t.attemptedAt &&
                    !t.submittedAt &&
                    ["planned", "blocked", "review", "handoff"].includes(
                      t.status,
                    );
                  return (
                    <tr key={t.id}>
                      <td className="operations-time">
                        {t.scheduledAt ? formatTime(t.scheduledAt) : "等待条件"}
                      </td>
                      <td>
                        <strong>{t.accountLabel}</strong>
                        <small>
                          {channelNames[t.channel]} ·{" "}
                          {s.plans.find((p) => p.id === t.planId)?.name ||
                            "历史计划"}
                        </small>
                      </td>
                      <td className="operations-task-copy">
                        <strong>{t.title}</strong>
                        <small>{taskNames[t.kind] || t.kind}</small>
                        <p>{t.reason}</p>
                        <details>
                          <summary>任务依据与关联记录</summary>
                          <p>
                            计划版本 v{t.planRevision} · 更新{" "}
                            {formatTime(t.updatedAt)}
                          </p>
                          <p>任务 {t.id}</p>
                          {t.linkedTaskId ? (
                            <p>渠道任务 {t.linkedTaskId}</p>
                          ) : null}
                          {t.fingerprint ? (
                            <p>内容版本 {t.fingerprint}</p>
                          ) : null}
                          {t.attemptedAt ? (
                            <p>开始执行 {formatTime(t.attemptedAt)}</p>
                          ) : null}
                          {t.submittedAt ? (
                            <p>提交记录 {formatTime(t.submittedAt)}</p>
                          ) : null}
                        </details>
                        {t.url ? (
                          <Button
                            quiet
                            size="compact"
                            onClick={() =>
                              void ipc("system.external", { url: t.url! })
                            }
                          >
                            查看官方回执
                          </Button>
                        ) : null}
                      </td>
                      <td>
                        <Status kind={stateKind(t.status)}>
                          {stateNames[t.status] || t.status}
                        </Status>
                      </td>
                      <td className="operations-row-actions">
                        <div className="operations-actions">
                          {t.status === "review" &&
                          t.channel === "weibo" &&
                          t.fingerprint ? (
                            <Button
                              size="compact"
                              disabled={busy}
                              onClick={() =>
                                setDialog({ task: t, kind: "review" })
                              }
                            >
                              审核内容版本
                            </Button>
                          ) : null}
                          {mutable && t.kind !== "supply" ? (
                            <Button
                              size="compact"
                              disabled={busy}
                              onClick={() =>
                                setDialog({ task: t, kind: "schedule" })
                              }
                            >
                              调整时间
                            </Button>
                          ) : null}
                          {t.status === "handoff" ? (
                            <Button
                              size="compact"
                              disabled={busy}
                              onClick={() =>
                                setDialog({ task: t, kind: "handoff" })
                              }
                            >
                              登记交接结果
                            </Button>
                          ) : null}
                          {mutable ? (
                            <Button
                              quiet
                              size="compact"
                              disabled={busy}
                              onClick={() =>
                                void run(
                                  () =>
                                    ipc("intelligentOps.task.cancel", {
                                      id: t.id,
                                    }),
                                  "未执行任务已取消，历史记录保留",
                                ).then((r) => {
                                  if (r.ok) query.reload();
                                })
                              }
                            >
                              取消任务
                            </Button>
                          ) : null}
                          {["attention", "delegated"].includes(t.status) ? (
                            <Button
                              quiet
                              size="compact"
                              onClick={() =>
                                navigate(
                                  t.channel === "zhihu"
                                    ? "zhihu-operations"
                                    : t.channel === "weibo"
                                      ? "weibo-marketing"
                                      : "publish",
                                )
                              }
                            >
                              到渠道查看
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination
            label="智能运营任务分页"
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            disabled={query.loading}
            onPageChange={(page) => filters.update({ page })}
          />
        </>
      ) : data && !query.loading && !query.error ? (
        <Empty
          title={
            !s.plans.length
              ? "先创建一组运营计划"
              : filters.value.status !== "all" ||
                  filters.value.accountId ||
                  filters.value.kind !== "all" ||
                  filters.value.channel !== "all"
                ? "没有匹配的任务"
                : "当前范围没有任务"
          }
          action={
            !s.plans.length ? (
              <Button primary size="compact" onClick={createPlan}>
                创建运营计划
              </Button>
            ) : undefined
          }
        >
          规则计划可选择本地素材后重新规划；自主计划在授权后由AI决策并安排任务。保存或查看不会启动发布。
        </Empty>
      ) : null}
      <p className="operations-log-location">
        时间均为北京时间。未来排期会随额度、素材、环境占用变化；未知提交结果须先核对。
      </p>
      {dialog ? (
        <TaskDialog
          key={dialog.kind + dialog.task.id}
          {...dialog}
          snapshot={s}
          busy={busy}
          run={run}
          close={() => setDialog(null)}
          changed={query.reload}
          navigate={navigate}
        />
      ) : null}
    </Panel>
  );
}

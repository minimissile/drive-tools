import { useState } from "react";
import { BrainCircuit, ChevronUp, ExternalLink, RefreshCw } from "lucide-react";
import type {
  OperationsQuickPlan,
  OperationsQuickView,
} from "../../shared/intelligent-operations";
import { useIpcQuery } from "../api/useIpcQuery";
import { formatMoney, formatTime } from "../lib/format";
import { Button, Empty, Field, LoadingState, Status } from "../ui/primitives";
import { Popover } from "../ui/Popover";
import { QueryError } from "../ui/QueryError";
import { SearchSelect } from "../ui/SearchSelect";
import { channelNames, stateKind, stateNames, taskNames } from "./labels";
import { useOperationsFocus } from "./OperationsFocus";
import "./quick-access.css";

export function OperationsQuickAccess() {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState("");
  const { open } = useOperationsFocus();
  const query = useIpcQuery("intelligentOps.quickView", undefined, {
    enabled: expanded,
    keepPrevious: true,
    refreshInterval: 5000,
  });
  const plan =
    query.data?.plans.find((p) => p.id === selected) ?? query.data?.plans[0];
  const showPlan = (
    planId: string,
    tab: "autonomy" | "plans" | "participation" = "autonomy",
  ) => {
    setExpanded(false);
    open({ planId, tab });
  };
  return (
    <Popover
      open={expanded}
      onOpenChange={setExpanded}
      title="自主运营计划"
      trigger={
        <Button
          primary
          className="operations-quick-trigger"
          aria-label="快速查看自主运营计划"
          title="快速查看自主运营计划"
        >
          <BrainCircuit size={18} aria-hidden="true" />
          <span>自主计划</span>
          <ChevronUp size={14} aria-hidden="true" />
        </Button>
      }
      footer={
        <Button quiet size="compact" onClick={() => showPlan(plan?.id ?? "")}>
          <ExternalLink size={13} aria-hidden="true" />
          打开运营中心
        </Button>
      }
    >
      {expanded ? (
        <QuickPlans
          query={query}
          plan={plan}
          select={setSelected}
          showPlan={showPlan}
        />
      ) : null}
    </Popover>
  );
}

function QuickPlans({
  query,
  plan,
  select,
  showPlan,
}: {
  query: {
    data: OperationsQuickView | null;
    error: string;
    loading: boolean;
    reload(): void;
  };
  plan: OperationsQuickPlan | undefined;
  select(planId: string): void;
  showPlan(planId: string, tab?: "autonomy" | "plans" | "participation"): void;
}) {
  const data = query.data;
  return (
    <div className="operations-quick-content">
      <div className="operations-quick-toolbar">
        <span>
          {data
            ? `${data.schedulerRunning ? "统一调度运行中" : "统一调度已停止"} · ${data.plans.length} 组自主计划`
            : "正在读取本地计划"}
        </span>
        <Button
          quiet
          size="compact"
          disabled={query.loading}
          aria-label="刷新自主运营计划"
          title="刷新本地计划"
          onClick={query.reload}
        >
          <RefreshCw
            size={14}
            className={query.loading ? "spin" : undefined}
            aria-hidden="true"
          />
        </Button>
      </div>
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
        title="自主计划读取失败"
      >
        保留上次内容，可重试读取。
      </QueryError>
      {!data && !query.error ? (
        <LoadingState compact label="正在读取自主计划与任务…" />
      ) : null}
      {data && !data.plans.length && !query.error && !query.loading ? (
        <Empty
          compact
          title="暂无自主运营计划"
          icon={BrainCircuit}
          action={
            <Button
              primary
              size="compact"
              onClick={() => showPlan("", "plans")}
            >
              配置运营计划
            </Button>
          }
        >
          在运营计划中选择“AI自主运营”，保存后即可在这里快速查看。
        </Empty>
      ) : null}
      {plan && data ? (
        <>
          <Field label="查看计划">
            <SearchSelect
              label="选择自主运营计划"
              items={data.plans.map((p) => ({ value: p.id, label: p.name }))}
              value={{ value: plan.id, label: plan.name }}
              onChange={select}
              placeholder="搜索自主计划"
              emptyMessage="没有匹配的自主计划"
            />
          </Field>
          <QuickPlanDetails
            plan={plan}
            schedulerRunning={data.schedulerRunning}
          />
          <Button size="compact" onClick={() => showPlan(plan.id)}>
            查看此计划详情
          </Button>
          <Button
            quiet
            size="compact"
            onClick={() => showPlan(plan.id, "participation")}
          >
            查看日常参与 · {plan.participationCount}
          </Button>
        </>
      ) : null}
    </div>
  );
}

function QuickPlanDetails({
  plan,
  schedulerRunning,
}: {
  plan: OperationsQuickPlan;
  schedulerRunning: boolean;
}) {
  const runtime = plan.runtime;
  const state = runtime?.running
    ? { label: "正在决策执行", kind: "good" as const }
    : !plan.active
      ? { label: "计划已暂停", kind: "normal" as const }
      : !runtime
        ? { label: "自主状态未读取", kind: "warning" as const }
        : !runtime.authorized
          ? { label: "等待自主授权", kind: "warning" as const }
          : !schedulerRunning
            ? { label: "等待启动调度", kind: "warning" as const }
            : { label: "等待下次唤醒", kind: "normal" as const };
  return (
    <>
      <div className="operations-quick-plan-state">
        <Status kind={state.kind}>{state.label}</Status>
        <span>
          {plan.channels.map((c) => channelNames[c]).join(" · ") ||
            "未启用渠道"}{" "}
          · {plan.accountCount} 个账号
        </span>
      </div>
      <p className="operations-quick-goal" title={plan.goal}>
        {plan.goal}
      </p>
      <dl className="operations-quick-facts">
        <div className="operations-quick-next">
          <dt>下次唤醒</dt>
          <dd>
            {runtime?.nextWakeAt ? formatTime(runtime.nextWakeAt) : "尚未安排"}
          </dd>
        </div>
        <div>
          <dt>今日轮次</dt>
          <dd>
            {runtime
              ? `${runtime.cyclesToday} / ${plan.maxCyclesPerDay}`
              : "尚未读取"}
          </dd>
        </div>
        <div>
          <dt>今日费用 / 上限</dt>
          <dd>
            {runtime
              ? `${runtime.costKnown ? formatMoney(runtime.costTodayMicros, "USD") : "费用待核实"} / ${formatMoney(plan.dailyBudgetMicros, "USD")}`
              : "尚未读取"}
          </dd>
        </div>
      </dl>
      {runtime?.message ? (
        <p className="operations-quick-message">{runtime.message}</p>
      ) : null}
      <section className="operations-quick-tasks" aria-label="近期运营任务">
        <div className="operations-quick-section-title">
          <h3>近期任务 · {plan.taskCount}</h3>
          {plan.attentionCount ? (
            <Status kind="warning">待本人处理 {plan.attentionCount}</Status>
          ) : null}
        </div>
        {plan.tasks.length ? (
          <ul>
            {plan.tasks.map((task) => (
              <li key={task.id}>
                <div className="operations-quick-task-title">
                  <strong>{task.title}</strong>
                  <Status kind={stateKind(task.status)}>
                    {stateNames[task.status]}
                  </Status>
                </div>
                <p>
                  {channelNames[task.channel]} · {task.accountLabel} ·{" "}
                  {taskNames[task.kind]}
                </p>
                <time dateTime={task.scheduledAt ?? undefined}>
                  {task.scheduledAt
                    ? formatTime(task.scheduledAt)
                    : "等待执行条件"}
                </time>
                <p className="operations-quick-task-reason" title={task.reason}>
                  {task.reason}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="operations-quick-task-empty">
            暂无待执行任务。已授权计划会在唤醒后按实际条件安排。
          </p>
        )}
        {plan.taskCount > plan.tasks.length ? (
          <small>
            显示最靠前的 {plan.tasks.length} 项，完整排期见计划详情。
          </small>
        ) : null}
      </section>
    </>
  );
}

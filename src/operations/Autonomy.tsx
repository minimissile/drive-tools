import { useState } from "react";
import { z } from "zod";
import type { OperationsSnapshot } from "../../shared/intelligent-operations";
import { operationsBrainConfig } from "../../shared/operations-brain";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { formatMoney, formatTime } from "../lib/format";
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
import { BrainCycles } from "./BrainCycles";
import { BrainAuthorization } from "./BrainAuthorization";
import { permissionCopy } from "./AutonomyPolicy";
import type { OperationsBrainPermissions } from "../../shared/operations-brain";
import type { OperationAction } from "./useOperationAction";

const navigationSchema = z.object({ planId: z.string().default("") });

export function OperationsAutonomy({
  snapshot: s,
  workspace,
  busy,
  interrupting,
  run,
  runInterrupt,
  editPlan,
  openSettings,
}: {
  snapshot: OperationsSnapshot;
  workspace: string;
  busy: boolean;
  interrupting: boolean;
  run: OperationAction;
  runInterrupt: OperationAction;
  editPlan(id: string): void;
  openSettings(): void;
}) {
  const navigation = useLocalDraft(
    `panxu-operations-autonomy-v1:${workspace}`,
    navigationSchema.parse({}),
    (value) => navigationSchema.parse(value),
  );
  const brain = useIpcQuery("intelligentOps.brain.snapshot", undefined, {
    keepPrevious: true,
    refreshInterval: 5000,
  });
  const [grantRevision, setGrantRevision] = useState<number | null>(null);
  const plan =
    s.plans.find((p) => p.id === navigation.value.planId) ?? s.plans[0];
  const runtime = brain.data?.plans.find((p) => p.planId === plan?.id);
  const config = plan?.brain ?? operationsBrainConfig.parse({});
  const memory = brain.data?.memory.filter((m) => m.planId === plan?.id) ?? [];
  const tools =
    brain.data?.model === s.aiDefaults.model
      ? brain.data?.toolsSupported
      : null;
  const configured = brain.data?.configured === true;
  const readiness = !brain.data
    ? "自主模型准备状态尚未读取"
    : !configured
      ? brain.data.configurationMessage || "请先配置可用的自主分析模型与API连接"
      : tools === true
        ? "当前分析模型支持工具调用"
        : tools === false
          ? "当前分析模型不支持工具调用，请更换支持tools的模型"
          : "模型工具调用能力未知，请到设置刷新模型目录";
  return (
    <div className="operations-autonomy">
      <Panel
        title="自主运营"
        extra={
          <Button size="compact" onClick={openSettings}>
            模型与预算设置
          </Button>
        }
      >
        {!s.plans.length ? (
          <Empty
            title="先创建一组自主运营计划"
            action={
              <Button primary size="compact" onClick={() => editPlan("")}>
                配置运营计划
              </Button>
            }
          >
            选择AI自主模式、账号范围、预算和动作权限。保存不会收费或启用；实际运行前需明确授权。
          </Empty>
        ) : (
          <>
            <div className="operations-toolbar">
              <Field label="运营计划">
                <Select
                  value={plan?.id ?? ""}
                  items={s.plans.map((p) => ({ value: p.id, label: p.name }))}
                  onValueChange={(planId) => {
                    navigation.update({ planId });
                    setGrantRevision(null);
                  }}
                />
              </Field>
              <span className="operations-quiet">
                OpenRouter分析模型：
                {brain.data?.model || s.aiDefaults.model || "尚未配置"}
                <br />
                {readiness}
              </span>
            </div>
            {navigation.error ? (
              <Notice warning>{navigation.error}</Notice>
            ) : null}
            <QueryError
              error={brain.error}
              loading={brain.loading}
              onRetry={brain.reload}
              title="自主运行状态读取失败"
            >
              可随时停止本计划；读取失败不会撤销已完成的操作。
            </QueryError>
            {!brain.data && !brain.error ? (
              <LoadingState label="正在读取授权、费用与自主运行状态…" compact />
            ) : null}
            {brain.data ? (
              <>
                <div className="operations-agent-status">
                  <Status kind={plan.mode === "autonomous" ? "good" : "normal"}>
                    {plan.mode === "autonomous" ? "AI自主模式" : "本地规则模式"}
                  </Status>
                  <Status kind={plan.active ? "good" : "normal"}>
                    {plan.active ? "业务计划已启用" : "业务计划已暂停"}
                  </Status>
                  <Status kind={s.runtime.running ? "good" : "normal"}>
                    {s.runtime.running ? "统一调度运行中" : "统一调度已停止"}
                  </Status>
                  <Status kind={runtime?.authorized ? "good" : "normal"}>
                    {runtime?.authorized
                      ? "本次自主授权已开启"
                      : "本次自主授权未开启"}
                  </Status>
                </div>
                <dl className="operations-autonomy-summary">
                  <div>
                    <dt>当前轮次</dt>
                    <dd>{runtime?.running ? "正在决策或执行" : "未在执行"}</dd>
                  </div>
                  <div>
                    <dt>下次唤醒</dt>
                    <dd>
                      {runtime?.nextWakeAt
                        ? formatTime(runtime.nextWakeAt)
                        : "尚未安排"}
                    </dd>
                  </div>
                  <div>
                    <dt>今日轮数 / 上限</dt>
                    <dd>
                      {runtime ? runtime.cyclesToday : "尚无记录"} /{" "}
                      {config.maxCyclesPerDay}
                    </dd>
                  </div>
                  <div>
                    <dt>今日实际费用 / 上限</dt>
                    <dd>
                      {runtime
                        ? runtime.costKnown
                          ? formatMoney(runtime.costTodayMicros, "USD")
                          : `费用待核实，已记 ${formatMoney(runtime.costTodayMicros, "USD")}`
                        : "尚无费用记录"}{" "}
                      / {formatMoney(config.dailyBudgetMicros, "USD")}
                    </dd>
                  </div>
                  <div>
                    <dt>每轮限制</dt>
                    <dd>
                      {config.maxStepsPerCycle} 步 · {config.maxCycleMinutes}{" "}
                      分钟 · {formatMoney(config.cycleBudgetMicros, "USD")}
                    </dd>
                  </div>
                  <div>
                    <dt>唤醒间隔</dt>
                    <dd>{config.wakeMinutes} 分钟 · 受全局AI日预算约束</dd>
                  </div>
                  <div>
                    <dt>本次实际授权动作</dt>
                    <dd>
                      {runtime?.authorized
                        ? (
                            Object.keys(
                              permissionCopy,
                            ) as (keyof OperationsBrainPermissions)[]
                          )
                            .filter((key) => runtime.permissions[key])
                            .map((key) => permissionCopy[key].label)
                            .join("、") || "无"
                        : "尚未授权"}
                    </dd>
                  </div>
                </dl>
                <p className="operations-quiet">
                  {runtime?.message ||
                    "保存配置后，在这里授权本计划的持续模型调用与动作范围。"}
                </p>
              </>
            ) : null}
            {plan.mode !== "autonomous" ? (
              <Notice>
                当前计划采用规则排期。先在计划编辑中选择“AI自主运营”，保存预算和权限范围。
              </Notice>
            ) : !configured || tools !== true ? (
              <Notice warning>
                {readiness}。能力未知时不会自动降级为文字建议。
              </Notice>
            ) : !config.permissions.read ? (
              <Notice warning>
                当前计划尚未配置读取状态权限，请先编辑并保存希望开放的自主范围。
              </Notice>
            ) : null}
            <div className="operations-actions">
              <Button
                primary
                size="compact"
                disabled={
                  busy ||
                  plan.mode !== "autonomous" ||
                  tools !== true ||
                  !configured ||
                  !config.permissions.read ||
                  !!runtime?.authorized ||
                  !!brain.error
                }
                onClick={() => setGrantRevision(plan.revision)}
              >
                授权本计划自主运营
              </Button>
              <Button
                size="compact"
                disabled={interrupting}
                onClick={() =>
                  void runInterrupt(
                    () =>
                      ipc("intelligentOps.brain.activate", {
                        planId: plan.id,
                        active: false,
                        permissions: {
                          read: false,
                          create: false,
                          reviewOwn: false,
                          publish: false,
                        },
                        confirmed: true,
                      }),
                    "本计划自主授权已撤销，不再发起新步骤",
                  )
                }
              >
                {interrupting ? "正在停止…" : "停止本计划自主运营"}
              </Button>
              <Button
                size="compact"
                disabled={
                  busy ||
                  !runtime?.authorized ||
                  runtime.running ||
                  !plan.active ||
                  !s.runtime.running ||
                  tools !== true
                }
                onClick={() =>
                  void run(
                    () =>
                      ipc("intelligentOps.brain.wake", {
                        planId: plan.id,
                        confirmed: true,
                      }),
                    "已请求在当前授权范围内唤醒一轮",
                  )
                }
              >
                立即唤醒一轮
              </Button>
              <Button quiet size="compact" onClick={() => editPlan(plan.id)}>
                编辑目标与自主范围
              </Button>
            </div>
            <p className="operations-log-location">
              授权、业务计划启用、统一调度运行三项条件齐备后才自动执行。停止不撤回已经提交的平台操作；修改计划、停止或重启后须重新授权。
            </p>
          </>
        )}
      </Panel>
      {plan ? (
        <>
          <BrainCycles key={plan.id} planId={plan.id} workspace={workspace} />
          <Panel title="本计划长期记忆">
            {!brain.data && !brain.error ? (
              <LoadingState label="正在读取运营记忆…" compact />
            ) : memory.length ? (
              <div className="operations-cycle-list">
                {memory.map((item) => (
                  <article key={item.id}>
                    <small className="operations-quiet">
                      {formatTime(item.createdAt)} · 轮次 {item.cycleId}
                    </small>
                    <div className="operations-agent-memory">{item.text}</div>
                  </article>
                ))}
              </div>
            ) : brain.data ? (
              <Empty compact title="尚无本计划记忆">
                智能体可在授权范围内记录经过观察的经验；其他计划的记忆分别保存。
              </Empty>
            ) : (
              <p className="operations-quiet">
                记忆暂未读取，请重试上方的自主状态。
              </p>
            )}
          </Panel>
        </>
      ) : null}
      {grantRevision !== null && plan ? (
        <BrainAuthorization
          key={`${plan.id}:${plan.revision}`}
          plan={plan}
          expectedRevision={grantRevision}
          model={brain.data?.model || s.aiDefaults.model}
          globalBudget={s.aiDefaults.dailyBudgetMicros}
          busy={busy}
          run={run}
          close={() => setGrantRevision(null)}
        />
      ) : null}
    </div>
  );
}

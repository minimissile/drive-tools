import { useEffect, useState } from "react";
import type { OperationsPlan } from "../../shared/intelligent-operations";
import type { OperationsBrainPermissions } from "../../shared/operations-brain";
import { ipc } from "../api/client";
import { formatMoney } from "../lib/format";
import { Dialog } from "../ui/Dialog";
import { CheckboxField } from "../ui/CheckboxField";
import { Button, Notice } from "../ui/primitives";
import { permissionCopy } from "./AutonomyPolicy";
import type { OperationAction } from "./useOperationAction";
import { useOperationDialog } from "./useOperationDialog";

export function BrainAuthorization({
  plan,
  expectedRevision,
  model,
  globalBudget,
  busy,
  run,
  close,
}: {
  plan: OperationsPlan;
  expectedRevision: number;
  model: string;
  globalBudget: number | null;
  busy: boolean;
  run: OperationAction;
  close(): void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const { error, submitting, submit } = useOperationDialog(run, close);
  const changed = plan.revision !== expectedRevision;
  const config = plan.brain;
  useEffect(() => {
    setConfirmed(false);
  }, [model, plan.revision]);
  return (
    <Dialog
      title="授权本计划持续自主运营"
      onClose={close}
      busy={submitting}
      footer={
        <>
          <Button size="compact" disabled={submitting} onClick={close}>
            返回
          </Button>
          <Button
            primary
            size="compact"
            disabled={
              busy ||
              submitting ||
              !confirmed ||
              changed ||
              !config.permissions.read
            }
            onClick={() => {
              void submit(
                () =>
                  ipc("intelligentOps.brain.activate", {
                    planId: plan.id,
                    planRevision: expectedRevision,
                    active: true,
                    permissions: config.permissions,
                    confirmed: true,
                  }),
                "本计划自主范围已授权，执行条件齐备后自动唤醒",
                () => setConfirmed(false),
              );
            }}
          >
            确认持续授权
          </Button>
        </>
      }
    >
      <div className="operations-dialog-form">
        {error ? (
          <div role="alert">
            <Notice danger>{error}</Notice>
          </div>
        ) : null}
        {changed ? (
          <Notice warning>
            计划已发生修改，请返回核对最新配置后重新授权。
          </Notice>
        ) : null}
        <p>
          <strong>{plan.name}</strong> · v{expectedRevision}
          <br />
          <span className="operations-quiet">
            分析模型：{model || "尚未配置"}
          </span>
        </p>
        <Notice>
          本次开启周期性OpenRouter调用。启用业务计划且统一调度运行后，模型会自动读取状态、选择业务工具并记录结果，无需每轮再点击建议。
        </Notice>
        <ul className="operations-grant-scope">
          <li>
            每 {config.wakeMinutes} 分钟唤醒；每日最多 {config.maxCyclesPerDay}{" "}
            轮。
          </li>
          <li>
            每轮最多 {config.maxStepsPerCycle} 步、{config.maxCycleMinutes}{" "}
            分钟、{formatMoney(config.cycleBudgetMicros, "USD")}。
          </li>
          <li>
            本计划每日费用上限 {formatMoney(config.dailyBudgetMicros, "USD")}
            ；全局AI日预算{" "}
            {globalBudget == null
              ? "未设置金额上限"
              : formatMoney(globalBudget, "USD")}
            ，实际执行同时检查两者。
          </li>
          {(Object.keys(permissionCopy) as (keyof OperationsBrainPermissions)[])
            .filter((key) => config.permissions[key])
            .map((key) => (
              <li key={key}>{permissionCopy[key].label}。</li>
            ))}
        </ul>
        <p className="operations-quiet">
          仅限当前计划关联账号、渠道和内容方向。保存的权限范围与本次授权分别管理；停止、修改计划、应用重启或恢复备份后不会自动恢复收费与发布授权。
        </p>
        <CheckboxField
          checked={confirmed}
          disabled={submitting || changed}
          onChange={(e) => setConfirmed(e.target.checked)}
          label="我授权本计划按以上费用上限持续调用OpenRouter，并执行所列动作，直到我停止或授权失效"
        />
      </div>
    </Dialog>
  );
}

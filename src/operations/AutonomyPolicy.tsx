import { useEffect, useState } from "react";
import type {
  OperationsBrainConfig,
  OperationsBrainPermissions,
} from "../../shared/operations-brain";
import { CheckboxField } from "../ui/CheckboxField";
import { Field } from "../ui/primitives";
import { Select } from "../ui/Select";

export const permissionCopy: Record<
  keyof OperationsBrainPermissions,
  { label: string; hint: string }
> = {
  read: {
    label: "观察状态、规划任务与记录经验",
    hint: "读取本计划账号、库存和已接入的实际指标；可准备本地待授权排期、记录本计划记忆。",
  },
  create: {
    label: "创建AI辅助原创内容",
    hint: "按计划方向创建原创版本，不使用未获准的外部素材。",
  },
  reviewOwn: {
    label: "自动核验并审核本智能体创建的版本",
    hint: "仅作用于有本智能体来源记录的准确版本，不审核来源不明的既有内容。",
  },
  publish: {
    label: "提交已审核内容",
    hint: "仍受账号暂停、额度、执行时段、错峰、平台验证与回执规则约束。",
  },
};

export function AutonomyPolicyEditor({
  mode,
  value,
  update,
}: {
  mode: "rules" | "autonomous";
  value: OperationsBrainConfig;
  update(mode: "rules" | "autonomous", value: OperationsBrainConfig): void;
}) {
  const patch = (change: Partial<OperationsBrainConfig>) =>
    update(mode, { ...value, ...change });
  return (
    <section className="operations-form-section" aria-label="运营决策方式">
      <h3>运营决策方式</h3>
      <Field label="决策模式">
        <Select
          value={mode}
          items={[
            { value: "rules", label: "本地规则排期（自主AI关闭）" },
            { value: "autonomous", label: "AI自主运营" },
          ]}
          onValueChange={(next) => update(next as typeof mode, value)}
        />
      </Field>
      {mode === "autonomous" ? (
        <div className="operations-autonomy-config">
          <p className="operations-quiet">
            保存下列范围不代表授权。计划保存后，在“自主运行”确认持续模型调用及权限；启用后按间隔自动决策，无需每轮点击建议。
          </p>
          <div className="operations-fields four">
            <Field label="唤醒间隔（分钟）">
              <input
                type="number"
                min={15}
                max={1440}
                value={value.wakeMinutes}
                onChange={(e) => patch({ wakeMinutes: Number(e.target.value) })}
              />
            </Field>
            <Field label="每日最多轮数">
              <input
                type="number"
                min={1}
                max={48}
                value={value.maxCyclesPerDay}
                onChange={(e) =>
                  patch({ maxCyclesPerDay: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="每轮最多步数">
              <input
                type="number"
                min={1}
                max={12}
                value={value.maxStepsPerCycle}
                onChange={(e) =>
                  patch({ maxStepsPerCycle: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="每轮时长（分钟）">
              <input
                type="number"
                min={1}
                max={20}
                value={value.maxCycleMinutes}
                onChange={(e) =>
                  patch({ maxCycleMinutes: Number(e.target.value) })
                }
              />
            </Field>
            <div className="operations-budget-field">
              <DollarsField
                label="每轮费用上限（美元）"
                value={value.cycleBudgetMicros}
                max={100}
                onChange={(cycleBudgetMicros) => patch({ cycleBudgetMicros })}
              />
            </div>
            <div className="operations-budget-field">
              <DollarsField
                label="每日费用上限（美元）"
                value={value.dailyBudgetMicros}
                max={1000}
                onChange={(dailyBudgetMicros) => patch({ dailyBudgetMicros })}
              />
            </div>
          </div>
          <h3>本计划希望开放的权限</h3>
          <div className="operations-autonomy-permissions">
            {(
              Object.keys(
                permissionCopy,
              ) as (keyof OperationsBrainPermissions)[]
            ).map((key) => (
              <CheckboxField
                key={key}
                label={permissionCopy[key].label}
                hint={permissionCopy[key].hint}
                checked={value.permissions[key]}
                disabled={key !== "read" && !value.permissions.read}
                onChange={(e) =>
                  patch({
                    permissions:
                      key === "read" && !e.target.checked
                        ? {
                            read: false,
                            create: false,
                            reviewOwn: false,
                            publish: false,
                          }
                        : { ...value.permissions, [key]: e.target.checked },
                  })
                }
              />
            ))}
          </div>
          <p className="operations-quiet">
            费用同时受全局AI日预算约束；费用无法核实时停止本轮。模型连接和分析模型沿用“连接与设置”。
          </p>
        </div>
      ) : (
        <p className="operations-quiet">
          本地规则负责确定性排期。自主AI默认关闭，不会因为保存计划而自动收费。
        </p>
      )}
    </section>
  );
}

function DollarsField({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  onChange(value: number): void;
}) {
  const [text, setText] = useState(String(value / 1_000_000));
  useEffect(() => {
    setText((current) =>
      Math.round(Number(current) * 1_000_000) === value
        ? current
        : String(value / 1_000_000),
    );
  }, [value]);
  return (
    <Field label={label}>
      <input
        type="number"
        inputMode="decimal"
        min={0.001}
        max={max}
        step={0.001}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(Math.round(Number(e.target.value) * 1_000_000));
        }}
      />
    </Field>
  );
}

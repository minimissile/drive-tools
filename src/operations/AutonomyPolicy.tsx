import { useEffect, useState } from "react";
import type {
  OperationsBrainConfig,
  OperationsBrainPermissions,
} from "../../shared/operations-brain";
import { CheckboxField } from "../ui/CheckboxField";
import { Field } from "../ui/primitives";
import { Select } from "../ui/Select";

export const reasoningEffortLabels: Record<
  OperationsBrainConfig["reasoningEffort"],
  string
> = {
  auto: "自动（按能力优先 low）",
  default: "模型默认",
  low: "低",
  medium: "中",
  high: "高",
  none: "关闭",
};

export const permissionCopy: Record<
  keyof OperationsBrainPermissions,
  { label: string; hint: string }
> = {
  read: {
    label: "观察状态、规划任务与记录经验",
    hint: "读取计划账号、库存、实际指标及相关官方内容；可发现问题与作者、准备本地待办和排期、记录经验。",
  },
  create: {
    label: "创建AI辅助稿与待审回答",
    hint: "按计划方向准备原创稿或基于问题上下文起草回答；参与回答须本人审核，不自动提交。",
  },
  reviewOwn: {
    label: "自动核验并审核本智能体创建的版本",
    hint: "仅作用于有本智能体来源记录的准确版本，不审核来源不明的既有内容。",
  },
  publish: {
    label: "提交已审核内容",
    hint: "仍受账号暂停、额度、执行时段、错峰、平台验证与回执规则约束。",
  },
  engage: {
    label: "自主参与相关讨论（知乎点赞、评论与关注）",
    hint: "仅围绕真实上下文正常参与；不做互赞互关、账号间配合或模板刷评。须有相关性依据，遇到验证或结果未知即停止。",
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
            <Field label="单次输出上限（token）">
              <input
                type="number"
                min={1000}
                max={16000}
                value={value.maxOutputTokens}
                onChange={(e) =>
                  patch({ maxOutputTokens: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="推理强度">
              <Select
                value={value.reasoningEffort}
                items={Object.entries(reasoningEffortLabels).map(
                  ([value, label]) => ({ value, label }),
                )}
                onValueChange={(reasoningEffort) =>
                  patch({
                    reasoningEffort:
                      reasoningEffort as OperationsBrainConfig["reasoningEffort"],
                  })
                }
              />
            </Field>
          </div>
          <p className="operations-quiet">
            自动仅在模型目录明确支持 low
            时使用低推理强度，否则沿用模型默认。手动选择模型不支持的强度，会在发送请求前阻止并提示。
          </p>
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
                checked={value.permissions[key] === true}
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
                            engage: false,
                          }
                        : { ...value.permissions, [key]: e.target.checked },
                  })
                }
              />
            ))}
          </div>
          {value.permissions.engage ? (
            <div className="operations-fields four">
              <Field
                label="每账号每日互动尝试上限"
                hint="点赞、评论与关注合计，跨计划共用"
              >
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={value.interactionDailyLimit}
                  onChange={(e) =>
                    patch({ interactionDailyLimit: Number(e.target.value) })
                  }
                />
              </Field>
              <Field
                label="互动最小间隔（分钟）"
                hint="另受同出口至少60分钟错峰约束"
              >
                <input
                  type="number"
                  min={60}
                  max={1440}
                  value={value.interactionGapMinutes}
                  onChange={(e) =>
                    patch({ interactionGapMinutes: Number(e.target.value) })
                  }
                />
              </Field>
            </div>
          ) : null}
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

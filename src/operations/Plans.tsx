import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  operationsChannels,
  operationsChannelPolicy,
  operationsPlanInput,
  type OperationsPlan,
  type OperationsSnapshot,
} from "../../shared/intelligent-operations";
import { ipc } from "../api/client";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { Button, Empty, Field, Notice, Panel, Status } from "../ui/primitives";
import { channelNames } from "./labels";
import { ChannelEditor } from "./Policies";
import { MaterialPicker } from "./Materials";
import type { OperationAction } from "./useOperationAction";

export type PlanFields = z.output<typeof operationsPlanInput>;
const editorSchema = operationsPlanInput.safeExtend({
  name: z.string().max(100),
  goal: z.string().max(2000),
});
const fieldsFor = (p?: OperationsPlan): PlanFields => ({
  ...(p ? { id: p.id } : {}),
  name: p?.name ?? "",
  goal: p?.goal ?? "",
  audience: p?.audience ?? "",
  direction: p?.direction ?? "",
  knowledge: p?.knowledge ?? "",
  accounts: p?.accounts ?? [],
  channels: operationsChannels.map(
    (channel) =>
      p?.channels.find((c) => c.channel === channel) ??
      operationsChannelPolicy.parse({ channel }),
  ),
  materialIds: p?.materialIds ?? [],
});

export function OperationsPlans({
  snapshot: s,
  workspace,
  selected,
  select,
  busy,
  run,
}: {
  snapshot: OperationsSnapshot;
  workspace: string;
  selected: string;
  select(id: string): void;
  busy: boolean;
  run: OperationAction;
}) {
  // Keep the authoritative save receipt visible if the following query is slow
  // or fails; a successful creation must not look like a missing plan.
  const [savedPlan, setSavedPlan] = useState<OperationsPlan | null>(null);
  const serverPlan = savedPlan
    ? s.plans.find((p) => p.id === savedPlan.id)
    : null;
  const plans =
    savedPlan && (!serverPlan || serverPlan.revision < savedPlan.revision)
      ? [savedPlan, ...s.plans.filter((p) => p.id !== savedPlan.id)]
      : s.plans;
  const plan = plans.find((p) => p.id === selected);
  return (
    <div className="operations-plan-layout">
      <Panel
        title="运营计划"
        extra={
          <Button size="compact" disabled={busy} onClick={() => select("")}>
            新建计划
          </Button>
        }
      >
        {plans.length ? (
          <div className="operations-plan-list">
            {plans.map((p) => (
              <button
                key={p.id}
                className="operations-plan-choice"
                disabled={busy}
                aria-pressed={p.id === selected}
                onClick={() => select(p.id)}
              >
                <span>
                  <strong>{p.name}</strong>
                  <small>
                    {p.channels
                      .filter((c) => c.enabled)
                      .map((c) => channelNames[c.channel])
                      .join(" · ") || "尚未启用渠道"}{" "}
                    · {p.accounts.length} 个账号
                  </small>
                </span>
                <Status kind={p.active ? "good" : "normal"}>
                  {p.active ? "已启用" : "已暂停"}
                </Status>
              </button>
            ))}
          </div>
        ) : (
          <Empty title="创建第一组运营计划" compact>
            按业务目标选择渠道、账号与素材。新计划保存后保持暂停。
          </Empty>
        )}
      </Panel>
      {selected && !plan ? (
        <Panel title="计划暂不可用">
          <Empty
            title="没有找到这组计划"
            action={
              <Button size="compact" onClick={() => select("")}>
                新建计划
              </Button>
            }
          >
            请重新选择计划。
          </Empty>
        </Panel>
      ) : (
        <PlanEditor
          key={plan?.id ?? "new"}
          plan={plan}
          snapshot={s}
          workspace={workspace}
          busy={busy}
          run={run}
          onSaved={(saved) => {
            setSavedPlan(saved);
            select(saved.id);
          }}
        />
      )}
    </div>
  );
}

function PlanEditor({
  plan,
  snapshot: s,
  workspace,
  busy,
  run,
  onSaved,
}: {
  plan?: OperationsPlan;
  snapshot: OperationsSnapshot;
  workspace: string;
  busy: boolean;
  run: OperationAction;
  onSaved(plan: OperationsPlan): void;
}) {
  const editor = useLocalDraft(
    `panxu-operations-plan-v1:${workspace}:${plan?.id ?? "new"}`,
    fieldsFor(plan),
    (v) => editorSchema.parse(v),
  );
  const value = editor.value;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const save = () =>
    void run(
      () => ipc("intelligentOps.plan.save", operationsPlanInput.parse(value)),
      "运营计划已保存；执行状态以已保存计划为准",
    ).then((result) => {
      if (!result.ok) return;
      if (alive.current) {
        editor.update(fieldsFor(result.value));
        editor.clear();
        onSaved(result.value);
      }
    });
  const dirty = JSON.stringify(value) !== JSON.stringify(fieldsFor(plan));
  const saveDisabled = busy || !value.name.trim() || !value.goal.trim();
  return (
    <Panel
      title={plan ? `编辑 · ${plan.name}` : "新建运营计划"}
      extra={
        <div className="operations-actions">
          {plan ? (
            <Status kind={plan.active ? "good" : "normal"}>
              {plan.active ? "已启用" : "已暂停"} · v{plan.revision}
            </Status>
          ) : (
            <span className="operations-quiet">保存后默认暂停</span>
          )}
          <Button primary size="compact" disabled={saveDisabled} onClick={save}>
            保存计划
          </Button>
        </div>
      }
    >
      <fieldset disabled={busy} className="operations-plan-editor">
        {editor.error ? <Notice warning>{editor.error}</Notice> : null}
        <section className="operations-form-section" aria-label="运营目标">
          <div className="operations-fields">
            <Field label="计划名称" required>
              <input
                value={value.name}
                maxLength={100}
                placeholder="例如：学习资料运营"
                onChange={(e) => editor.update({ name: e.target.value })}
              />
            </Field>
            <Field label="目标受众">
              <input
                value={value.audience}
                maxLength={1000}
                placeholder="希望帮助哪些人"
                onChange={(e) => editor.update({ audience: e.target.value })}
              />
            </Field>
            <Field label="运营目标" required>
              <textarea
                value={value.goal}
                maxLength={2000}
                placeholder="描述这组账号需要完成的运营目标"
                onChange={(e) => editor.update({ goal: e.target.value })}
              />
            </Field>
            <Field label="内容方向与表达风格">
              <textarea
                value={value.direction}
                maxLength={2000}
                placeholder="主题范围、表达习惯与不适合的内容"
                onChange={(e) => editor.update({ direction: e.target.value })}
              />
            </Field>
            <div className="wide">
              <Field
                label="知识依据"
                hint="本计划的资料摘要与可使用事实；不要填写密钥或登录信息。"
              >
                <textarea
                  value={value.knowledge}
                  maxLength={12000}
                  placeholder="补充业务事实、产品资料或已核实的内容依据"
                  onChange={(e) => editor.update({ knowledge: e.target.value })}
                />
              </Field>
            </div>
          </div>
        </section>
        <section
          className="operations-form-section"
          aria-label="渠道与账号规则"
        >
          <h3>渠道与账号规则</h3>
          <p className="operations-quiet">
            平台策略独立；账号覆盖只收紧规则。已有知乎账号计划暂停时，统一中心会显示等待条件。
          </p>
          {value.channels.map((policy) => (
            <ChannelEditor
              key={policy.channel}
              policy={policy}
              accounts={value.accounts}
              availableAccounts={s.accounts}
              capability={s.capabilities.find(
                (c) => c.channel === policy.channel,
              )}
              busy={busy}
              updatePolicy={(next) =>
                editor.update({
                  channels: value.channels.map((c) =>
                    c.channel === policy.channel ? next : c,
                  ),
                })
              }
              updateAccounts={(accounts) => editor.update({ accounts })}
            />
          ))}
        </section>
        <MaterialPicker
          value={value}
          snapshot={s}
          update={(materialIds) => editor.update({ materialIds })}
        />
        <div className="operations-savebar">
          <Button primary size="compact" disabled={saveDisabled} onClick={save}>
            保存计划
          </Button>
          {plan ? (
            <Button
              size="compact"
              disabled={busy || dirty}
              onClick={() =>
                void run(
                  () =>
                    ipc("intelligentOps.plan.active", {
                      id: plan.id,
                      active: !plan.active,
                      confirmed: true,
                    }),
                  plan.active
                    ? "运营计划已暂停"
                    : "运营计划已启用，启动统一调度后按规则执行",
                )
              }
            >
              {plan.active ? "暂停计划" : "启用计划"}
            </Button>
          ) : null}
          <span className="operations-quiet">
            {dirty && plan
              ? "有未保存修改，保存后再启用。"
              : "保存不会启动调度；新计划默认暂停。"}
          </span>
        </div>
      </fieldset>
    </Panel>
  );
}

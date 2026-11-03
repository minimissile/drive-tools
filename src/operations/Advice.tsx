import { useEffect, useState } from "react";
import type { OperationsSnapshot } from "../../shared/intelligent-operations";
import { ipc } from "../api/client";
import { formatMoney, formatTime } from "../lib/format";
import { CheckboxField } from "../ui/CheckboxField";
import { Select } from "../ui/Select";
import { Button, Empty, Field, Notice, Panel } from "../ui/primitives";
import type { OperationAction } from "./useOperationAction";

export function OperationsAdvice({
  snapshot: s,
  busy,
  run,
  openSettings,
}: {
  snapshot: OperationsSnapshot;
  busy: boolean;
  run: OperationAction;
  openSettings(): void;
}) {
  const [selected, setSelected] = useState(s.plans[0]?.id ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const plan = s.plans.find((p) => p.id === selected) ?? s.plans[0];
  const advice = plan?.advice;
  useEffect(() => {
    setConfirmed(false);
  }, [plan?.id, plan?.revision]);
  return (
    <Panel
      title="AI运营建议"
      extra={
        <Button size="compact" onClick={openSettings}>
          配置模型与预算
        </Button>
      }
    >
      {!s.plans.length ? (
        <Empty title="先保存运营目标">
          AI建议按每组计划独立生成，围绕已填写目标、内容方向和本地状态提出建议。
        </Empty>
      ) : (
        <div className="operations-advice">
          <div className="operations-toolbar">
            <Field label="分析哪组计划">
              <Select
                value={plan?.id ?? ""}
                items={s.plans.map((p) => ({ value: p.id, label: p.name }))}
                disabled={busy}
                onValueChange={(v) => {
                  setSelected(v);
                  setConfirmed(false);
                }}
              />
            </Field>
            <div className="operations-quiet">
              分析模型：{s.aiDefaults.model || "尚未配置"}
              <br />
              全局日预算：
              {s.aiDefaults.dailyBudgetMicros == null
                ? "未设置金额上限"
                : formatMoney(s.aiDefaults.dailyBudgetMicros, "USD")}
            </div>
          </div>
          <Notice>
            本地排期不调用模型。此操作将把本计划必要的目标、知识依据和运营摘要交给已配置的AI服务分析；建议仅用于审阅，不会直接发文或变更审核与额度。
          </Notice>
          {!s.aiDefaults.configured ? (
            <Notice warning>请先在连接与设置中配置分析模型及API连接。</Notice>
          ) : null}
          <CheckboxField
            checked={confirmed}
            disabled={busy}
            onChange={(e) => setConfirmed(e.target.checked)}
            label="允许本次调用已配置的AI服务，并按全局预算计费"
          />
          <div>
            <Button
              primary
              size="compact"
              disabled={busy || !plan || !confirmed || !s.aiDefaults.configured}
              onClick={() =>
                void run(
                  () =>
                    ipc("intelligentOps.advice", {
                      planId: plan!.id,
                      confirmed: true,
                    }),
                  "AI建议已保存，未自动修改运营计划",
                ).then((r) => {
                  setConfirmed(false);
                })
              }
            >
              {busy ? "正在处理…" : "生成本次运营建议"}
            </Button>
          </div>
          {advice ? (
            <article>
              <h3>最近建议</h3>
              <p className="operations-quiet">
                {formatTime(advice.createdAt)} · {advice.model}
              </p>
              <p>{advice.summary}</p>
              {advice.suggestions.length ? (
                <>
                  <h3>可采取的行动</h3>
                  <ul>
                    {advice.suggestions.map((v, i) => (
                      <li key={i}>{v}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              {advice.cautions.length ? (
                <>
                  <h3>需留意的条件</h3>
                  <ul>
                    {advice.cautions.map((v, i) => (
                      <li key={i}>{v}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </article>
          ) : (
            <Empty title="尚未生成AI建议">
              可以先使用本地规划；需要分析内容方向或运营安排时，再显式调用AI。
            </Empty>
          )}
        </div>
      )}
    </Panel>
  );
}

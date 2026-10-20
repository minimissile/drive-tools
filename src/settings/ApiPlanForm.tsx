import { z } from "zod";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { SecretField } from "./SecretField";
import { useState } from "react";
import { Check } from "lucide-react";
import { useAppActions, useAppActivity, useAppData } from "../state";
import { Button, Field, Notice } from "../ui/primitives";

import type { ApiPlan } from "../../shared/types";
import { endpointSpecs } from "../../shared/platforms";

export function ApiPlanForm({ plan }: { plan: ApiPlan }) {
  const { command } = useAppActions(),
    { busy } = useAppActivity(),
    { data } = useAppData();
  const editor = useLocalDraft(
    `panxu-api-plan-v1:${data!.dataPath}:${plan.endpoint}`,
    {
      price:
        plan.unitPriceMicros == null
          ? ""
          : String(plan.unitPriceMicros / 1_000_000),
      units: plan.dailyUnits,
      budget:
        plan.dailyBudgetMicros == null
          ? ""
          : String(plan.dailyBudgetMicros / 1_000_000),
    },
    (value) =>
      z
        .object({ price: z.string(), units: z.number(), budget: z.string() })
        .parse(value),
  );
  const { price, units, budget } = editor.value;
  const setPrice = (price: string) => editor.update({ price });
  const setUnits = (units: number) => editor.update({ units });
  const setBudget = (budget: string) => editor.update({ budget });
  const [enabled, setEnabled] = useState(plan.enabled);
  const spec = endpointSpecs[plan.endpoint];
  return (
    <section className="api-plan">
      <div className="panel-heading">
        <h3>{spec.name}</h3>
        <span className="tag">{spec.unit}</span>
      </div>
      {editor.error ? <Notice danger>{editor.error}</Notice> : null}
      <SecretField
        kind={`5118:${plan.endpoint}`}
        configured={plan.configured}
      />
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const saved = await command(
            "api.plan",
            {
              endpoint: plan.endpoint,
              unitPriceMicros:
                price === "" ? null : Math.round(Number(price) * 1e6),
              dailyUnits: units,
              dailyBudgetMicros:
                budget === "" ? null : Math.round(Number(budget) * 1e6),
              enabled,
            },
            "接口计价与预算已保存。",
          );
          if (saved) editor.clear();
        }}
      >
        <div className="field-pair">
          <Field label="实际套餐单价" hint="人民币/计费单位，试用可填0">
            <input
              aria-label={`${spec.name}单价`}
              type="number"
              min="0"
              step="0.001"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </Field>
          <Field label="每日计费单位上限" hint="每天最多调用的计费单位数">
            <input
              type="number"
              required
              step="1"
              min="1"
              max="1000000"
              value={units}
              onChange={(e) => setUnits(Number(e.target.value))}
            />
          </Field>
        </div>
        <Field label="每日金额预算" hint="人民币；留空仅限制计费单位">
          <input
            type="number"
            min="0"
            step="0.01"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
        </Field>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {plan.endpoint === "radar"
            ? "已确认热点API开通权限并启用"
            : "启用此接口"}
        </label>
        <div className="row spread">
          <Button disabled={busy > 0} type="submit">
            <Check size={14} />
            保存配置
          </Button>
          <Button
            quiet
            onClick={() =>
              void command("system.external", { url: spec.referenceUrl })
            }
          >
            官方计费说明
          </Button>
        </div>
      </form>
    </section>
  );
}

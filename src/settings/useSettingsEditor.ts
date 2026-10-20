import { useRef, useState } from "react";
import { z } from "zod";
import { aiModelSelection } from "../../shared/ai-models";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions, useAppData } from "../state";

type Scope = "all" | "ai" | "notes" | "browser";
const parse = (value: unknown) =>
  z
    .object({
      aiModels: aiModelSelection,
      exportCodes: z.boolean(),
      bitUrl: z.string(),
      aiBudget: z.string(),
    })
    .parse(value);

/** Only editable, non-secret settings are persisted. Each save owns its scope. */
export function useSettingsEditor() {
  const { data } = useAppData();
  const { command } = useAppActions();
  const settings = data!.settings;
  const editor = useLocalDraft(
    `panxu-settings-v1:${data!.dataPath}`,
    {
      aiModels: settings.aiModels,
      exportCodes: settings.exportCodes,
      bitUrl: settings.bitUrl,
      aiBudget:
        settings.dailyAiBudgetMicros == null
          ? ""
          : String(settings.dailyAiBudgetMicros / 1e6),
    },
    parse,
  );
  const [budgetError, setBudgetError] = useState("");
  const value = editor.value;
  const latest = useRef(value);
  latest.current = value;
  const dirty = {
    ai:
      JSON.stringify(value.aiModels) !== JSON.stringify(settings.aiModels) ||
      value.aiBudget !==
        (settings.dailyAiBudgetMicros == null
          ? ""
          : String(settings.dailyAiBudgetMicros / 1e6)),
    notes: value.exportCodes !== settings.exportCodes,
    browser: value.bitUrl !== settings.bitUrl,
  };
  const save = async (scope: Scope = "all") => {
    const includesAi = scope === "all" || scope === "ai";
    if (
      includesAi &&
      value.aiBudget !== "" &&
      (!Number.isFinite(Number(value.aiBudget)) || Number(value.aiBudget) < 0)
    ) {
      setBudgetError("请输入大于或等于 0 的每日预算，或留空取消金额上限。");
      document.getElementById("settings-ai-budget")?.focus();
      return null;
    }
    setBudgetError("");
    const result = await command(
      "settings.save",
      {
        ...(includesAi
          ? {
              model: value.aiModels.copy,
              aiModels: value.aiModels,
              dailyAiBudgetMicros:
                value.aiBudget === ""
                  ? null
                  : Math.round(Number(value.aiBudget) * 1e6),
            }
          : {}),
        ...(scope === "all" || scope === "notes"
          ? { exportCodes: value.exportCodes }
          : {}),
        ...(scope === "all" || scope === "browser"
          ? { bitUrl: value.bitUrl }
          : {}),
      },
      scope === "all" ? "通用设置已保存。" : "此分区设置已保存。",
    );
    if (result && scope === "all" && latest.current === value) editor.clear();
    return result;
  };
  return { ...editor, dirty, budgetError, save };
}

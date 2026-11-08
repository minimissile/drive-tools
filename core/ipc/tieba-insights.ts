import {
  tiebaInsightsRefreshSchema,
  tiebaInsightsSaveSchema,
  tiebaInsightsPresetSchema,
} from "../../shared/tieba-insights";
import type { HandlerMap, HandlerServices } from "./types";
export function createTiebaInsightsHandlers({
  tiebaInsights,
}: Pick<HandlerServices, "tiebaInsights">) {
  return {
    "tieba.insights.snapshot": () => tiebaInsights.snapshot(),
    "tieba.insights.refresh": (raw) =>
      tiebaInsights.refresh(tiebaInsightsRefreshSchema.parse(raw)),
    "tieba.insights.save": (raw) =>
      tiebaInsights.save(tiebaInsightsSaveSchema.parse(raw)),
    "tieba.insights.applyPreset": (raw) =>
      tiebaInsights.applyPreset(tiebaInsightsPresetSchema.parse(raw)),
  } satisfies HandlerMap;
}

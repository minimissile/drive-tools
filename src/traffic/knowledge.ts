import type { Keyword } from "../../shared/types";

/** Historical API payloads may contain nested objects; pool metrics are scalar. */
export function keywordMetrics(
  raw: Record<string, unknown>,
): Keyword["metrics"] {
  const metrics: Keyword["metrics"] = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      value === null ||
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      metrics[key] = value;
  }
  return metrics;
}

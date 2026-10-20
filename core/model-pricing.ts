import type { ModelPriceLine } from "../shared/model-pricing";

export function nonnegativePrice(raw: unknown): number | null {
  if (raw == null || raw === "" || typeof raw === "boolean") return null;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

export function imagePriceLines(raw: unknown): ModelPriceLine[] {
  const data = raw as {
    endpoints?: {
      provider_name?: string;
      pricing?: {
        billable?: string;
        unit?: string;
        cost_usd?: unknown;
        variant?: string;
      }[];
    }[];
  };
  if (!Array.isArray(data?.endpoints)) return [];
  return data.endpoints.flatMap((endpoint) =>
    (Array.isArray(endpoint.pricing) ? endpoint.pricing : []).flatMap(
      (line) => {
        const usd = nonnegativePrice(line.cost_usd);
        return usd == null || !line.billable || !line.unit
          ? []
          : [
              {
                billable: line.billable,
                unit: line.unit,
                usd,
                ...(line.variant ? { variant: line.variant } : {}),
                ...(endpoint.provider_name
                  ? { provider: endpoint.provider_name }
                  : {}),
              },
            ];
      },
    ),
  );
}

/** Dedicated video SKU names use both dollars and cents; token prices are never seconds. */
export function videoPriceLines(raw: unknown): ModelPriceLine[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw).flatMap(([sku, value]) => {
    const n = nonnegativePrice(value);
    if (n == null) return [];
    let prefix = "",
      unit = "",
      billable = "output_video",
      scale = 1;
    if (/^(text_to_video|image_to_video)_duration_seconds/.test(sku)) {
      const kind = sku.startsWith("text_to_video")
        ? "text_to_video"
        : "image_to_video";
      prefix = `${kind}_duration_seconds`;
      unit = "second";
    } else if (/^(duration_seconds|per-video-second)/.test(sku)) {
      prefix = sku.startsWith("duration_seconds")
        ? "duration_seconds"
        : "per-video-second";
      unit = "second";
    } else if (/^cents_per_(video_output_second|second_output)/.test(sku)) {
      prefix = sku.startsWith("cents_per_video")
        ? "cents_per_video_output_second"
        : "cents_per_second_output";
      unit = "second";
      scale = 0.01;
    } else if (/^video_tokens/.test(sku)) {
      prefix = "video_tokens";
      unit = "token";
    } else if (sku === "cents_per_image_input") {
      prefix = sku;
      unit = "image";
      billable = "input_image";
      scale = 0.01;
    } else if (sku === "minimum_cents_per_generation") {
      prefix = sku;
      unit = "request";
      billable = "minimum_generation";
      scale = 0.01;
    } else return [];
    const variant = `${sku.startsWith("text_to_video") ? "文生视频 · " : sku.startsWith("image_to_video") ? "图生视频 · " : ""}${sku
      .slice(prefix.length)
      .replace(/^[-_]/, "")
      .replace("without_audio", "无音频")
      .replace("with_audio", "含音频")
      .replaceAll("_", " · ")}`;
    return [
      { billable, unit, usd: n * scale, ...(variant ? { variant } : {}) },
    ];
  });
}

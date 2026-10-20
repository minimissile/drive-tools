import type { MediaModel } from "../shared/studio";
import { priceLineText } from "../shared/model-pricing";
import { imagePriceLines, videoPriceLines } from "./model-pricing";
import { AppError } from "./errors";

type Request = (
  url: string,
  init?: RequestInit,
) => Promise<Record<string, any>>;
const base = "https://openrouter.ai/api/v1";

/** Refresh metadata only. Missing endpoint quotes retain their original timestamp. */
export async function loadMediaModelCatalog(
  request: Request,
  previous: MediaModel[],
  issues: Record<string, string>,
): Promise<MediaModel[]> {
  const [images, videos] = await Promise.all([
    request(`${base}/images/models`),
    request(`${base}/videos/models`),
  ]);
  if (!Array.isArray(images.data) || !Array.isArray(videos.data))
    throw new AppError(
      "MEDIA_MODELS_INVALID",
      "未取得完整图片和视频模型列表，请稍后刷新。",
    );
  const checkedAt = new Date().toISOString();
  const results: MediaModel[] = new Array(images.data.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, images.data.length) }, async () => {
      while (cursor < images.data.length) {
        const i = cursor++,
          m = images.data[i],
          id = String(m.id);
        let lines = previous.find((p) => p.id === id)?.priceLines ?? [];
        let pricingUpdatedAt = previous.find(
          (p) => p.id === id,
        )?.pricingUpdatedAt;
        let pricingError: string | undefined;
        try {
          const path = id.split("/").map(encodeURIComponent).join("/");
          const detail = await request(
            `${base}/images/models/${path}/endpoints`,
            { signal: AbortSignal.timeout(15_000) },
          );
          const latest = imagePriceLines(detail);
          if (!latest.some((line) => line.billable === "output_image"))
            throw new Error("Missing output quote");
          lines = latest;
          pricingUpdatedAt = checkedAt;
        } catch {
          pricingError = lines.length
            ? "本次未取得图片生成报价，保留旧报价供参考；可刷新重试。"
            : "本次未取得图片生成报价，费用未知；可刷新重试或查看官方模型页。";
        }
        results[i] = {
          id,
          name: String(m.name ?? id),
          kind: "image",
          description: String(m.description ?? ""),
          ratios: m.supported_parameters?.aspect_ratio?.values ?? [],
          durations: [],
          resolutions: m.supported_parameters?.resolution?.values ?? [],
          audio: false,
          reference:
            Number(m.supported_parameters?.input_references?.max ?? 0) > 0,
          qualities: m.supported_parameters?.quality?.values ?? [],
          lastError: issues[id],
          priceLines: lines,
          pricingUpdatedAt,
          pricingError,
          pricing:
            lines.map(priceLineText).join("；") ||
            "尚未取得生成报价，请刷新或查看官方模型页。",
        };
      }
    }),
  );
  return [
    ...results,
    ...videos.data.map((m: any): MediaModel => {
      const lines = videoPriceLines(m.pricing_skus);
      return {
        id: String(m.id),
        name: String(m.name ?? m.id),
        kind: "video",
        description: String(m.description ?? ""),
        lastError: issues[String(m.id)],
        ratios: m.supported_aspect_ratios ?? [],
        durations: m.supported_durations ?? [],
        resolutions: m.supported_resolutions ?? [],
        audio: m.generate_audio === true,
        reference: (m.supported_frame_images ?? []).includes("first_frame"),
        priceLines: lines,
        pricingUpdatedAt: lines.length ? checkedAt : undefined,
        pricing:
          lines.map(priceLineText).join("；") ||
          "尚未取得可识别的计价规格，请查看官方模型页。",
      };
    }),
  ];
}

import {
  qualityModels,
  modelsForPurpose,
  recommendationCandidates,
  type AiCatalog,
  type AiPurpose,
  type AiModel,
} from "../../shared/ai-models";
import type { MediaModel } from "../../shared/studio";
import { usd } from "../../shared/model-pricing";

export const modelStrategies = [
  {
    value: "value",
    label: "性价比优先",
    description: "优先低成本的日常创作与批量整理候选，复杂任务可升级。",
  },
  {
    value: "balanced",
    label: "均衡推荐",
    description: "兼顾内容质量、用途匹配与费用，适合日常正式工作。",
  },
  {
    value: "quality",
    label: "效果优先",
    description: "优先复杂理解、精细创作与成片质量，费用通常更高。",
  },
] as const;
export type ModelStrategy = (typeof modelStrategies)[number]["value"];
export type PurposeModel = AiModel | MediaModel;

/** Presets are real model IDs inside the existing menu, never saved as strategy placeholders. */
export function modelDropdownOptions(catalog: AiCatalog, purpose: AiPurpose) {
  const options = modelsForPurpose(purpose, catalog);
  const tags = new Map<string, string[]>();
  for (const strategy of modelStrategies) {
    const model = recommendPurposeModel(catalog, purpose, strategy.value);
    if (!model) continue;
    tags.set(model.id, [...(tags.get(model.id) ?? []), strategy.label]);
  }
  const item = (model: PurposeModel) => ({
    value: model.id,
    label: tags.has(model.id)
      ? `${tags.get(model.id)!.join(" / ")} · ${model.name} · ${modelPriceSummary(model).rate}`
      : model.name,
  });
  return [
    ...[...tags.keys()].map((id) =>
      item(options.find((model) => model.id === id)!),
    ),
    ...options.filter((model) => !tags.has(model.id)).map(item),
  ];
}
const valueModels: Record<AiPurpose, string[]> = {
  copy: [
    "qwen/qwen3.8-flash",
    "deepseek/deepseek-v4.1-flash",
    "google/gemini-3.1-flash-lite",
  ],
  analysis: [
    "deepseek/deepseek-v4.1-flash",
    "qwen/qwen3.8-flash",
    "google/gemini-3.1-flash-lite",
  ],
  vision: [
    "qwen/qwen3.8-flash",
    "google/gemini-3.1-flash-lite",
    "deepseek/deepseek-v4.1-flash",
  ],
  image: [
    "qwen/qwen-image-2.1-turbo",
    "bytedance-seed/seedream-5-0-flash",
    "bytedance-seed/seedream-5-0-lite",
  ],
  video: ["google/veo-3.1-lite", "kwaivgi/kling-v3.0-std", "alibaba/wan-2.6"],
};
const balancedModels: Record<AiPurpose, string[]> = {
  copy: [
    "qwen/qwen3.8-max-0902",
    "google/gemini-3.8-flash",
    "anthropic/claude-sonnet-5.5",
  ],
  analysis: [
    "qwen/qwen3.8-max-0902",
    "google/gemini-3.8-flash",
    "deepseek/deepseek-v4.1-flash",
  ],
  vision: [
    "google/gemini-3.8-flash",
    "qwen/qwen3.8-max-0902",
    "anthropic/claude-sonnet-5.5",
  ],
  image: [
    "qwen/qwen-image-3",
    "bytedance-seed/seedream-5-0-lite",
    "qwen/qwen-image-3-pro",
  ],
  video: ["google/veo-3.1-fast", "kwaivgi/kling-v3.0-pro", "alibaba/wan-2.7"],
};

const known = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;
export function hasComparableQuote(model: PurposeModel): boolean {
  if ("promptPrice" in model)
    return known(model.promptPrice) && known(model.completionPrice);
  return (
    !model.pricingError &&
    !!model.priceLines?.some(
      (p) =>
        p.billable ===
          (model.kind === "image" ? "output_image" : "output_video") &&
        known(p.usd),
    )
  );
}
export function recommendPurposeModel(
  catalog: AiCatalog,
  purpose: AiPurpose,
  strategy: ModelStrategy,
): PurposeModel | undefined {
  const order =
    strategy === "quality"
      ? qualityModels[purpose]
      : strategy === "value"
        ? valueModels[purpose]
        : balancedModels[purpose];
  const candidates = recommendationCandidates(purpose, catalog);
  // Cost-based plans never treat a missing quote as free, and never mix per-token and per-second ranking.
  return order
    .map((id) => candidates.find((m) => m.id === id))
    .find((m) => m && (strategy === "quality" || hasComparableQuote(m)));
}

export function modelFit(id: string): string {
  if (/qwen3.8-flash/.test(id))
    return "多模态与图表理解，适合低成本初稿、批量筛选和截图提取。";
  if (/qwen3.8-max/.test(id))
    return "复杂分析与多模态理解候选，适合中文资料整理和内容深化。";
  if (/deepseek-v4.1-flash/.test(id))
    return "稀疏推理与结构化输出候选，适合资料筛选和需求拆解；注意时段报价。";
  if (/claude-sonnet/.test(id))
    return "日常复杂任务与指令遵循候选，适合长文组织和多轮修改。";
  if (/claude-opus/.test(id))
    return "复杂多步推理候选，用于密集截图与难例复核；常规识图可选低价模型。";
  if (/gemini.*flash/.test(id) && !/image/.test(id))
    return "多模态理解候选，适合截图、图表和文档；Lite 档侧重轻量任务。";
  if (/qwen-image-2.1-turbo/.test(id))
    return "快速低价的图片生成与编辑档，适合封面初稿和多版本试稿。";
  if (/qwen-image-3/.test(id))
    return "侧重图片文字和细节呈现，适合中文海报；生成后核对字形与事实。";
  if (/seedream/.test(id))
    return "图片生成与编辑候选，Flash/Lite 适合试稿，Pro 侧重精细视觉制作。";
  if (/gpt-image-2.5-sunburst/.test(id))
    return "侧重精细创作与编辑准确度；按图像令牌计费，不能当作固定单张价格。";
  if (/veo-3.1-lite/.test(id))
    return "低成本迭代档，支持720p/1080p与原生音频，适合动态画面试稿。";
  if (/veo-3.1-fast/.test(id))
    return "兼顾周转速度与画质，支持原生音频，适合常用营销短片。";
  if (/veo-3.1/.test(id))
    return "面向最终成片的视觉保真与原生音频，适合确认方案后的精细制作。";
  return "按官方目录核对输入输出能力；具体效果需结合自己的素材评估。";
}

export function modelPriceSummary(model: PurposeModel): {
  rate: string;
  example: string;
} {
  if ("promptPrice" in model) {
    const rate = `每百万令牌：输入 ${known(model.promptPrice) ? usd(model.promptPrice * 1e6) : "未报价"} / 输出 ${known(model.completionPrice) ? usd(model.completionPrice * 1e6) : "未报价"}`;
    return {
      rate,
      example:
        known(model.promptPrice) && known(model.completionPrice)
          ? `示例：输入2千 + 输出1千令牌约 ${usd(model.promptPrice * 2000 + model.completionPrice * 1000 + (model.requestPrice ?? 0))}；不含图片、缓存与额外推理费用。`
          : "报价不完整，暂不估算单次费用。",
    };
  }
  const lines =
    model.priceLines?.filter(
      (p) =>
        p.billable ===
          (model.kind === "image" ? "output_image" : "output_video") &&
        known(p.usd),
    ) ?? [];
  const unit = model.kind === "image" ? "image" : "second";
  const comparable = lines.filter((p) => p.unit === unit);
  if (comparable.length) {
    const low = Math.min(...comparable.map((p) => p.usd)),
      high = Math.max(...comparable.map((p) => p.usd));
    const range = (scale = 1) =>
      low === high
        ? usd(low * scale)
        : `${usd(low * scale)}–${usd(high * scale)}`;
    return {
      rate: `已报价档位：${range()}/${unit === "image" ? "张" : "秒"}`,
      example:
        model.kind === "image"
          ? "按分辨率与供应商报价，输入素材可能另计；展开查看规格。"
          : `8秒输出示例 ${range(8)}，取决于分辨率与音频档位，不含输入及最低收费；展开查看规格。`,
    };
  }
  const tokens = lines.filter((p) => p.unit === "token");
  if (tokens.length)
    return {
      rate: `输出${model.kind === "image" ? "图像" : "视频"}令牌：${usd(Math.min(...tokens.map((p) => p.usd)) * 1e6)}/百万起`,
      example: "总价取决于实际输出令牌与输入费用，暂不换算为每张或每秒。",
    };
  return {
    rate: "生成费用尚未报价",
    example: "刷新官方报价或查看模型页，未知费用不视为免费。",
  };
}

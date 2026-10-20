import { z } from "zod";
import type { MediaModel } from "./studio";

export const aiPurposes = [
  "copy",
  "analysis",
  "vision",
  "image",
  "video",
] as const;
export type AiPurpose = (typeof aiPurposes)[number];
export const aiModelSelection = z.object({
  copy: z.string().trim().max(200).default(""),
  analysis: z.string().trim().max(200).default(""),
  vision: z.string().trim().max(200).default(""),
  image: z.string().trim().max(200).default(""),
  video: z.string().trim().max(200).default(""),
});
export type AiModelSelection = z.infer<typeof aiModelSelection>;
export interface AiModel {
  id: string;
  name: string;
  promptPrice: number | null;
  completionPrice: number | null;
  structured: boolean;
  imageInput?: boolean;
  textOutput?: boolean;
  reasoningEfforts?: string[];
  lastError?: string;
  description?: string;
  contextLength?: number;
  requestPrice?: number | null;
  pricingNote?: string;
  pricingUpdatedAt?: string;
}
export interface AiCatalog {
  text: AiModel[];
  media: MediaModel[];
}
export const aiPurposeDetails: Record<
  AiPurpose,
  { label: string; description: string; recommendation: string }
> = {
  copy: {
    label: "文案创作",
    description: "营销文案、主题短文、图文脚本与视频分镜",
    recommendation: "优先表达清晰、遵循创作要求的 Claude Sonnet 5.5。",
  },
  analysis: {
    label: "资源分析",
    description: "资源筛选、需求解析、关键词与选题分析",
    recommendation: "优先 Qwen3.8 Max 的中文理解与结构化分析能力。",
  },
  vision: {
    label: "截图理解",
    description: "识别截图表头、列顺序与图片中的筛选需求",
    recommendation: "优先擅长密集图表和截图分析的 Claude Opus 5.5。",
  },
  image: {
    label: "图片生成",
    description: "营销封面、海报与图文组图的实际图片",
    recommendation: "优先侧重精细创作与编辑准确度的 GPT Image 2.5 Sunburst。",
  },
  video: {
    label: "动态视频",
    description: "根据分镜生成实际动态画面，支持时可生成原生音频",
    recommendation: "优先面向成片画质、支持1080p与原生音频的 Veo 3.1。",
  },
};
export const qualityModels: Record<AiPurpose, string[]> = {
  copy: [
    "anthropic/claude-sonnet-5.5",
    "anthropic/claude-sonnet-5",
    "qwen/qwen3.8-max-0902",
    "openai/gpt-6.1-sol",
  ],
  analysis: [
    "qwen/qwen3.8-max-0902",
    "openai/gpt-6.1-sol",
    "anthropic/claude-sonnet-5.5",
    "qwen/qwen3-235b-a22b-2507",
  ],
  vision: [
    "anthropic/claude-opus-5.5",
    "anthropic/claude-sonnet-5.5",
    "google/gemini-3.8-flash",
    "qwen/qwen3.8-max-0902",
    "google/gemini-3.1-pro-preview",
  ],
  image: [
    "openai/gpt-image-2.5-sunburst",
    "qwen/qwen-image-3-pro",
    "google/gemini-3.1-flash-image",
    "bytedance-seed/seedream-5-0-pro",
  ],
  video: [
    "google/veo-3.1",
    "bytedance/seedance-2.5",
    "kwaivgi/kling-v3.0-pro",
    "google/veo-3.1-fast",
  ],
};
export function resolveAiModels(raw: unknown, legacy = ""): AiModelSelection {
  const parsed = aiModelSelection.safeParse(raw ?? {});
  const result = parsed.success ? parsed.data : aiModelSelection.parse({});
  return {
    ...result,
    copy: result.copy || legacy,
    analysis: result.analysis || legacy,
    vision: result.vision || legacy,
  };
}
export function purposeForCall(
  name: string,
  hasImages = false,
): "copy" | "analysis" | "vision" {
  if (hasImages) return "vision";
  return [
    "keywords",
    "keyword_ideas",
    "resource_export_plan",
    "resource_export_match",
    "zhidao_hot_names",
  ].includes(name)
    ? "analysis"
    : "copy";
}
export function modelsForPurpose(purpose: AiPurpose, catalog: AiCatalog) {
  return purpose === "image" || purpose === "video"
    ? catalog.media.filter((m) => m.kind === purpose)
    : catalog.text.filter(
        (m) =>
          m.structured &&
          m.textOutput !== false &&
          (purpose !== "vision" || m.imageInput),
      );
}
export function recommendationCandidates(p: AiPurpose, catalog: AiCatalog) {
  const group =
    p === "image" || p === "video"
      ? catalog.media.filter((m) => m.kind === p)
      : catalog.text;
  const regionLimited = new Set(
    group
      .filter((m) => m.lastError && /region|地区/i.test(m.lastError))
      .map((m) => m.id.split("/")[0]),
  );
  return modelsForPurpose(p, catalog).filter(
    (m) => !m.lastError && !regionLimited.has(m.id.split("/")[0]),
  );
}
export function recommendAiModels(catalog: AiCatalog): AiModelSelection {
  return Object.fromEntries(
    aiPurposes.map((p) => {
      const candidates = recommendationCandidates(p, catalog);
      return [
        p,
        qualityModels[p].find((id) => candidates.some((m) => m.id === id)) ??
          "",
      ];
    }),
  ) as AiModelSelection;
}

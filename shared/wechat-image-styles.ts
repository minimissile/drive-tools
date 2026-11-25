import { z } from "zod";

export const wechatImageStyleSchema = z.enum(["natural", "vivid"]);
export type WechatImageStyle = z.infer<typeof wechatImageStyleSchema>;
export const defaultWechatImageStyle: WechatImageStyle = "natural";
export const wechatUnifiedCover = {
  id: "unified-cover",
  label: "公众号统一风格",
  size: { width: 900, height: 383 },
  defaultModel: "bytedance-seed/seedream-5-0-flash",
  defaultModelLabel: "Seedream 5.0 Flash",
} as const;

export const wechatCoverVariantSchema = z.enum([
  "cream-stationery",
  "sky-blue",
  "lemon-pop",
]);
export type WechatCoverVariant = z.infer<typeof wechatCoverVariantSchema>;
export const defaultWechatCoverVariant: WechatCoverVariant = "sky-blue";
export const wechatCoverVariants = {
  "cream-stationery": {
    label: "奶油手账",
    description: "奶油纸纹、浅蓝贴纸边和柔和的立体字。",
  },
  "sky-blue": {
    label: "晴空蓝（推荐）",
    description: "晴空蓝底、黄白双色大标题和透亮的立体主图。",
  },
  "lemon-pop": {
    label: "亮黄波普",
    description: "柠檬黄底、钴蓝圆形和高对比的厚立体字。",
  },
} as const satisfies Record<
  WechatCoverVariant,
  { label: string; description: string }
>;

export const wechatImageStyles = [
  {
    id: "natural",
    label: "自然重绘（推荐）",
    description: "保留原有画面类型，调整取景与光影，让画面自然且有明显变化。",
  },
  {
    id: "vivid",
    label: "吸睛增强",
    description:
      "基于原图重新构图，突出主体、光影层次与色彩，增强第一眼的吸引力。",
  },
] as const satisfies readonly {
  id: WechatImageStyle;
  label: string;
  description: string;
}[];

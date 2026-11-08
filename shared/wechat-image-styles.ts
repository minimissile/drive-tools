import { z } from "zod";

export const wechatImageStyleSchema = z.enum(["natural", "vivid"]);
export type WechatImageStyle = z.infer<typeof wechatImageStyleSchema>;
export const defaultWechatImageStyle: WechatImageStyle = "natural";

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

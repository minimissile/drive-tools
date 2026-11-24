import { z } from "zod";

export const legacyWechatRewriteStyleIds = [
  "natural",
  "explain",
  "tutorial",
  "checklist",
  "commentary",
  "story",
] as const;
export const wechatRewriteStyleIds = [
  ...legacyWechatRewriteStyleIds,
  "problem",
  "comparison",
  "myth",
  "qa",
] as const;
export const wechatRewriteStyleSchema = z.enum(wechatRewriteStyleIds);
export type WechatRewriteStyleId = z.infer<typeof wechatRewriteStyleSchema>;
export const defaultWechatRewriteStyle: WechatRewriteStyleId = "natural";

export interface WechatRewriteStyleMeta {
  id: WechatRewriteStyleId;
  label: string;
  description: string;
}

/** Shared display copy only; controlled model instructions stay in the backend. */
export const wechatRewriteStyles = [
  {
    id: "natural",
    label: "自然润色（推荐）",
    description: "保留原意与语气，删去套话，让中文表达更自然。",
  },
  {
    id: "explain",
    label: "通俗科普",
    description: "解释已有术语和概念，帮助读者读懂原文。",
  },
  {
    id: "tutorial",
    label: "干货教程",
    description: "按原文材料整理步骤、适用条件和注意事项。",
  },
  {
    id: "checklist",
    label: "清单要点",
    description: "提炼并列要点与必要理由，方便快速查阅。",
  },
  {
    id: "commentary",
    label: "观点评论",
    description: "理清论据与观点，区分事实、判断和推测。",
  },
  {
    id: "story",
    label: "故事共鸣",
    description: "围绕原文已有的人物、情节和场景组织表达。",
  },
  {
    id: "problem",
    label: "痛点切入",
    description: "从读者的具体困扰开篇，尽早给出原文已有的解法和适用条件。",
  },
  {
    id: "comparison",
    label: "对比选型",
    description: "按共同维度比较原文已有的选项，讲清各自适合谁、怎么选。",
  },
  {
    id: "myth",
    label: "误区拆解",
    description: "澄清原文提到的误解或易混淆条件，说明结论和适用边界。",
  },
  {
    id: "qa",
    label: "问答速读",
    description: "用原文能回答的读者问题组织正文，每问先给简短答案。",
  },
] as const satisfies readonly WechatRewriteStyleMeta[];

export const wechatRewriteStyleMeta = Object.fromEntries(
  wechatRewriteStyles.map((style) => [style.id, style]),
) as Record<WechatRewriteStyleId, WechatRewriteStyleMeta>;

export function wechatRewriteStyleLabel(styleId?: WechatRewriteStyleId) {
  return (
    (styleId &&
      wechatRewriteStyleMeta[styleId]?.label.replace(/（推荐）$/, "")) ||
    "未标注"
  );
}

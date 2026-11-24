import { z } from "zod";

export const zhidaoAnswerLanguage = z.enum([
  "mandarin",
  "cantonese",
  "sichuanese",
  "northeastern",
]);
export type ZhidaoAnswerLanguage = z.infer<typeof zhidaoAnswerLanguage>;
export const zhidaoAnswerLanguageLabels: Record<ZhidaoAnswerLanguage, string> =
  {
    mandarin: "普通话",
    cantonese: "粤语",
    sichuanese: "川渝话",
    northeastern: "东北话",
  };

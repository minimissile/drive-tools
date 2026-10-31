import { windowStorage } from "../storage/window-storage";
import { z } from "zod";
import { readDraft, writeDraft } from "../storage/local-draft";
import { answerStyle } from "../../shared/answer-styles";

export const answerCategories = [
  { value: "emotion", label: "情感" },
  { value: "general", label: "综合" },
  { value: "education", label: "教育" },
] as const;
export const answerDraftSchema = z.object({
  mode: z.enum(["manual", "auto"]),
  question: z.string(),
  style: answerStyle,
  accountId: z.string(),
  count: z.number(),
  categories: z
    .array(z.enum(["emotion", "general", "education"]))
    .default(["emotion"])
    .transform((categories) => [categories[0] ?? "emotion"]),
  intervalSeconds: z.number().default(30),
  instructions: z.string().default(""),
});
export const defaultAnswerDraft: z.infer<typeof answerDraftSchema> = {
  mode: "manual",
  question: "",
  style: "清晰实用",
  accountId: "",
  count: 30,
  categories: ["emotion"],
  intervalSeconds: 30,
  instructions: "",
};
export const answerDraftKey = (workspace: string) =>
  `panxu-answers:${workspace}`;

/** A navigation handoff restores text and account selection, never submission consent. */
export function prepareAutoAnswer(workspace: string, accountId: string) {
  const key = answerDraftKey(workspace);
  const previous = readDraft(windowStorage, key, (v) =>
    answerDraftSchema.parse(v),
  );
  if (
    !writeDraft(windowStorage, key, {
      ...(previous ?? defaultAnswerDraft),
      mode: "auto",
      accountId,
      ...(!previous ? { style: "第一人称共鸣" as const } : {}),
    })
  )
    throw new Error("无法保存答题配置，请进入工作台的智能问答手动选择账号。");
}

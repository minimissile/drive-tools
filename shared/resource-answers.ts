import { z } from "zod";
export const answerStyles = [
  "清晰实用",
  "简洁直接",
  "专业详解",
  "新手友好",
  "自然口语",
  "推广推荐",
] as const;
export const answerInput = z.object({
  requestId: z.string().uuid(),
  question: z.string().trim().min(1).max(4000),
  resourceIds: z.array(z.string().min(1).max(100)).min(1).max(10),
  style: z.enum(answerStyles),
  format: z.enum(["text", "mixed", "image"]),
  instruction: z.string().trim().max(4000).default(""),
  previousId: z.string().uuid().nullable().default(null),
});
export type ResourceAnswerInput = z.infer<typeof answerInput>;
export const answerResponse = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20000),
  cards: z
    .array(
      z.object({
        heading: z.string().max(120),
        copy: z.string().max(1500),
        imagePrompt: z.string().min(1).max(4000),
      }),
    )
    .max(2),
});
export interface ResourceAnswer {
  id: string;
  input: ResourceAnswerInput;
  createdAt: string;
  status: "generating" | "completed" | "failed" | "uncertain";
  error: string;
  title: string;
  body: string;
  draftId: string | null;
  resources: { id: string; title: string }[];
}
type Contract<A, V> = { args: A; value: V };
export interface ResourceAnswerContract {
  "resourceAnswers.list": Contract<undefined, ResourceAnswer[]>;
  "resourceAnswers.generate": Contract<ResourceAnswerInput, ResourceAnswer>;
  "resourceAnswers.copy": Contract<
    { id: string; format: "text" | "rich" },
    boolean
  >;
  "studio.assetCopy": Contract<{ name: string }, boolean>;
}

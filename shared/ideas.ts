import { z } from "zod";

export const ideaInput = z.object({
  resourceId: z.string().nullable().default(null),
  seeds: z.array(z.string().trim().min(1).max(100)).max(10),
  audience: z.string().trim().max(200).default(""),
  objective: z.string().trim().max(600).default(""),
  focus: z.enum(["balanced", "seo", "geo"]).default("balanced"),
  channel: z
    .enum([
      "all",
      "csdn",
      "zhihu",
      "xiaohongshu",
      "wechat",
      "douyin",
      "kuaishou",
      "weibo",
      "tieba",
      "douban",
      "x",
    ])
    .default("all"),
  count: z.union([z.literal(12), z.literal(20)]).default(12),
  useLocal: z.boolean().default(true),
});
export type IdeaInput = z.infer<typeof ideaInput>;
export const ideaCandidate = z
  .object({
    word: z.string().trim().min(2).max(100),
    kind: z.enum(["seed", "longtail", "question"]),
    cluster: z.string().trim().min(1).max(40),
    intent: z.enum([
      "learn",
      "howto",
      "troubleshoot",
      "compare",
      "choose",
      "template",
    ]),
    priority: z.enum(["high", "medium", "low"]),
    reason: z.string().trim().min(1).max(180),
    angle: z.string().trim().min(1).max(200),
    answerQuestion: z.string().trim().min(1).max(180),
    evidenceNeeded: z.string().trim().min(1).max(200),
    localRefIds: z.array(z.string().max(180)).max(3),
  })
  .strict();
export const ideaResponse = z
  .object({
    strategy: z.string().trim().min(1).max(600),
    candidates: z.array(ideaCandidate).min(1).max(20),
  })
  .strict();
export interface IdeaReference {
  id: string;
  word: string;
  source: string;
  poolName: string | null;
  platform: string | null;
  fetchedAt: string | null;
}
export interface IdeaContext {
  input: IdeaInput;
  resource: {
    title: string;
    summary: string;
    category: string;
    tags: string[];
    filenames: string[];
  } | null;
  references: IdeaReference[];
  localCount: number;
  promptVersion: string;
  instruction: string;
}
export interface IdeaRun {
  id: string;
  createdAt: string;
  model: string;
  context: IdeaContext;
  strategy: string;
  candidates: (z.infer<typeof ideaCandidate> & {
    id: string;
    alreadyLocal: boolean;
  })[];
}
export interface IdeaProvenance {
  runId: string;
  kind: string;
  cluster: string;
  angle: string;
  answerQuestion: string;
  evidenceNeeded: string;
  references: string[];
}

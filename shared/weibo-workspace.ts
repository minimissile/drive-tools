import { z } from "zod";
import type { WeiboStatisticsSample } from "./weibo-statistics";

export const weiboContentKinds = {
  resource: "资源分享",
  tutorial: "教程技巧",
  question: "问题解答",
  note: "日常分享",
} as const;
export const weiboIdeaInput = z.object({
  id: z
    .string()
    .regex(/^wbidea_[\w-]+$/)
    .optional(),
  accountId: z.string().max(150).default(""),
  title: z.string().trim().min(1).max(200),
  sourceId: z.string().max(200).default("manual"),
  text: z.string().max(2000).default(""),
  kind: z
    .enum(["resource", "tutorial", "question", "note"])
    .default("resource"),
  copyId: z.string().max(100).default(""),
  evidence: z.string().max(5000).default(""),
  audience: z.string().max(100).default(""),
  plannedAt: z.iso.datetime().nullable().default(null),
});
export type WeiboIdeaInput = z.input<typeof weiboIdeaInput>;
export type WeiboIdea = z.output<typeof weiboIdeaInput> & {
  id: string;
  createdAt: string;
  updatedAt: string;
  aiAssisted?: boolean;
  originId?: string;
  target?: { kind: "post" | "marketing"; id: string };
};
export const weiboStyleInput = z.object({
  accountId: z.string().min(1).max(150),
  instructions: z.string().trim().min(10).max(5000),
  linkFirst: z.boolean(),
});
export interface WeiboEditorialStyle {
  instructions: string;
  linkFirst: boolean;
  custom: boolean;
}
/** Based on observed resource posts; no historical facts, URLs or credentials are copied. */
export const weiboResourceStyle =
  "保持资源目录式分享：资源名称在最前，使用方括号或书名号；年份、清晰度、语言/字幕、体积等规格仅在资料确实提供时保留，不猜测补齐。链接由应用核验后放在标题之后、简介之前。正文用一小段客观介绍内容或用途，影视可介绍剧情和主创，音乐可保留简短贴合主题的感受。不使用夸张营销口号、强行关注私信领取或虚构亲测体验。通常配真实海报或资源封面，不自动改成广告大字图。话题少量、相关，可不加。非资源内容保留简洁自然的表达，不强套资源规格结构。";

export type WeiboWorkspaceStatus =
  "idea" | "draft" | "planned" | "ready" | "attention" | "published";
export const weiboWorkspaceStatusLabels: Record<WeiboWorkspaceStatus, string> =
  {
    idea: "选题",
    draft: "草稿",
    planned: "已排期",
    ready: "待发布",
    attention: "待处理",
    published: "已提交",
  };
export interface WeiboContentRow {
  key: string;
  kind: "idea" | "post" | "marketing";
  id: string;
  title: string;
  accountId: string;
  text: string;
  status: WeiboWorkspaceStatus;
  plannedAt: string | null;
  updatedAt: string;
  url: string | null;
  latest: WeiboStatisticsSample | null;
  statisticsError?: string;
}
type Contract<A, V> = { args: A; value: V };
export interface WeiboWorkspaceContract {
  "weiboWorkspace.list": Contract<undefined, WeiboContentRow[]>;
  "weiboWorkspace.get": Contract<{ id: string }, WeiboIdea>;
  "weiboWorkspace.save": Contract<WeiboIdeaInput, WeiboIdea>;
  "weiboWorkspace.variant": Contract<
    { id: string; accountId: string; kind?: "idea" | "post" | "marketing" },
    WeiboIdea
  >;
  "weiboWorkspace.generate": Contract<{ id: string }, WeiboIdea>;
  "weiboWorkspace.deliver": Contract<
    { id: string },
    NonNullable<WeiboIdea["target"]>
  >;
  "weiboWorkspace.style": Contract<{ accountId: string }, WeiboEditorialStyle>;
  "weiboWorkspace.saveStyle": Contract<
    z.infer<typeof weiboStyleInput>,
    WeiboEditorialStyle
  >;
}

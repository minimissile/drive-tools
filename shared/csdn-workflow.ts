import { z } from "zod";
import type { Draft } from "./types";

export const csdnWorkflowInput = z.object({
  keyword: z.string().trim().min(2).max(100),
  sourceId: z.string().max(200).default("manual"),
  copyId: z.string().min(1).max(100),
  splitItemId: z.string().max(100).nullable().default(null),
  intent: z.string().trim().max(100).default("操作教程与配套资料"),
  softwareVersion: z.string().trim().max(100).default(""),
  operatingSystem: z.string().trim().max(100).default(""),
  evidence: z.string().trim().min(10).max(10000),
});
export const csdnPublicationOptions = z.object({
  bindingId: z.string().min(1).max(100),
  author: z
    .string()
    .trim()
    .regex(
      /^[a-zA-Z0-9_-]{1,100}$/,
      "请填写 CSDN 个人主页中的用户名，而非昵称",
    ),
  summary: z.string().trim().max(200).default(""),
  includeLink: z.boolean().default(false),
});
export type CsdnWorkflowInput = z.infer<typeof csdnWorkflowInput>;
export type CsdnPublicationOptions = z.infer<typeof csdnPublicationOptions>;
export type { ContentKeyword as CsdnKeyword, ContentResourceMatch as CsdnResourceMatch } from "./content-sources";
import type { ContentKeyword as CsdnKeyword, ContentResourceMatch as CsdnResourceMatch } from "./content-sources";
export type CsdnWorkflowStage =
  | "configured"
  | "generating"
  | "review"
  | "preparing"
  | "ready"
  | "submitting"
  | "submitted"
  | "published"
  | "attention"
  | "uncertain";
export const csdnStageLabels: Record<CsdnWorkflowStage, string> = {
  configured: "待生成",
  generating: "正在生成",
  review: "待审阅",
  preparing: "正在填写",
  ready: "已填写 · 待提交",
  submitting: "正在提交",
  submitted: "已提交 · 待审核",
  published: "已确认发布",
  attention: "需要处理",
  uncertain: "提交结果待核对",
};
export interface CsdnWorkflow {
  id: string;
  input: CsdnWorkflowInput;
  source: CsdnKeyword;
  topicId: string;
  draftId: string | null;
  options: CsdnPublicationOptions | null;
  stage: CsdnWorkflowStage;
  message: string;
  prepared: {
    fingerprint: string;
    pageKey: string;
    author: string;
    preparedAt: string;
  } | null;
  url: string | null;
  createdAt: string;
  updatedAt: string;
  events?: { stage: CsdnWorkflowStage; message: string; at: string }[];
}
export interface CsdnWorkflowDetail {
  run: CsdnWorkflow;
  draft: Draft | null;
  versions: Pick<Draft, "id" | "title" | "version" | "updatedAt">[];
}
export interface CsdnEditorPayload {
  pageKey: string;
  author: string;
  title: string;
  body: string;
  tags: string[];
  summary: string;
  aiAssisted: boolean;
}
export type CsdnSubmitReceipt =
  | { status: "submitted"; url: string }
  | { status: "rejected"; message: string };

export function csdnPublicationIssue(
  draft: Pick<Draft, "title" | "body" | "tags">,
): string | null {
  const length = Array.from(draft.title.trim()).length;
  if (length < 5 || length > 100)
    return "CSDN 标题须为 5–100 字，请先保存修改并重新审阅。";
  if (!draft.body.trim()) return "请先填写文章正文。";
  if (/【[^】]*(?:请填写|待补充|待核对)[^】]*】/.test(draft.body))
    return "正文仍有模板占位内容，请补充实际依据后再审阅。";
  if (/!\[[^\]]*\]\((?!https:\/\/)[^)]+\)/i.test(draft.body))
    return "正文含本地或非 HTTPS 图片，请先上传实测图片并保存图片地址。";
  if (!draft.tags.length || draft.tags.length > 5)
    return "请设置 1–5 个 CSDN 站内已有标签。";
  return null;
}

type Contract<A, V> = { args: A; value: V };
export interface CsdnWorkflowContract {
  "csdn.words": Contract<{ query: string }, CsdnKeyword[]>;
  "csdn.matches": Contract<{ keyword: string }, CsdnResourceMatch[]>;
  "csdn.history": Contract<undefined, CsdnWorkflow[]>;
  "csdn.get": Contract<{ id: string }, CsdnWorkflowDetail>;
  "csdn.create": Contract<CsdnWorkflowInput, CsdnWorkflowDetail>;
  "csdn.generate": Contract<{ id: string }, CsdnWorkflowDetail>;
  "csdn.attachDraft": Contract<
    { id: string; draftId: string },
    CsdnWorkflowDetail
  >;
  "csdn.configure": Contract<
    { id: string; options: CsdnPublicationOptions },
    CsdnWorkflowDetail
  >;
  "csdn.prepare": Contract<{ id: string }, CsdnWorkflowDetail>;
  "csdn.inspect": Contract<{ id: string }, boolean>;
  "csdn.submit": Contract<{ id: string; confirmed: true }, CsdnWorkflowDetail>;
  "csdn.resolve": Contract<
    {
      id: string;
      result: "submitted" | "published" | "not_submitted";
      url: string;
      confirmed: true;
    },
    CsdnWorkflowDetail
  >;
}

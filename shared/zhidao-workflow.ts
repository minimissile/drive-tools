import { z } from "zod";
import { generationResource } from "./zhidao-generation";
import { zhidaoAnswerIssue } from "./zhidao-content";
import { zhidaoContentIssue } from "./zhidao-publishing";
import {
  normalizeResourceKeywords,
  resourceKeywordsSchema,
} from "./resource-keywords";

export const publishingSteps = [
  "录入资源",
  "检查关键词",
  "生成并检查问答",
  "转存与独立链接",
  "预览与下载",
] as const;
export const publishingResourceLimit = 50;
export const publishingQuestionLimit = 20;
export const publishingResourceSchema = z.object({
  key: z.string().uuid(),
  resourceId: z.string().max(100).default(""),
  copyId: z.string().max(100).default(""),
  title: z.string().trim().min(1, "请填写名称").max(200),
  link: generationResource.shape.link,
  category: z.string().trim().min(1, "请选择分类").max(60),
  summary: z.string().trim().max(5000).default(""),
  image: generationResource.shape.image.optional(),
  keywords: resourceKeywordsSchema
    .min(1, "请保留至少一个关键词")
    .refine(
      (words) => normalizeResourceKeywords(words).length === words.length,
      "关键词包含无效或重复内容",
    ),
});
export type PublishingResource = z.infer<typeof publishingResourceSchema>;
export const publishingQuestionSchema = z.object({
  id: z.string().uuid().optional(),
  keyword: z.string().min(1).max(100),
  relatedKeywords: z.array(z.string().min(1).max(100)).max(99).optional(),
  question: z.string().max(500),
  answer: z.string().max(12000),
  reviewed: z.boolean(),
});
export type PublishingQuestion = z.infer<typeof publishingQuestionSchema>;
export interface PublishingGenerationDraft {
  index: number;
  question: string;
  introduction: string;
}
export interface PublishingGeneration {
  id: string;
  status: "running" | "paused" | "failed" | "completed";
  targets: number[];
  drafts: PublishingGenerationDraft[];
  message?: string;
  upgradeLegacy?: true;
  topics?: { id: string; keyword: string; relatedKeywords: string[] }[];
}
export function publishingQuestionIssue(
  row: Pick<PublishingQuestion, "question" | "answer">,
  linkedAnswerFormat = false,
) {
  const issue = zhidaoContentIssue(row);
  if (issue || !linkedAnswerFormat) return issue;
  if (row.question.trim().length < 5) return "问题标题至少需要5字。";
  const introduction = row.answer.replace(
    /<p>\s*<strong>\s*点击链接获取(?:网盘资源|网盘内容|完整素材)[:：]\s*<\/strong>\s*(?:<br\s*\/?>)?\s*<\/p>/i,
    "",
  );
  return zhidaoAnswerIssue(introduction) ? "请填写具体的资源简介。" : "";
}
export interface PublishingRecord {
  id: string;
  resource: PublishingResource;
  copyId: string;
  libraryResourceId: string;
  accountId: string;
  stage:
    | "draft"
    | "preparing"
    | "transferring"
    | "sharing"
    | "ready"
    | "failed"
    | "uncertain"
    | "paused";
  message: string;
  operations: string[];
  links: { url: string; code: string; expiresAt?: string }[];
  rows: PublishingQuestion[];
  linkedAnswerFormat?: true;
  legacyUpgraded?: true;
  canUpgradeLegacy?: true;
  generation?: PublishingGeneration;
  contentFirst?: true;
  rowShares?: Record<string, PublishingShare>;
  canonicalShare?: { url: string; version: number };
  updatedAt: string;
  transferBlocked?: boolean;
  shareCheck?: import("./types").ShareCheck;
  transferRecovery?: {
    jobId: string;
    stage: "waiting_login" | "needs_review" | "failed" | "cancelled";
  };
  shareStartedAt?: string;
  lastShareMs?: number;
  connectionMs?: number;
}
export interface PublishingShare {
  url: string;
  code: string;
  expiresAt?: string;
}
const htmlEntities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const escapePublishingHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => htmlEntities[char]);
export function publishingRowShare(
  record: PublishingRecord,
  row: PublishingQuestion,
  index: number,
) {
  return record.contentFirst
    ? row.id
      ? record.rowShares?.[row.id]
      : undefined
    : record.links[index];
}
export function publishingRowsWithLinks(
  record: PublishingRecord,
  rows = record.rows,
) {
  if (!record.contentFirst) return rows;
  return rows.map((row, index) => {
    const share = publishingRowShare(record, row, index);
    if (!share) return row;
    const url = new URL(share.url);
    if (share.code) url.searchParams.set("pwd", share.code);
    const href = escapePublishingHtml(url.href);
    return {
      ...row,
      answer: `<p><strong>点击链接获取网盘资源：</strong><br/></p><p><a href="${href}">${href}</a><br/></p>${row.answer}`,
    };
  });
}
export function publishingContentReviewed(
  record: PublishingRecord | undefined,
) {
  return (
    !!record?.contentFirst &&
    record.rows.length > 0 &&
    record.rows.length <= publishingQuestionLimit &&
    record.generation?.status === "completed" &&
    record.rows.every(
      (row) => row.reviewed && !!row.id && !publishingQuestionIssue(row, true),
    )
  );
}
export function publishingLinkIssue(records: PublishingRecord[]) {
  const used = new Set<string>();
  for (const record of records) {
    if (!record.rows.length || record.rows.length > publishingQuestionLimit)
      return "每份资源需保留1–20条问答。";
    for (const [index, row] of record.rows.entries()) {
      const share = publishingRowShare(record, row, index);
      if (!share) return "还有问答未准备独立链接，请返回第四步继续。";
      let url: URL;
      try {
        url = new URL(share.url);
      } catch {
        return "分享链接无效，请重新核对。";
      }
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        !["pan.baidu.com", "yun.baidu.com"].includes(url.hostname) ||
        !/^\/s\/[\w-]+\/?$/.test(url.pathname)
      )
        return "需为有效的百度网盘分享链接。";
      const key = url.pathname.replace(/\/$/, "");
      if (used.has(key)) return "存在重复分享URL，请为每条问答准备独立链接。";
      if (share.expiresAt && Date.parse(share.expiresAt) <= Date.now())
        return "有分享链接已过期，请核对后重新准备。";
      used.add(key);
    }
  }
  return "";
}
export const preparePublishingSchema = z.object({
  resource: publishingResourceSchema,
  accountId: z.string().max(100).default(""),
  authorized: z.literal(true),
});
export const publishingIdSchema = z.object({ id: z.string().uuid() });
export const savePublishingRowsSchema = publishingIdSchema.extend({
  rows: z.array(publishingQuestionSchema).min(1).max(100),
  generationId: z.string().uuid().optional(),
});
export interface ZhidaoWorkflowContract {
  "zhidao.workflow.planMany": {
    args: { resources: PublishingResource[] };
    value: PublishingRecord[];
  };
  "zhidao.workflow.pause": { args: { id: string }; value: boolean };
  "zhidao.workflow.resources": {
    args: { query: string };
    value: import("./types").Resource[];
  };
  "zhidao.workflow.prepare": {
    args: z.infer<typeof preparePublishingSchema>;
    value: PublishingRecord;
  };
  "zhidao.workflow.get": { args: { ids: string[] }; value: PublishingRecord[] };
  "zhidao.workflow.shares": {
    args: { id: string; authorized: true };
    value: PublishingRecord;
  };
  "zhidao.workflow.generate": {
    args: { id: string; upgradeLegacy?: true; optimize?: true };
    value: PublishingRecord;
  };
  "zhidao.workflow.generateMany": {
    args: { ids: string[] };
    value: PublishingRecord[];
  };
  "zhidao.workflow.saveRows": {
    args: z.infer<typeof savePublishingRowsSchema>;
    value: PublishingRecord;
  };
  "zhidao.workflow.export": { args: { ids: string[] }; value: string | null };
}

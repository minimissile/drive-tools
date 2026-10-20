import { z } from "zod";

export const miningCategories = [
  "小说",
  "电影",
  "电视剧",
  "综艺",
  "动漫",
  "短剧",
  "游戏",
  "软件",
] as const;
export const operationKinds = [
  "mine",
  "collect",
  "answer",
  "template",
  "publish",
] as const;
export type OperationKind = (typeof operationKinds)[number];
export type OperationStatus =
  "draft" | "running" | "paused" | "completed" | "failed";
export const operationLabels: Record<OperationKind, string> = {
  mine: "热门挖词",
  collect: "资源采集",
  answer: "智能问答",
  template: "问答模板",
  publish: "发布任务",
};
export interface ZhidaoAccount {
  id: string;
  alias: string;
  uid: string;
  nickname: string;
  status: "disconnected" | "connected" | "expired";
  bulkPermission: boolean | null;
  checkedAt: string | null;
  message: string;
}
export interface OperationRun {
  id: string;
  kind: OperationKind;
  title: string;
  status: OperationStatus;
  config: Record<string, unknown>;
  total: number;
  done: number;
  message: string;
  createdAt: string;
  updatedAt: string;
}
export type ItemStatus =
  "pending" | "ready" | "failed" | "submitted" | "uncertain" | "skipped";
export interface OperationItem {
  id: string;
  runId: string;
  key: string;
  name: string;
  link: string;
  code: string;
  sourceUrl: string;
  sourceName: string;
  question: string;
  answer: string;
  questionId: string;
  answerId: string;
  taskId: string;
  copyId: string;
  shareVersion: number;
  reviewed: boolean;
  status: ItemStatus;
  message: string;
  backups: { name: string; link: string; code: string }[];
  evidence: string;
  createdAt: string;
}
export interface OperationDetail {
  run: OperationRun;
  items: OperationItem[];
  total: number;
  page: number;
  pageSize: number;
}
export interface OperationsSummary {
  runs: OperationRun[];
  accounts: ZhidaoAccount[];
  counts: Record<OperationKind, number>;
  pending: number;
  transferPending: number;
  aiConfigured: boolean;
  pansouConfigured: boolean;
}
const text = z.string().trim();
export const miningInput = z.object({
  category: z.enum(miningCategories),
  count: z.number().int().min(1).max(500),
  live: z.boolean().default(false),
});
export const collectionInput = z
  .object({
    mode: z.enum(["precise", "fuzzy"]),
    keywords: z.array(text.min(1).max(100)).min(1).max(500),
    count: z.number().int().min(1).max(500),
    accountIds: z.array(text.min(1).max(100)).max(2),
    zhidao: z.boolean(),
    pansou: z.boolean(),
  })
  .refine((v) => v.zhidao || v.pansou, "请至少选择一个采集来源")
  .refine(
    (v) => !v.zhidao || v.accountIds.length > 0,
    "百度知道采集需要选择账号",
  );
export const answerInput = z
  .object({
    mode: z.enum(["manual", "auto"]),
    question: text.max(5000).default(""),
    style: z.enum(["清晰实用", "步骤详解", "简洁回答"]).default("清晰实用"),
    accountId: text.max(100).default(""),
    count: z.number().int().min(1).max(200).default(1),
  })
  .refine(
    (v) => (v.mode === "manual" ? !!v.question : !!v.accountId),
    "请填写问题或选择答题账号",
  );
export const templateInput = z.object({
  copyIds: z.array(text.min(1).max(100)).min(1).max(100),
  verifyFacts: z.boolean().default(false),
});
export const publishInput = z.object({
  itemIds: z.array(text.min(1).max(100)).min(1).max(100),
  accountId: text.min(1).max(100),
  taskName: text.min(1).max(100),
});
export const runStartInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mine"),
    input: miningInput,
    authorized: z.literal(true),
  }),
  z.object({
    kind: z.literal("collect"),
    input: collectionInput,
    authorized: z.literal(true),
  }),
  z.object({
    kind: z.literal("answer"),
    input: answerInput,
    authorized: z.literal(true),
  }),
  z.object({
    kind: z.literal("template"),
    input: templateInput,
    authorized: z.literal(true),
  }),
  z.object({
    kind: z.literal("publish"),
    input: publishInput,
    authorized: z.literal(true),
  }),
]);
export type RunStartInput = z.input<typeof runStartInput>;
export const operationItemEdit = z.object({
  id: text.min(1).max(100),
  name: text.min(1).max(200),
  question: text.max(5000),
  answer: text.max(25000),
  reviewed: z.boolean(),
});
export interface ZhidaoSettings {
  pansouUrl: string;
}
export interface DriveShareResult {
  urls: string[];
  failures: { id: string; name: string; message: string; uncertain: boolean }[];
}

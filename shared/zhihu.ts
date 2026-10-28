import { z } from "zod";
import {
  websiteAccountIdSchema,
  type WebsiteAccount,
} from "./website-accounts";
import type { EnvironmentStamp } from "./browser-environments";
import type { ContentImage, ContentProvenance } from "./content-sources";

export const zhihuSourceUrl =
  "https://my.feishu.cn/docx/MmEgd9neyo4rvjxe8ndcjeQgnlb#ECsVdJ3Ihoex51xdKqjcP3JBn7c";
export function zhihuQuestionId(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      ["www.zhihu.com", "zhihu.com"].includes(u.hostname) &&
      !u.username &&
      !u.password &&
      !u.port
      ? (u.pathname.match(/^\/question\/(\d+)\/?$/)?.[1] ?? null)
      : null;
  } catch {
    return null;
  }
}
export function zhihuReceiptUrl(value: string, kind?: "article" | "answer") {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.port)
      return null;
    if (
      kind !== "answer" &&
      u.hostname === "zhuanlan.zhihu.com" &&
      /^\/p\/\d+\/?$/.test(u.pathname)
    )
      return `${u.origin}${u.pathname}`;
    if (
      kind !== "article" &&
      u.hostname === "www.zhihu.com" &&
      /^\/question\/\d+\/answer\/\d+\/?$/.test(u.pathname)
    )
      return `${u.origin}${u.pathname}`;
  } catch {
    /* Invalid URLs are rejected at the boundary. */
  }
  return null;
}
export const zhihuContentInput = z
  .object({
    id: z.string().optional(),
    kind: z.enum(["article", "answer"]),
    purpose: z.enum(["warming", "regular"]),
    category: z.string().trim().max(40).default("文案句子"),
    title: z.string().trim().min(1).max(100),
    body: z.string().trim().min(10).max(50000),
    questionUrl: z.string().max(300).default(""),
    aiAssisted: z.boolean(),
  })
  .refine((v) => v.kind !== "answer" || !!zhihuQuestionId(v.questionUrl), {
    message: "请填写知乎官方问题链接。",
    path: ["questionUrl"],
  });
export type ZhihuContentInput = z.input<typeof zhihuContentInput>;
export type ZhihuImage = ContentImage;
export interface ZhihuContent extends z.output<typeof zhihuContentInput> {
  id: string;
  version: number;
  reviewed: boolean;
  images: ZhihuImage[];
  source?: ContentProvenance;
  createdAt: string;
  updatedAt: string;
}
export const zhihuPolicyInput = z.object({
  accountId: websiteAccountIdSchema,
  targetLevel: z.number().int().min(4).max(10).default(5),
  dailyLimit: z.number().int().min(1).max(10).default(3),
  weeklyLimit: z.number().int().min(1).max(70).default(15),
  gapMinutes: z.number().int().min(60).max(1440).default(60),
});
export interface ZhihuProgress {
  creator: boolean | null;
  level: number | null;
  checkedAt: string;
  source: "official" | "manual";
  note: string;
}
export interface ZhihuPlan extends z.output<typeof zhihuPolicyInput> {
  active: boolean;
  message: string;
  progress: ZhihuProgress | null;
  environment?: EnvironmentStamp;
  uid?: string;
}
export type ZhihuTaskStatus =
  "queued" | "running" | "submitting" | "published" | "attention" | "cancelled";
export interface ZhihuTask {
  id: string;
  accountId: string;
  uid: string;
  contentId: string;
  contentVersion: number;
  title: string;
  kind: "article" | "answer";
  purpose: "warming" | "regular";
  questionId: string | null;
  environment: EnvironmentStamp;
  status: ZhihuTaskStatus;
  scheduledAt: string;
  attemptedAt?: string;
  submittedAt?: string;
  url?: string;
  message: string;
  networkKey?: string;
  createdAt: string;
}
export interface ZhihuSnapshot {
  accounts: (WebsiteAccount & {
    environmentName: string;
    engine: string;
    ip: string | null;
    plan: ZhihuPlan;
    today: number;
    week: number;
  })[];
  contents: ZhihuContent[];
  tasks: ZhihuTask[];
  drafts: { id: string; title: string }[];
  running: boolean;
  busy: boolean;
}
export interface ZhihuPayload {
  task: ZhihuTask;
  content: ZhihuContent;
  images: { path: string; sha256: string }[];
}
export interface ZhihuBrowserPort {
  progress(account: WebsiteAccount): Promise<ZhihuProgress>;
  publish(
    account: WebsiteAccount,
    payload: ZhihuPayload,
    beforeSubmit: () => Promise<void>,
  ): Promise<{ url: string }>;
}
type Contract<A, V> = { args: A; value: V };
export interface ZhihuContract {
  "zhihu.snapshot": Contract<undefined, ZhihuSnapshot>;
  "zhihu.content.save": Contract<ZhihuContentInput, ZhihuContent>;
  "zhihu.content.review": Contract<
    { id: string; version: number; confirmed: true },
    ZhihuContent
  >;
  "zhihu.content.images": Contract<{ id: string }, ZhihuContent>;
  "zhihu.content.import": Contract<{ draftId: string }, ZhihuContent>;
  "zhihu.plan.save": Contract<z.input<typeof zhihuPolicyInput>, ZhihuPlan>;
  "zhihu.plan.active": Contract<
    { accountId: string; active: boolean },
    ZhihuPlan
  >;
  "zhihu.progress.check": Contract<{ accountId: string }, ZhihuProgress>;
  "zhihu.progress.record": Contract<
    { accountId: string; creator: boolean; level: number; note: string },
    ZhihuProgress
  >;
  "zhihu.enqueue": Contract<
    {
      accountId: string;
      contentId: string;
      scheduledAt: string;
      confirmed: true;
    },
    ZhihuTask
  >;
  "zhihu.scheduler": Contract<{ running: boolean; confirmed: true }, boolean>;
  "zhihu.task.cancel": Contract<{ id: string }, ZhihuTask>;
  "zhihu.task.resolve": Contract<
    {
      id: string;
      outcome: "published" | "not_published";
      url?: string;
      confirmed: true;
    },
    ZhihuTask
  >;
}

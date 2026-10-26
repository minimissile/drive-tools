import { z } from "zod";
import type { Draft } from "./types";
import type { ContentKeyword, ContentResourceMatch } from "./content-sources";

export const weiboMarketingInput = z.object({
  keyword: z.string().trim().min(2).max(100),
  sourceId: z.string().max(200).default("manual"),
  copyId: z.string().min(1).max(100),
  audience: z.string().trim().max(100).default(""),
  evidence: z.string().trim().min(10).max(5000),
});
export const weiboDeliveryOptions = z.object({
  accountId: z.string().max(100).default(""),
  bindingId: z.string().max(100),
  uid: z
    .string()
    .trim()
    .regex(/^\d{5,20}$/, "请填写微博个人主页中的数字 UID"),
  includeLink: z.boolean().default(false),
  artwork: z.enum(["cover", "creative"]).default("cover"),
  visibility: z.enum(["public", "self"]).default("public"),
});
export type WeiboMarketingInput = z.infer<typeof weiboMarketingInput>;
export type WeiboDeliveryOptions = z.infer<typeof weiboDeliveryOptions>;
export type WeiboStage =
  | "review"
  | "generating"
  | "preparing"
  | "ready"
  | "filled"
  | "submitting"
  | "uncertain"
  | "handoff"
  | "submitted"
  | "published"
  | "attention";
export const weiboStageLabels: Record<WeiboStage, string> = {
  review: "编辑与审阅",
  generating: "正在生成方案",
  preparing: "正在核验图文",
  ready: "图文包已就绪",
  filled: "图文已上传 · 待发布",
  submitting: "正在提交微博",
  uncertain: "提交结果待核对",
  handoff: "已交接 · 待回填",
  submitted: "已提交 · 待核对",
  published: "已确认公开",
  attention: "需要处理",
};
export interface WeiboPrepared {
  environment?: import("./browser-environments").EnvironmentStamp;
  accountId?: string;
  fingerprint: string;
  text: string;
  folder: string;
  images: string[];
  checksums: Record<string, string>;
  preparedAt: string;
  draftId: string;
  bindingId: string;
  uid: string;
}
export interface WeiboMarketingRun {
  id: string;
  input: WeiboMarketingInput;
  source: ContentKeyword;
  topicId: string;
  draftId: string;
  options: WeiboDeliveryOptions | null;
  stage: WeiboStage;
  message: string;
  prepared: WeiboPrepared | null;
  url: string | null;
  receiptSyncPending: boolean;
  createdAt: string;
  updatedAt: string;
  events: { stage: WeiboStage; message: string; at: string }[];
}
export interface WeiboMarketingDetail {
  run: WeiboMarketingRun;
  draft: Draft;
  resourceTitle: string;
  hasCover: boolean;
  coverId: string | null;
  versions: Pick<Draft, "id" | "title" | "version">[];
}

/** Weibo has one text field: the saved title, body and normalized topic tags are delivered together. */
export function weiboPostText(
  draft: Pick<Draft, "title" | "body" | "tags">,
  body = draft.body,
) {
  const topics = [
    ...new Set(draft.tags.map((tag) => tag.trim().replace(/^#+|#+$/g, ""))),
  ];
  const text = [draft.title.trim(), body.trim()].filter(Boolean).join("\n\n");
  return [
    text,
    topics
      .filter((tag) => tag && !text.includes(`#${tag}#`))
      .map((tag) => `#${tag}#`)
      .join(" "),
  ]
    .filter(Boolean)
    .join("\n\n");
}
export function weiboContentIssue(
  draft: Pick<Draft, "title" | "body" | "tags">,
  text = weiboPostText(draft),
) {
  if (!draft.title.trim() || !draft.body.trim())
    return "请补充标题和正文后保存。";
  if (/【[^】]*(?:请填写|待补充|待核对)[^】]*】/.test(text))
    return "正文仍有占位内容，请补充资源事实后再审阅。";
  if (Array.from(text).length > 2000)
    return "完整微博文案超过工作台的 2000 字符上限，请精简正文或话题；不自动截断。";
  if (
    draft.tags.length > 3 ||
    draft.tags.some(
      (tag) => !/^[^#\s<>:/@?]{1,30}$/.test(tag.replace(/^#+|#+$/g, "")),
    )
  )
    return "请使用最多 3 个相关话题，每个话题 1–30 字，不含空格。";
  return null;
}
/** A desktop permalink includes the author UID; a homepage or mobile status URL cannot prove authorship. */
export function weiboReceiptUrl(text: string, uid: string): string {
  const url = new URL(text);
  if (
    url.protocol !== "https:" ||
    !["weibo.com", "www.weibo.com"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    !new RegExp(`^/${uid}/[a-zA-Z0-9]{5,32}/?$`).test(url.pathname)
  )
    throw new Error(
      "请填写该账号的单条微博桌面链接：https://weibo.com/数字UID/微博ID，不接受主页或其他账号地址。",
    );
  return `https://weibo.com${url.pathname.replace(/\/$/, "")}`;
}

type Contract<A, V> = { args: A; value: V };
export interface WeiboMarketingContract {
  "weibo.words": Contract<{ query: string }, ContentKeyword[]>;
  "weibo.matches": Contract<{ keyword: string }, ContentResourceMatch[]>;
  "weibo.history": Contract<undefined, WeiboMarketingRun[]>;
  "weibo.get": Contract<{ id: string }, WeiboMarketingDetail>;
  "weibo.create": Contract<WeiboMarketingInput, WeiboMarketingDetail>;
  "weibo.generate": Contract<
    { id: string; artwork: "cover" | "creative" },
    WeiboMarketingDetail
  >;
  "weibo.attachDraft": Contract<
    { id: string; draftId: string },
    WeiboMarketingDetail
  >;
  "weibo.configure": Contract<
    { id: string; options: WeiboDeliveryOptions },
    WeiboMarketingDetail
  >;
  "weibo.prepare": Contract<{ id: string }, WeiboMarketingDetail>;
  "weibo.handoff": Contract<{ id: string }, WeiboMarketingDetail>;
  "weibo.fill": Contract<{ id: string }, WeiboMarketingDetail>;
  "weibo.submit": Contract<
    { id: string; confirmed: true },
    WeiboMarketingDetail
  >;
  "weibo.openFolder": Contract<{ id: string }, boolean>;
  "weibo.openReceipt": Contract<{ id: string }, boolean>;
  "weibo.resolve": Contract<
    {
      id: string;
      result: "submitted" | "published" | "not_submitted";
      url: string;
      confirmed: true;
    },
    WeiboMarketingDetail
  >;
}

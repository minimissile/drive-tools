import { z } from "zod";
import type { Provider } from "./types";

export const smzdmEditorUrl = "https://post.smzdm.com/tougao/";
export const smzdmHosts = [
  "www.smzdm.com",
  "smzdm.com",
  "post.smzdm.com",
  "zhiyou.smzdm.com",
];
export const wechatArticleUrl = z
  .string()
  .trim()
  .max(4000)
  .refine((text) => {
    try {
      const u = new URL(text);
      return (
        u.protocol === "https:" &&
        u.hostname === "mp.weixin.qq.com" &&
        !u.port &&
        !u.username &&
        !u.password &&
        /^\/s(?:\/[^/]+)?$/.test(u.pathname)
      );
    } catch {
      return false;
    }
  }, "请填写 mp.weixin.qq.com 的 HTTPS 公众号文章链接。");
export const smzdmTextInput = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(200000),
});
export const smzdmSourceSchema = smzdmTextInput.extend({
  url: wechatArticleUrl,
  author: z.string().max(200),
  publishedAt: z.string().max(100),
  imageCount: z.number().int().min(0).max(500),
  warnings: z.array(z.string().max(500)).max(30),
});
export type SmzdmSource = z.infer<typeof smzdmSourceSchema>;
export type SmzdmStage =
  "editing" | "publishing" | "submitted" | "published" | "uncertain";
export interface SmzdmResourceLink {
  id: string;
  url: string;
  sourceText: string;
  code: string;
  provider: Provider;
  copyId: string | null;
  resourceId: string | null;
  ownUrl: string | null;
}
export interface SmzdmArticle {
  id: string;
  source: SmzdmSource;
  title: string;
  body: string;
  links: SmzdmResourceLink[];
  revision: number;
  reviewedRevision: number | null;
  aiAssisted?: boolean;
  editorDraft?: {
    url: string;
    accountId: string;
    uid: string;
    environmentStamp: string;
  };
  stage: SmzdmStage;
  message: string;
  receiptUrl: string | null;
  accountUid: string | null;
  accountId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface SmzdmIssue {
  severity: "error" | "warning";
  text: string;
}
export interface SmzdmDetail {
  article: SmzdmArticle;
  issues: SmzdmIssue[];
  resources: {
    linkId: string;
    copyId: string | null;
    title: string;
    status: string;
    message: string;
    candidates: { copyId: string; title: string; account: string }[];
  }[];
}
export type SmzdmSummary = Pick<
  SmzdmArticle,
  "id" | "title" | "stage" | "updatedAt"
>;
export interface SmzdmPayload {
  key: string;
  uid: string;
  title: string;
  html: string;
  text: string;
  aiAssisted: boolean;
  draftUrl?: string;
}
export interface SmzdmReceipt {
  url: string | null;
  status: "submitted" | "published";
}
export interface SmzdmResultQuery {
  uid: string;
  title: string;
  draftUrl: string;
}
export interface SmzdmPort {
  open(account: import("./website-accounts").WebsiteAccount): Promise<void>;
  readArticle(url: string): Promise<SmzdmSource>;
  checkResult(
    account: import("./website-accounts").WebsiteAccount,
    query: SmzdmResultQuery,
  ): Promise<SmzdmReceipt | null>;
  prepare(
    account: import("./website-accounts").WebsiteAccount,
    payload: SmzdmPayload,
    onDraftOpened: (url: string) => Promise<void>,
  ): Promise<{ ready: boolean; message: string }>;
  submit(
    account: import("./website-accounts").WebsiteAccount,
    payload: SmzdmPayload,
    beforeSubmit: () => Promise<void>,
    onDraftOpened: (url: string) => Promise<void>,
  ): Promise<SmzdmReceipt>;
}
type Contract<A, V> = { args: A; value: V };
export interface SmzdmContract {
  "smzdm.openEditor": Contract<undefined, boolean>;
  "smzdm.list": Contract<undefined, SmzdmSummary[]>;
  "smzdm.get": Contract<{ id: string }, SmzdmDetail>;
  "smzdm.import": Contract<{ url: string }, SmzdmDetail>;
  "smzdm.save": Contract<
    { id: string; revision: number; title: string; body: string },
    SmzdmDetail
  >;
  "smzdm.resource": Contract<
    { id: string; linkId: string; accountId: string },
    { resourceId: string; copyId: string }
  >;
  "smzdm.bindResource": Contract<
    { id: string; linkId: string; copyId: string },
    SmzdmDetail
  >;
  "smzdm.syncLinks": Contract<{ id: string }, SmzdmDetail>;
  "smzdm.format": Contract<{ id: string }, SmzdmDetail>;
  "smzdm.polish": Contract<{ id: string }, SmzdmDetail>;
  "smzdm.review": Contract<
    { id: string; revision: number; confirmed: true },
    SmzdmDetail
  >;
  "smzdm.prepare": Contract<{ id: string }, SmzdmDetail>;
  "smzdm.checkResult": Contract<{ id: string }, SmzdmDetail>;
  "smzdm.publish": Contract<
    { id: string; revision: number; confirmed: true },
    SmzdmDetail
  >;
  "smzdm.resolve": Contract<
    {
      id: string;
      result: "not_submitted" | "submitted" | "published";
      url?: string;
      confirmed: true;
    },
    SmzdmDetail
  >;
}

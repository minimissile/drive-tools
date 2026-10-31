import { z } from "zod";

export const websiteProviderSchema = z.enum([
  "baidu-marketing",
  "tieba",
  "weibo",
  "zhihu",
  "smzdm",
  "feishu",
  "tencent-docs",
  "shimo",
]);
export type WebsiteProvider = z.infer<typeof websiteProviderSchema>;
export const websiteProviderSpecs: Record<
  WebsiteProvider,
  { name: string; description: string }
> = {
  tieba: {
    name: "百度贴吧",
    description: "贴吧官方登录、账号身份与浏览器会话",
  },
  feishu: { name: "飞书", description: "资源清单文档与网页登录会话" },
  "tencent-docs": {
    name: "腾讯文档",
    description: "资源清单表格与网页登录会话",
  },
  shimo: { name: "石墨文档", description: "资源清单文档与网页登录会话" },
  smzdm: { name: "什么值得买", description: "公众号文章整理与单账号发布" },
  zhihu: { name: "知乎", description: "比特多账号养号与文章、回答发布" },
  weibo: { name: "微博", description: "资源推荐图文与微博发布" },
  "baidu-marketing": {
    name: "百度营销",
    description: "关键词规划师与百度搜索需求",
  },
};
export const websiteAccountIdSchema = z.string().regex(/^web_[\w-]{1,80}$/);
export interface WebsiteAccount {
  environmentId?: string;
  id: string;
  provider: WebsiteProvider;
  alias: string;
  uid: string | null;
  nickname?: string | null;
  checkedAt?: string | null;
  status: "disconnected" | "connected" | "expired";
  createdAt: string;
  updatedAt: string;
}
export interface WebsiteSessionState {
  /** A local browser session was observed; no external account UID was verified. */
  sessionOnly?: boolean;
  hasSession: boolean;
  uid: string | null;
  windowOpen: boolean;
  error: string | null;
  nickname?: string | null;
  checkedAt?: string | null;
  expired?: boolean;
  checking?: boolean;
}
export interface WebsiteAccountView extends WebsiteAccount {
  sessionOnly?: boolean;
  windowOpen: boolean;
  message: string;
  checking?: boolean;
  publishing?: {
    bindingId: string;
    verifiedAt: string | null;
    allowLink: boolean;
    ruleNote: string;
  } | null;
}
export const weiboPublishingSchema = z.object({
  id: websiteAccountIdSchema,
  allowLink: z.boolean(),
  ruleNote: z
    .string()
    .trim()
    .min(10, "请填写至少 10 字的账号能力核实依据")
    .max(2000),
  confirmed: z.literal(true),
});
type Contract<Args, Value> = { args: Args; value: Value };
export interface WebsiteAccountContract {
  "websiteAccounts.list": Contract<undefined, WebsiteAccountView[]>;
  "websiteAccounts.add": Contract<
    { provider: WebsiteProvider; alias?: string; environmentId?: string },
    WebsiteAccount
  >;
  "websiteAccounts.rename": Contract<
    { id: string; alias: string },
    WebsiteAccount
  >;
  "websiteAccounts.login": Contract<{ id: string }, boolean>;
  "websiteAccounts.check": Contract<{ id: string }, WebsiteAccountView>;
  "websiteAccounts.openDocument": Contract<
    { id: string; url: string },
    { opened: boolean; url: string }
  >;
  "websiteAccounts.weiboPublishing": Contract<
    z.infer<typeof weiboPublishingSchema>,
    WebsiteAccountView
  >;
  "websiteAccounts.remove": Contract<{ id: string; confirmed: true }, boolean>;
}

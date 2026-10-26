import { z } from "zod";

export const websiteProviderSchema = z.enum(["baidu-marketing", "weibo"]);
export type WebsiteProvider = z.infer<typeof websiteProviderSchema>;
export const websiteProviderSpecs: Record<
  WebsiteProvider,
  { name: string; description: string }
> = {
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
  "websiteAccounts.weiboPublishing": Contract<
    z.infer<typeof weiboPublishingSchema>,
    WebsiteAccountView
  >;
  "websiteAccounts.remove": Contract<{ id: string; confirmed: true }, boolean>;
}

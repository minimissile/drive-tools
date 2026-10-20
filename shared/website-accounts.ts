import { z } from "zod";

export const websiteProviderSchema = z.enum(["baidu-marketing"]);
export type WebsiteProvider = z.infer<typeof websiteProviderSchema>;
export const websiteProviderSpecs: Record<
  WebsiteProvider,
  { name: string; description: string }
> = {
  "baidu-marketing": {
    name: "百度营销",
    description: "关键词规划师与百度搜索需求",
  },
};
export const websiteAccountIdSchema = z.string().regex(/^web_[\w-]{1,80}$/);
export interface WebsiteAccount {
  id: string;
  provider: WebsiteProvider;
  alias: string;
  uid: string | null;
  status: "disconnected" | "connected" | "expired";
  createdAt: string;
  updatedAt: string;
}
export interface WebsiteSessionState {
  hasSession: boolean;
  uid: string | null;
  windowOpen: boolean;
  error: string | null;
}
export interface WebsiteAccountView extends WebsiteAccount {
  windowOpen: boolean;
  message: string;
}
type Contract<Args, Value> = { args: Args; value: Value };
export interface WebsiteAccountContract {
  "websiteAccounts.list": Contract<undefined, WebsiteAccountView[]>;
  "websiteAccounts.add": Contract<
    { provider: WebsiteProvider; alias?: string },
    WebsiteAccount
  >;
  "websiteAccounts.rename": Contract<
    { id: string; alias: string },
    WebsiteAccount
  >;
  "websiteAccounts.login": Contract<{ id: string }, boolean>;
  "websiteAccounts.check": Contract<{ id: string }, WebsiteAccountView>;
  "websiteAccounts.remove": Contract<{ id: string; confirmed: true }, boolean>;
}

import { useIpcQuery } from "../api/useIpcQuery";
import { ipc } from "../api/client";
import { isDocumentProvider } from "../../shared/document-platforms";
import {
  websiteProviderSpecs,
  type WebsiteProvider,
  type WebsiteAccountView,
} from "../../shared/website-accounts";

export type OtherProvider = WebsiteProvider | "baidu-zhidao";
export const defaultOtherAccountBrowser = (provider: OtherProvider) => ({
  fingerprint:
    provider !== "baidu-marketing" &&
    provider !== "smzdm" &&
    !isDocumentProvider(provider),
  environmentId: "",
});
export interface OtherAccount {
  sessionOnly?: boolean;
  environmentId?: string;
  id: string;
  key: string;
  provider: OtherProvider;
  alias: string;
  uid: string | null;
  nickname?: string | null;
  checkedAt?: string | null;
  checking?: boolean;
  publishing?: WebsiteAccountView["publishing"];
  status: "connected" | "disconnected" | "expired";
  windowOpen: boolean;
  message: string;
  detail?: string;
  bulkPermission?: boolean | null;
}
export const otherProviderItems = [
  { value: "baidu-zhidao", label: "百度知道" },
  ...Object.entries(websiteProviderSpecs).map(([value, spec]) => ({
    value,
    label: spec.name,
  })),
];
export const otherProviderName = (provider: OtherProvider) =>
  otherProviderItems.find((item) => item.value === provider)!.label;

export function useOtherAccounts() {
  const environments = useIpcQuery("environments.list", undefined, {
    keepPrevious: true,
    refreshInterval: 2500,
  });
  const websites = useIpcQuery("websiteAccounts.list", undefined, {
    keepPrevious: true,
    refreshInterval: 2500,
  });
  const zhidao = useIpcQuery("zhidao.accounts", undefined, {
    keepPrevious: true,
  });
  const reload = () => {
    websites.reload();
    zhidao.reload();
    environments.reload();
  };
  const data: OtherAccount[] = [
    ...(zhidao.data ?? []).map((account): OtherAccount => ({
      ...account,
      environmentId: environments.data?.find((env) =>
        env.accounts.some(
          (ref) => ref.kind === "zhidao" && ref.id === account.id,
        ),
      )?.id,
      provider: "baidu-zhidao",
      key: `zhidao:${account.id}`,
      windowOpen: false,
      detail: `${account.nickname || "尚未识别账号身份"} · ${account.bulkPermission === null ? "快捷答题资格待检查" : account.bulkPermission ? "具有快捷答题资格" : "暂无快捷答题资格"}`,
    })),
    ...(websites.data ?? []).map((account) => ({
      ...account,
      key: `website:${account.id}`,
    })),
  ];
  const errors = [
    zhidao.error && `百度知道：${zhidao.error}`,
    websites.error && `网站账号：${websites.error}`,
    environments.error && `浏览器环境：${environments.error}`,
  ]
    .filter(Boolean)
    .join("；");
  return {
    data,
    error: errors,
    loading: websites.loading || zhidao.loading || environments.loading,
    environmentsReady: !!environments.data && !environments.error,
    ready: !!websites.data && !!zhidao.data && !!environments.data,
    reload,
    environments: environments.data ?? [],
  };
}

export const otherAccountActions = {
  async add(
    provider: OtherProvider,
    alias: string,
    cookie: string,
    environmentId?: string,
  ) {
    const account =
      provider === "baidu-zhidao"
        ? await ipc("zhidao.account.add", {
            alias: alias.trim() || "百度知道账号",
            cookie: cookie || undefined,
            environmentId,
          })
        : await ipc("websiteAccounts.add", {
            provider,
            alias: alias.trim() || undefined,
            environmentId,
          });
    return {
      ...account,
      provider,
      key: `${provider === "baidu-zhidao" ? "zhidao" : "website"}:${account.id}`,
    };
  },
  login(account: Pick<OtherAccount, "id" | "provider">) {
    return account.provider === "baidu-zhidao"
      ? ipc("zhidao.account.login", { id: account.id })
      : ipc("websiteAccounts.login", { id: account.id });
  },
  check(account: Pick<OtherAccount, "id" | "provider">) {
    return account.provider === "baidu-zhidao"
      ? ipc("zhidao.account.check", { id: account.id })
      : ipc("websiteAccounts.check", { id: account.id });
  },
  rename(account: OtherAccount, alias: string) {
    return account.provider === "baidu-zhidao"
      ? ipc("zhidao.account.update", { id: account.id, alias })
      : ipc("websiteAccounts.rename", { id: account.id, alias });
  },
  remove(account: OtherAccount) {
    return account.provider === "baidu-zhidao"
      ? ipc("zhidao.account.remove", { id: account.id, confirmed: true })
      : ipc("websiteAccounts.remove", { id: account.id, confirmed: true });
  },
};

import type { WebsiteAccount } from "../shared/website-accounts";
import {
  bilibiliIdentityScript,
  bilibiliSessionObservation,
} from "../core/bilibili/identity";
import {
  createWebsiteIdentitySession,
  type WebsiteIdentityContext,
} from "./website-identity-session";

export function createBilibiliIdentitySession(
  context: (account: WebsiteAccount) => WebsiteIdentityContext,
) {
  const identity = createWebsiteIdentitySession(context, {
    provider: "bilibili",
    label: "哔哩哔哩",
    home: "https://api.bilibili.com/x/web-interface/nav",
    cookieNames: /^(?:SESSDATA|DedeUserID|DedeUserID__ckMd5|bili_jct)$/,
    cookieDomain: /(^|\.)bilibili\.com$/,
    script: bilibiliIdentityScript(),
  });
  return {
    status: (account: WebsiteAccount) =>
      bilibiliSessionObservation(identity.status(account)),
    verify: async (account: WebsiteAccount) =>
      bilibiliSessionObservation(await identity.verify(account)),
    invalidate: identity.invalidate,
  };
}

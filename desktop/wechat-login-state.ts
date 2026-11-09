import type {
  WebsiteAccount,
  WebsiteSessionState,
} from "../shared/website-accounts";

/** Rotating a cookie invalidates identity evidence, not the persisted login. */
export function staleWechatIdentity(
  previous?: WebsiteSessionState,
): WebsiteSessionState {
  return {
    hasSession: false,
    uid: null,
    nickname: previous?.nickname,
    checkedAt: previous?.checkedAt,
    windowOpen: false,
    unverified: true,
    error: "已保存公众号登录会话，使用时会自动核验。",
  };
}

export function initialWechatIdentity(
  account: WebsiteAccount,
): WebsiteSessionState {
  if (account.uid && account.status !== "expired") return staleWechatIdentity();
  return {
    hasSession: false,
    uid: null,
    windowOpen: false,
    expired: account.status === "expired",
    error: "请扫码登录微信公众号。",
  };
}

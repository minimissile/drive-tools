import type { Account, ResourceCopy, ShareCheck } from "./types";

/** A saved verification is usable only for the same enabled account and files. */
export function hasVerifiedShare(copy: ResourceCopy, account?: Account) {
  return !!(
    account?.enabled &&
    account.uid &&
    copy.status === "ready" &&
    copy.verifiedAt &&
    copy.files.length &&
    copy.shareVerifiedAt &&
    copy.shareId &&
    copy.shareUrl &&
    copy.ownerUid === account.uid &&
    copy.shareOwnerUid === account.uid
  );
}

export interface CopyShareStatus {
  state: "valid" | "invalid" | "unavailable" | "unchecked" | "not_ready";
  label: string;
  kind: "good" | "warning" | "normal";
  canCheck: boolean;
  canCopy: boolean;
  canCreate: boolean;
}

/** Display share health separately from the resource's archival status. */
export function copyShareStatus(
  copy: ResourceCopy,
  account?: Account,
  check?: ShareCheck,
): CopyShareStatus {
  const accountReady = !!(account?.enabled && account.uid);
  const canCheck = accountReady && ["ready", "recorded"].includes(copy.status);
  const actions = {
    canCheck,
    canCopy: canCheck && !!copy.shareUrl,
    canCreate: !!(
      accountReady &&
      copy.verifiedAt &&
      copy.files.length &&
      copy.ownerUid === account?.uid
    ),
  };
  if (!accountReady)
    return {
      ...actions,
      state: "unavailable",
      label: "账号待连接",
      kind: "warning",
    };
  if (account?.status !== "connected")
    return {
      ...actions,
      state: "unavailable",
      label: "账号待登录",
      kind: "warning",
    };
  const currentCheck =
    check &&
    (!copy.shareVerifiedAt ||
      Date.parse(check.checkedAt) >= Date.parse(copy.shareVerifiedAt));
  if (currentCheck && check.status !== "valid")
    return {
      ...actions,
      state: check.status,
      label:
        check.status === "invalid" ? "分享已失效或不匹配" : "分享检查未完成",
      kind: "warning",
    };
  if (hasVerifiedShare(copy, account))
    return { ...actions, state: "valid", label: "分享可用", kind: "good" };
  if (canCheck)
    return {
      ...actions,
      state: "unchecked",
      label: "分享待检查",
      kind: "warning",
    };
  return {
    ...actions,
    state: "not_ready",
    label: "等待归档",
    kind: "normal",
  };
}

import type { WebsiteAccount } from "../../shared/website-accounts";

type AccountName = Pick<WebsiteAccount, "nickname" | "alias">;

export function tiebaAccountName(
  account: AccountName | undefined,
  fallback = "贴吧账号",
) {
  return account?.nickname?.trim() || account?.alias.trim() || fallback;
}

/** Keep a distinct remark alongside the platform nickname for account selection. */
export function tiebaAccountLabel(account: AccountName) {
  const name = tiebaAccountName(account),
    alias = account.alias.trim();
  return alias && alias !== name ? `${name} · ${alias}` : name;
}

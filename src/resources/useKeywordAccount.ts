import { useState } from "react";
import { useIpcQuery } from "../api/useIpcQuery";

export function useKeywordAccount() {
  const [accountId, setAccountId] = useState("");
  const accounts = useIpcQuery(
    "websiteAccounts.list",
    { provider: "baidu-marketing" },
    { keepPrevious: true },
  );
  const choices = (accounts.data ?? []).filter(
    (item) => item.provider === "baidu-marketing",
  );
  const account =
    choices.find((item) => item.id === accountId) ??
    choices.find((item) => item.status === "connected" && !item.unverified) ??
    choices[0];
  return {
    accounts,
    choices,
    account,
    setAccountId,
    accountAvailable: account?.status === "connected" && !account.unverified,
    checkingAccount: accounts.loading && !accounts.data,
  };
}

import type { Account, Provider, ShareInput } from "../../shared/types";
export function chooseIntakeAccount(
  accounts: Account[],
  active: Record<string, string>,
  provider: Provider,
) {
  return (
    accounts.find(
      (a) => a.id === active[provider] && a.provider === provider && a.enabled,
    )?.id ??
    accounts.find((a) => a.provider === provider && a.enabled && a.isDefault)
      ?.id ??
    accounts.find((a) => a.provider === provider && a.enabled)?.id ??
    ""
  );
}
export function intakeDestination(
  share: ShareInput,
  input: { provider: Provider; accountId: string; directory: string },
  accounts: Account[],
  active: Record<string, string>,
) {
  const keep =
    share.provider === input.provider &&
    accounts.some(
      (a) => a.id === input.accountId && a.provider === share.provider,
    );
  const accountId = keep
    ? input.accountId
    : chooseIntakeAccount(accounts, active, share.provider);
  return {
    provider: share.provider,
    accountId,
    directory: keep
      ? input.directory
      : (accounts.find((a) => a.id === accountId)?.defaultDirectory ??
        "/盘序资源"),
  };
}

import type { Account, Provider, ShareInput } from "../../shared/types";
export function chooseIntakeAccount(
  accounts: Account[],
  active: Record<string, string>,
  provider: Provider,
) {
  const enabled = accounts.filter((a) => a.provider === provider && a.enabled);
  const connected = enabled.filter((a) => a.status === "connected");
  return (
    connected.find((a) => a.id === active[provider])?.id ??
    connected.find((a) => a.isDefault)?.id ??
    connected[0]?.id ??
    enabled.find((a) => a.id === active[provider])?.id ??
    enabled.find((a) => a.isDefault)?.id ??
    enabled[0]?.id ??
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
      (a) =>
        a.id === input.accountId && a.provider === share.provider && a.enabled,
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

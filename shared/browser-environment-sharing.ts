import type { BrowserEnvironmentView } from "./browser-environments";

type Member = { kind: string; platform: string };
export const isBaiduSharedMember = (member: Member) =>
  (member.kind === "drive" && member.platform === "drive-baidu") ||
  (member.kind === "zhidao" && member.platform === "baidu-zhidao") ||
  (member.kind === "website" && member.platform === "tieba");

/** Drive background mode can be shared only by the three Baidu account workflows. */
export function environmentAllowsAccount(
  environment: Pick<BrowserEnvironmentView, "engine" | "accounts">,
  member: Member,
) {
  if (
    member.kind !== "drive" &&
    !environment.accounts.some((a) => a.kind === "drive")
  )
    return true;
  if (!environment.accounts.length) return true;
  return (
    environment.engine === "bitbrowser" &&
    isBaiduSharedMember(member) &&
    environment.accounts.every(isBaiduSharedMember)
  );
}

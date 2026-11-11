import type { BrowserEnvironmentView } from "./browser-environments";

type Member = { kind: string; platform: string };
export const isDriveSharedMember = (member: Member) =>
  (member.kind === "drive" && member.platform === "drive-baidu") ||
  (member.kind === "zhidao" && member.platform === "baidu-zhidao") ||
  (member.kind === "website" && ["tieba", "wechat"].includes(member.platform));

/** Drive background mode can be shared by Baidu workflows and WeChat, with separate identity realms. */
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
    isDriveSharedMember(member) &&
    environment.accounts.every(isDriveSharedMember)
  );
}

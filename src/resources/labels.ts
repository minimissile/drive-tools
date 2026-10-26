import { providerSpecs } from "../../shared/providers";
import type { Account } from "../../shared/types";
export const providerName = (provider: string) =>
  providerSpecs[provider as keyof typeof providerSpecs]?.name ?? "未知网盘";
export function stageName(value: string) {
  return (
    (
      {
        draft: "草稿",
        recorded: "自有资源已入库",
        ready: "已归档",
        queued: "等待执行",
        preflight: "预检中",
        transferring: "转存中",
        verifying: "核验文件",
        sharing: "创建本人分享",
        archiving: "本地归档",
        completed: "已完成",
        waiting_login: "等待原账号登录",
        needs_review: "需要核对远端结果",
        failed: "需要处理",
        cancelled: "已停止本地等待",
      } as Record<string, string>
    )[value] ?? value
  );
}
export function accountLabel(accounts: Account[], id: string) {
  return accounts.find((a) => a.id === id)?.alias ?? "历史账号";
}

import { useState } from "react";
import type { Account } from "../../shared/types";
import { useAppActions } from "../state";
export type AccountOperation = "login" | "verify" | "capacity";

/** Explicit account operations only: never log in or query remote capacity on mount. */
export function useAccountOperations() {
  const { command, notify } = useAppActions();
  const [pending, setPending] = useState<{
    id: string;
    action: AccountOperation;
  } | null>(null);
  const run = async (account: Account, action: AccountOperation) => {
    setPending({ id: account.id, action });
    try {
      if (action === "login")
        await command(
          "account.login",
          { id: account.id },
          {
            text: account.browser
              ? "关联的比特登录窗口已打开。完成登录后，请关闭此比特环境，再核验后台登录。"
              : "官方登录窗口已打开。完成登录后，请返回核验本人UID。",
            tone: "info",
          },
        );
      else if (action === "verify")
        await command(
          "account.check",
          { id: account.id },
          "登录已核验；容量和会员信息读取结果见账号列表，原账号任务可继续执行。",
        );
      else {
        const result = await command("account.capacity", { id: account.id });
        if (result) {
          const legacy = result.membership === undefined;
          notify(
            legacy
              ? "容量已刷新；会员信息需要应用更新并重启后读取。"
              : result.capacity?.error || result.membership?.error
                ? "部分账号信息暂未更新，具体原因及上次数据已保留在列表。"
                : "网盘容量和会员信息已更新。",
            legacy || result.capacity?.error || result.membership?.error
              ? "warning"
              : "success",
          );
        }
      }
    } finally {
      setPending(null);
    }
  };
  return { pending, run };
}

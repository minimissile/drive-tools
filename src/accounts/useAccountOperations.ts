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
            text: "官方登录窗口已打开。完成登录后，请返回核验本人UID。",
            tone: "info",
          },
        );
      else if (action === "verify")
        await command(
          "account.check",
          { id: account.id },
          "登录已核验；容量读取结果见账号卡片，原账号任务可继续执行。",
        );
      else {
        const result = await command("account.capacity", { id: account.id });
        if (result)
          notify(
            result.capacity?.error
              ? "容量暂未更新，具体原因及上次数据已保留在账号卡片。"
              : "网盘容量已更新。",
            result.capacity?.error ? "warning" : "success",
          );
      }
    } finally {
      setPending(null);
    }
  };
  return { pending, run };
}

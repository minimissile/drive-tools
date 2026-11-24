import { useEffect, useRef, useState } from "react";
import type { WebsiteAccountView } from "../../shared/website-accounts";
import { ipc } from "../api/client";
import { useAppActions } from "../state";
import { Button, Notice, Status } from "../ui/primitives";
import { localServiceError } from "./labels";

type Check = {
  id: string;
  selection: number;
  pending: boolean;
  error: string;
};

/** Login remains in the official browser; verification is an explicit user action. */
export function AccountStatus({
  account,
  disabled = false,
  onVerified,
}: {
  account: WebsiteAccountView | undefined;
  disabled?: boolean;
  onVerified(next: WebsiteAccountView): void;
}) {
  const { notify } = useAppActions();
  const [check, setCheck] = useState<Check | null>(null);
  const active = useRef<Check | null>(null);
  const alive = useRef(true);
  const selected = useRef({ id: account?.id, revision: 0 });
  const update = useRef(onVerified);
  update.current = onVerified;
  if (selected.current.id !== account?.id)
    selected.current = {
      id: account?.id,
      revision: selected.current.revision + 1,
    };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const ownCheck =
    check?.id === account?.id && check?.selection === selected.current.revision
      ? check
      : null;
  const busy = check?.pending === true || account?.checking === true;
  const verify = async () => {
    if (!account || disabled || active.current || account.checking) return;
    const request: Check = {
      id: account.id,
      selection: selected.current.revision,
      pending: true,
      error: "",
    };
    const current = () =>
      alive.current &&
      selected.current.id === request.id &&
      selected.current.revision === request.selection;
    active.current = request;
    setCheck(request);
    try {
      const next = await ipc("websiteAccounts.check", { id: request.id });
      if (!current()) return;
      if (next.id !== request.id || next.provider !== "jianshu")
        throw new Error("返回的账号与本次核验不一致，请重新检查登录。");
      update.current(next);
      if (next.status !== "connected" || next.unverified || !next.uid)
        throw new Error(
          next.message || "简书身份尚未核实，请完成官网登录后重新检查。",
        );
      if (current()) notify("简书账号身份已核实。", "success");
    } catch (error) {
      if (current())
        setCheck({
          ...request,
          pending: false,
          error: localServiceError(
            error instanceof Error ? error.message : "身份检查未完成，请重试。",
          ),
        });
    } finally {
      active.current = null;
      if (alive.current)
        setCheck((previous) =>
          previous === request ? { ...request, pending: false } : previous,
        );
    }
  };

  if (!account) return null;
  const ready =
    account.status === "connected" && !account.unverified && !!account.uid;
  return (
    <section aria-label="简书账号登录状态" aria-busy={busy}>
      {ready && !ownCheck?.error ? (
        <div className="jianshu-inline" role="status">
          <Status kind="good">身份已核实</Status>
        </div>
      ) : (
        <Notice warning>
          <div className="jianshu-inline">
            <Status kind="warning">
              {ownCheck?.pending || account.checking
                ? "正在核验"
                : account.status === "expired"
                  ? "登录已失效"
                  : account.unverified
                    ? "待核验"
                    : "尚未连接"}
            </Status>
            <span role={ownCheck?.error ? "alert" : "status"}>
              {ownCheck?.pending || account.checking
                ? "正在读取简书当前登录身份…"
                : ownCheck?.error ||
                  (busy
                    ? "正在核验上一账号，请稍候。"
                    : account.message ||
                      "完成官网登录后，点击检查登录确认本次身份。")}
            </span>
            <Button
              size="compact"
              disabled={disabled || busy}
              onClick={() => void verify()}
            >
              {ownCheck?.pending || account.checking ? "正在核验…" : "检查登录"}
            </Button>
          </div>
        </Notice>
      )}
    </section>
  );
}

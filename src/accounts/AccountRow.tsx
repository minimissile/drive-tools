import { useEffect, useRef } from "react";
import { ArrowRightLeft, LogIn, ShieldCheck, Star } from "lucide-react";
import type { Account } from "../../shared/types";
import { ProviderIcon } from "../resources/ProviderIcon";
import { providerName } from "../resources/labels";
import { formatTime } from "../lib/format";
import { Button, Status } from "../ui/primitives";
import Capacity from "./Capacity";
import type { AccountOperation } from "./useAccountOperations";

export function AccountRow({
  account,
  current,
  focusLogin = false,
  busy,
  pending,
  onUse,
  onManage,
  onOperation,
  onLoginFocused,
}: {
  account: Account;
  current: boolean;
  focusLogin?: boolean;
  busy: boolean;
  pending: AccountOperation | null;
  onUse(): void;
  onManage(): void;
  onOperation(action: AccountOperation): void;
  onLoginFocused?(): void;
}) {
  const row = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focusLogin) return;
    const button = row.current?.querySelector<HTMLButtonElement>(
      '[data-account-action="login"]',
    );
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest" });
    onLoginFocused?.();
  }, [focusLogin, onLoginFocused]);
  const connected = account.enabled && account.status === "connected";
  return (
    <article
      ref={row}
      className="account-row"
      aria-label={account.alias}
      data-enabled={account.enabled}
    >
      <div className="account-identity">
        <ProviderIcon provider={account.provider} />
        <div className="account-identity-content">
          <h3 title={account.alias}>{account.alias}</h3>
          <div className="account-badges">
            <span>{providerName(account.provider)}</span>
            <Status
              kind={
                !account.enabled ? "normal" : connected ? "good" : "warning"
              }
            >
              {!account.enabled
                ? "已停用"
                : connected
                  ? "已登录"
                  : account.status === "expired"
                    ? "登录失效"
                    : "尚未登录"}
            </Status>
            {current && account.enabled ? (
              <span className="tag active">当前使用</span>
            ) : null}
            {account.isDefault ? (
              <span className="account-default">
                <Star size={11} aria-hidden="true" />
                默认账号
              </span>
            ) : null}
          </div>
          <p className="account-identity-meta">
            <span title={account.uid ?? undefined}>
              {account.uid
                ? `UID ${account.uid.length > 14 ? `${account.uid.slice(0, 5)}…${account.uid.slice(-5)}` : account.uid}`
                : "核验后读取本人 UID"}
            </span>
            <span>{account.resourceCopies ?? 0} 份副本</span>
          </p>
          <p className="account-verified">
            最近核验：{formatTime(account.lastVerifiedAt)}
          </p>
          {account.error ? (
            <p className="account-error">{account.error}</p>
          ) : null}
        </div>
      </div>
      <Capacity
        account={account}
        refreshing={pending === "capacity"}
        disabled={busy || !connected}
        onRefresh={() => onOperation("capacity")}
      />
      <div className="account-action-cell">
        <div className="account-actions">
          {account.enabled && !current ? (
            <Button size="compact" disabled={busy} onClick={onUse}>
              <ArrowRightLeft size={14} aria-hidden="true" />
              切换使用
            </Button>
          ) : null}
          {account.enabled && !connected ? (
            <Button
              size="compact"
              primary
              data-account-action="login"
              disabled={busy}
              onClick={() => onOperation("login")}
            >
              <LogIn size={14} aria-hidden="true" />
              {pending === "login" ? "正在打开…" : "登录本人账号"}
            </Button>
          ) : null}
          {account.enabled ? (
            <Button
              size="compact"
              disabled={busy}
              onClick={() => onOperation("verify")}
            >
              <ShieldCheck size={14} aria-hidden="true" />
              {pending === "verify" ? "正在核验…" : "核验登录"}
            </Button>
          ) : null}
          <Button size="compact" quiet disabled={busy} onClick={onManage}>
            管理
          </Button>
        </div>
        <p>
          {!account.enabled
            ? "可在管理中重新启用"
            : !connected
              ? "完成官方登录后，再核验本人 UID"
              : current
                ? "新录入将使用此账号"
                : "已有任务仍绑定原账号"}
        </p>
      </div>
    </article>
  );
}

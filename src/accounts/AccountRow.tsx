import { useEffect, useRef } from "react";
import {
  ArrowRightLeft,
  LogIn,
  ShieldCheck,
  Star,
  Settings2,
  Trash2,
  Fingerprint,
} from "lucide-react";
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
  onBrowser,
  onDelete,
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
  onBrowser(): void;
  onDelete(): void;
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
                  : account.browser && !account.lastVerifiedAt
                    ? "后台待核验"
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
            <span>
              {account.lastVerifiedAt
                ? `核验 ${formatTime(account.lastVerifiedAt)}`
                : "尚未核验"}
            </span>
          </p>
          {account.provider === "baidu" &&
          account.browserEngine === "bitbrowser" ? (
            <Button
              size="compact"
              quiet
              disabled={busy}
              className="account-browser-action"
              onClick={onBrowser}
              title={account.browser?.profileName}
            >
              <Fingerprint size={14} aria-hidden="true" />
              <span>
                比特后台 · {account.browser?.profileName ?? "原环境待恢复"}
              </span>
            </Button>
          ) : account.provider === "baidu" ? (
            <p className="account-identity-meta">内置浏览器 · 创建后固定</p>
          ) : null}
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
            <Button
              quiet
              size="compact"
              disabled={busy}
              className="account-icon-action"
              onClick={onUse}
              aria-label={`切换使用${account.alias}`}
              title="用于后续新录入"
            >
              <ArrowRightLeft size={14} aria-hidden="true" />
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
              {pending === "login" ? "正在打开…" : "登录"}
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
          <Button
            size="compact"
            quiet
            disabled={busy}
            className="account-icon-action"
            onClick={onManage}
            aria-label={`管理${account.alias}`}
            title="账号设置"
          >
            <Settings2 size={15} aria-hidden="true" />
          </Button>
          <Button
            size="compact"
            quiet
            className="account-icon-action account-delete-trigger"
            disabled={busy}
            onClick={onDelete}
            aria-label={`删除${account.alias}`}
            title="删除账号及本地资源"
          >
            <Trash2 size={15} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </article>
  );
}

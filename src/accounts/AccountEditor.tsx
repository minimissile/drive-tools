import { useRef, useState } from "react";
import { LogIn, Star } from "lucide-react";
import type { Account } from "../../shared/types";
import { providerStatisticsNotes } from "../../shared/providers";
import { useAppActions, useAppActivity, useAppData } from "../state";
import { Button, Field, Notice } from "../ui/primitives";
import { Dialog } from "../ui/Dialog";
import { ProviderIcon } from "../resources/ProviderIcon";
import { providerName } from "../resources/labels";
import { useAccountOperations } from "./useAccountOperations";

export function AccountEditor({
  account,
  onClose,
}: {
  account: Account;
  onClose(): void;
}) {
  const { command } = useAppActions(),
    { busy } = useAppActivity(),
    { data } = useAppData();
  const { run } = useAccountOperations();
  const clearTrigger = useRef<HTMLButtonElement>(null);
  const latest = data?.accounts.find((a) => a.id === account.id) ?? account;
  const [alias, setAlias] = useState(account.alias),
    [directory, setDirectory] = useState(account.defaultDirectory),
    [enabled, setEnabled] = useState(account.enabled),
    [confirmClear, setConfirmClear] = useState(false);
  return (
    <Dialog
      title={`管理 ${latest.alias}`}
      onClose={onClose}
      busy={busy > 0}
      className="account-editor"
    >
      <div className="account-editor-identity">
        <ProviderIcon provider={account.provider} size="medium" decorative />
        <span>{providerName(account.provider)} · 登录会话独立隔离</span>
        {latest.enabled ? (
          <Button
            quiet
            size="compact"
            disabled={busy > 0}
            onClick={() => void run(latest, "login")}
          >
            <LogIn size={14} aria-hidden="true" />
            打开登录窗口
          </Button>
        ) : null}
      </div>
      <Field label="账号别名">
        <input
          value={alias}
          maxLength={60}
          onChange={(e) => setAlias(e.target.value)}
        />
      </Field>
      <Field label="默认转存目录" hint="用于此账号后续的新任务">
        <input
          value={directory}
          maxLength={500}
          onChange={(e) => setDirectory(e.target.value)}
        />
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        启用此账号
      </label>
      <div className="account-default-setting">
        <div>
          <strong>新任务默认账号</strong>
          <p>未手动选择账号时，使用此网盘的默认账号。切换不会改绑已有任务。</p>
        </div>
        <Button
          size="compact"
          disabled={busy > 0 || !latest.enabled || latest.isDefault}
          onClick={() =>
            void command(
              "account.default",
              { id: latest.id },
              "已设为新任务的默认账号。",
            )
          }
        >
          <Star size={13} aria-hidden="true" />
          {latest.isDefault ? "已设为默认" : "设为默认"}
        </Button>
      </div>
      {providerStatisticsNotes[account.provider] ? (
        <Notice>{providerStatisticsNotes[account.provider]}</Notice>
      ) : null}
      <div className="account-editor-security">
        <strong>本地登录凭据</strong>
        <p>
          移除本地会话并停用此账号，保留 UID
          和历史归属；不会删除网盘文件或撤销分享。
        </p>
        {confirmClear ? (
          <div
            className="account-clear-confirm"
            role="group"
            aria-label="确认移除本地凭据"
          >
            <Notice warning>
              移除后此账号会停用。重新启用、登录并核验后才能继续使用。
            </Notice>
            <div className="row">
              <Button
                autoFocus
                disabled={busy > 0}
                onClick={() => {
                  setConfirmClear(false);
                  requestAnimationFrame(() => clearTrigger.current?.focus());
                }}
              >
                保留凭据
              </Button>
              <Button
                className="account-clear-button"
                disabled={busy > 0}
                onClick={async () => {
                  if (
                    await command(
                      "account.clear",
                      { id: latest.id },
                      "本地会话已移除，账号已停用；云端文件和分享保留。",
                    )
                  )
                    onClose();
                }}
              >
                确认移除本地凭据
              </Button>
            </div>
          </div>
        ) : (
          <Button
            quiet
            size="compact"
            ref={clearTrigger}
            className="account-clear-button"
            disabled={busy > 0}
            onClick={() => setConfirmClear(true)}
          >
            移除本地凭据
          </Button>
        )}
      </div>
      <div className="actions">
        <Button disabled={busy > 0} onClick={onClose}>
          取消
        </Button>
        <Button
          primary
          disabled={busy > 0 || !alias.trim()}
          onClick={async () => {
            if (
              await command(
                "account.update",
                { id: account.id, alias, defaultDirectory: directory, enabled },
                "账号设置已保存。",
              )
            )
              onClose();
          }}
        >
          保存设置
        </Button>
      </div>
    </Dialog>
  );
}

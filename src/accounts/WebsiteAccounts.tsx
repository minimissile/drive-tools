import { useRef, useState } from "react";
import { Globe, LogIn, Plus } from "lucide-react";
import type {
  WebsiteAccountView,
  WebsiteProvider,
} from "../../shared/website-accounts";
import { websiteProviderSpecs } from "../../shared/website-accounts";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  Panel,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Dialog } from "../ui/Dialog";
import "./website-accounts.css";
export default function WebsiteAccounts() {
  const accounts = useIpcQuery("websiteAccounts.list", undefined, {
    keepPrevious: true,
    refreshInterval: 2500,
  });
  const [provider, setProvider] = useState<WebsiteProvider>("baidu-marketing");
  const [pending, setPending] = useState<string | null>(null),
    [failure, setFailure] = useState<{ id: string; text: string } | null>(null);
  const lock = useRef(false);
  const [removing, setRemoving] = useState<WebsiteAccountView | null>(null),
    [editing, setEditing] = useState<WebsiteAccountView | null>(null),
    [alias, setAlias] = useState("");
  const run = async (id: string, action: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    setPending(id);
    setFailure(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setFailure({
        id,
        text: cause instanceof Error ? cause.message : "操作未完成，请重试。",
      });
      return false;
    } finally {
      lock.current = false;
      setPending(null);
      accounts.reload();
    }
  };
  return (
    <div className="website-accounts-workspace">
      <Panel title="连接网站账号">
        <p className="muted">
          选择平台后直接打开官方登录窗口，无需填写用户ID。完成登录后自动识别身份，可为同一平台添加多个账号。
        </p>
        <div className="website-account-add">
          <Field label="网站平台">
            <Select
              aria-label="网站账号平台"
              value={provider}
              onValueChange={(v) => setProvider(v as WebsiteProvider)}
              items={Object.entries(websiteProviderSpecs).map(
                ([value, spec]) => ({ value, label: spec.name }),
              )}
            />
          </Field>
          <Button
            primary
            disabled={!!pending}
            onClick={() =>
              void run("add", async () => {
                const account = await ipc("websiteAccounts.add", { provider });
                accounts.reload();
                try {
                  await ipc("websiteAccounts.login", { id: account.id });
                } catch (cause) {
                  setFailure({
                    id: account.id,
                    text:
                      cause instanceof Error
                        ? cause.message
                        : "官方登录窗口未打开，请重试登录。",
                  });
                }
              })
            }
          >
            <Plus size={16} />
            {pending === "add" ? "正在打开…" : "登录新账号"}
          </Button>
        </div>
        {failure?.id === "add" ? <Notice danger>{failure.text}</Notice> : null}
      </Panel>
      <Panel
        title="我的网站账号"
        extra={
          <Button quiet disabled={accounts.loading} onClick={accounts.reload}>
            刷新本地状态
          </Button>
        }
      >
        {accounts.error && accounts.data ? (
          <Notice warning>
            本地状态刷新失败，保留已读取的账号。
            <Button quiet onClick={accounts.reload}>
              重试读取
            </Button>
          </Notice>
        ) : (
          <QueryError
            error={accounts.error}
            loading={accounts.loading}
            onRetry={accounts.reload}
          />
        )}
        {!accounts.data && !accounts.error ? (
          <LoadingState label="正在读取网站账号…" />
        ) : accounts.data?.length ? (
          <div className="website-account-list">
            {accounts.data.map((account) => (
              <article className="website-account-row" key={account.id}>
                <div className="website-account-identity">
                  <Globe size={22} aria-hidden="true" />
                  <div>
                    <strong>{account.alias}</strong>
                    <small>
                      {websiteProviderSpecs[account.provider].name}
                      {account.uid
                        ? ` · 已识别账号 ${account.uid}`
                        : " · 尚未识别身份"}
                    </small>
                  </div>
                </div>
                <div className="website-account-state">
                  <Status
                    kind={account.status === "connected" ? "good" : "warning"}
                  >
                    {account.status === "connected"
                      ? "已识别会话"
                      : account.status === "expired"
                        ? "需重新登录"
                        : "待登录"}
                  </Status>
                  <small
                    role={failure?.id === account.id ? "alert" : undefined}
                  >
                    {failure?.id === account.id
                      ? failure.text
                      : account.message}
                  </small>
                </div>
                <div className="website-account-actions">
                  <Button
                    disabled={!!pending}
                    onClick={() =>
                      void run(account.id, () =>
                        ipc("websiteAccounts.login", { id: account.id }),
                      )
                    }
                  >
                    <LogIn size={14} />
                    {pending === account.id
                      ? "正在处理…"
                      : account.windowOpen
                        ? "返回登录窗口"
                        : "登录 / 扫码"}
                  </Button>
                  <Button
                    quiet
                    disabled={!!pending}
                    onClick={() =>
                      void run(account.id, () =>
                        ipc("websiteAccounts.check", { id: account.id }),
                      )
                    }
                  >
                    检查登录
                  </Button>
                  <Button
                    quiet
                    disabled={!!pending}
                    onClick={() => {
                      setEditing(account);
                      setAlias(account.alias);
                    }}
                  >
                    备注
                  </Button>
                  <Button
                    quiet
                    disabled={!!pending}
                    onClick={() => setRemoving(account)}
                  >
                    移除
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : accounts.data ? (
          <Empty title="添加第一个网站账号">
            点击“登录新账号”，在官方窗口完成登录。后续新增平台的登录状态也会在这里管理。
          </Empty>
        ) : null}
      </Panel>
      {editing ? (
        <Dialog
          title="修改网站账号备注"
          onClose={() => setEditing(null)}
          busy={!!pending}
        >
          <Field label="网站账号备注">
            <input
              aria-label="网站账号备注"
              value={alias}
              maxLength={60}
              onChange={(e) => setAlias(e.target.value)}
            />
          </Field>
          {failure?.id === editing.id ? (
            <Notice danger>{failure.text}</Notice>
          ) : null}
          <Button
            primary
            disabled={!alias.trim() || !!pending}
            onClick={() =>
              void run(editing.id, async () => {
                await ipc("websiteAccounts.rename", { id: editing.id, alias });
                setEditing(null);
              })
            }
          >
            保存备注
          </Button>
        </Dialog>
      ) : null}
      {removing ? (
        <Dialog
          title="移除网站账号"
          onClose={() => setRemoving(null)}
          busy={!!pending}
        >
          <Notice warning>
            将移除“{removing.alias}”的本机会话和账号记录，已保存的词池保留。
          </Notice>
          {failure?.id === removing.id ? (
            <Notice danger>{failure.text}</Notice>
          ) : null}
          <div className="dialog-actions">
            <Button onClick={() => setRemoving(null)}>取消</Button>
            <Button
              disabled={!!pending}
              onClick={() =>
                void run(removing.id, async () => {
                  await ipc("websiteAccounts.remove", {
                    id: removing.id,
                    confirmed: true,
                  });
                  setRemoving(null);
                })
              }
            >
              确认移除
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

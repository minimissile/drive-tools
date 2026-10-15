import { useState } from "react";
import { LogIn, Plus, ShieldCheck, Star, UserRound } from "lucide-react";
import { useApp } from "../state";
import {
  Button,
  Field,
  Header,
  Notice,
  Panel,
  Status,
  Empty,
  providerName,
  formatTime,
} from "../components";
import type { Account, Provider } from "../../shared/types";
export default function Accounts() {
  const { data, command, activeAccounts, setActiveAccount, busy } = useApp();
  const [provider, setProvider] = useState<Provider>("quark"),
    [alias, setAlias] = useState(""),
    [filter, setFilter] = useState("all"),
    [editing, setEditing] = useState<Account | null>(null);
  const add = async () => {
    const account = await command<Account>(
      "account.add",
      { provider, alias },
      "账号已建立，请在隔离窗口中完成登录并核验UID。",
    );
    if (account) {
      setAlias("");
      setActiveAccount(account.provider, account.id);
    }
  };
  return (
    <>
      <Header
        title="同一个网盘，也能管理多个账号。"
        description="登录会话彼此隔离；每个转存任务锁定创建时选定的本人账号。"
      />
      <div className="toolbar">
        <select
          aria-label="账号网盘筛选"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">全部网盘</option>
          <option value="quark">夸克</option>
          <option value="baidu">百度</option>
        </select>
        <span className="muted">
          切换工作账号只作用于新录入，已有任务不会改绑。
        </span>
      </div>
      <Panel>
        {data!.accounts.length ? (
          data!.accounts
            .filter((a) => filter === "all" || a.provider === filter)
            .map((a) => (
              <div className="account-row" key={a.id}>
                <span className={`provider-logo ${a.provider}`}>
                  {providerName(a.provider)[0]}
                </span>
                <div className="account-content">
                  <div className="row">
                    <h3>{a.alias}</h3>
                    {a.isDefault ? (
                      <span className="tag">
                        <Star size={11} />
                        默认账号
                      </span>
                    ) : null}
                    {activeAccounts[a.provider] === a.id ? (
                      <span className="tag active">当前使用</span>
                    ) : null}
                    <Status
                      kind={a.status === "connected" ? "good" : "warning"}
                    >
                      {a.status === "connected"
                        ? "已登录"
                        : a.status === "disabled"
                          ? "已停用"
                          : a.status === "expired"
                            ? "登录失效"
                            : "尚未登录"}
                    </Status>
                  </div>
                  <p>
                    {providerName(a.provider)}网盘 ·{" "}
                    {a.uid
                      ? `本人UID：${a.uid.length > 10 ? `${a.uid.slice(0, 4)}…${a.uid.slice(-4)}` : a.uid}`
                      : "完成登录后读取UID"}{" "}
                    ·{" "}
                    {data!.resources.reduce(
                      (n, r) =>
                        n + r.copies.filter((c) => c.accountId === a.id).length,
                      0,
                    )}{" "}
                    份资源副本
                  </p>
                  <small>最近核验：{formatTime(a.lastVerifiedAt)}</small>
                  {a.error ? <p className="danger-text">{a.error}</p> : null}
                  <div className="row account-actions">
                    <Button
                      primary
                      disabled={
                        !a.enabled || activeAccounts[a.provider] === a.id
                      }
                      onClick={() => setActiveAccount(a.provider, a.id)}
                    >
                      切换使用
                    </Button>
                    <Button
                      disabled={!a.enabled || busy > 0}
                      onClick={() =>
                        void command("account.login", { id: a.id })
                      }
                    >
                      <LogIn size={14} />
                      {a.status === "connected"
                        ? "打开登录窗口"
                        : "登录本人账号"}
                    </Button>
                    <Button
                      disabled={!a.enabled || busy > 0}
                      onClick={() =>
                        void command(
                          "account.check",
                          { id: a.id },
                          "UID已核验，原账号任务可继续执行。",
                        )
                      }
                    >
                      <ShieldCheck size={14} />
                      核验登录
                    </Button>
                    <Button
                      quiet
                      disabled={!a.enabled || a.isDefault}
                      onClick={() =>
                        void command(
                          "account.default",
                          { id: a.id },
                          "已设为新任务的默认账号。",
                        )
                      }
                    >
                      设为默认
                    </Button>
                    <Button quiet onClick={() => setEditing({ ...a })}>
                      管理
                    </Button>
                  </div>
                </div>
              </div>
            ))
        ) : (
          <Empty title="添加你的第一个网盘账号">
            先添加账号别名，再在网盘官方登录页完成登录。盘序不会要求你填写网盘密码。
          </Empty>
        )}
      </Panel>
      <Panel
        title="新增本人账号"
        extra={<span className="muted">支持百度和夸克</span>}
      >
        <div className="row">
          <select
            aria-label="新增账号网盘"
            value={provider}
            onChange={(e) => setProvider(e.target.value as Provider)}
          >
            <option value="quark">夸克网盘</option>
            <option value="baidu">百度网盘</option>
          </select>
          <input
            className="grow"
            aria-label="新增账号别名"
            placeholder="账号别名，例如：夸克资料号"
            value={alias}
            maxLength={60}
            onChange={(e) => setAlias(e.target.value)}
          />
          <Button
            primary
            disabled={!alias.trim() || busy > 0}
            onClick={() => void add()}
          >
            <Plus size={16} />
            添加账号
          </Button>
        </div>
      </Panel>
      <Notice>
        <strong>对外只用本人的分享：</strong>所选账号转存 → 核验目标文件UID →
        同一账号创建分享 →
        核验分享归属。来源链接仅作内部追溯，分享失败不会回退使用来源链接。
      </Notice>
      {editing ? (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="管理账号"
          >
            <div className="panel-heading">
              <h2>管理 {editing.alias}</h2>
              <Button quiet onClick={() => setEditing(null)}>
                关闭
              </Button>
            </div>
            <Field label="账号别名">
              <input
                value={editing.alias}
                onChange={(e) =>
                  setEditing({ ...editing, alias: e.target.value })
                }
              />
            </Field>
            <Field label="默认转存目录">
              <input
                value={editing.defaultDirectory}
                onChange={(e) =>
                  setEditing({ ...editing, defaultDirectory: e.target.value })
                }
              />
            </Field>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={editing.enabled}
                onChange={(e) =>
                  setEditing({ ...editing, enabled: e.target.checked })
                }
              />
              启用此账号
            </label>
            <Notice warning>
              移除凭据仅清除此账号的本地登录会话，保留UID与历史归属，不会删除网盘文件或撤销分享。
            </Notice>
            <div className="actions spread">
              <Button
                disabled={busy > 0}
                onClick={async () => {
                  if (
                    await command(
                      "account.clear",
                      { id: editing.id },
                      "本地会话已移除，云端文件和分享保留。",
                    )
                  )
                    setEditing(null);
                }}
              >
                移除本地凭据
              </Button>
              <Button
                primary
                disabled={busy > 0}
                onClick={async () => {
                  if (
                    await command(
                      "account.update",
                      {
                        id: editing.id,
                        alias: editing.alias,
                        defaultDirectory: editing.defaultDirectory,
                        enabled: editing.enabled,
                      },
                      "账号设置已保存。",
                    )
                  )
                    setEditing(null);
                }}
              >
                保存设置
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

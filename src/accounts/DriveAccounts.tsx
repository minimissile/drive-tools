import { useId, useState } from "react";
import { Plus, ShieldCheck, X } from "lucide-react";
import { providerIds, providerSpecs } from "../../shared/providers";
import type { Account, Provider } from "../../shared/types";
import { useAppActivity, useAppData, useAppSelection } from "../state";
import { Button, Empty, SearchField } from "../ui/primitives";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { ProviderIcon } from "../resources/ProviderIcon";
import { AddAccountForm } from "./AddAccountForm";
import { AccountRow } from "./AccountRow";
import { AccountEditor } from "./AccountEditor";
import { useAccountOperations } from "./useAccountOperations";
import "./accounts.css";

export default function DriveAccounts() {
  const { data } = useAppData(),
    { busy } = useAppActivity(),
    { activeAccounts, setActiveAccount } = useAppSelection();
  const { pending, run } = useAccountOperations();
  const accounts = data!.accounts;
  const [adding, setAdding] = useState(accounts.length === 0);
  const [newAccountId, setNewAccountId] = useState("");
  const formId = useId();
  const [filter, setFilter] = useState<"all" | Provider>("all"),
    [query, setQuery] = useState(""),
    [editing, setEditing] = useState<Account | null>(null);
  const needle = query.trim().normalize("NFKC").toLocaleLowerCase();
  const filtered = accounts.filter(
    (a) =>
      (filter === "all" || a.provider === filter) &&
      `${a.alias} ${a.uid ?? ""} ${providerSpecs[a.provider].name}`
        .normalize("NFKC")
        .toLocaleLowerCase()
        .includes(needle),
  );
  const clearFilters = () => {
    setQuery("");
    setFilter("all");
  };
  return (
    <div className="accounts-page">
      <div className="accounts-list-toolbar">
        <div>
          <h2>网盘账号</h2>
          <p>连接本人网盘，管理登录状态与新任务的默认账号。</p>
        </div>
        <Button
          primary={!adding}
          onClick={() => setAdding((open) => !open)}
          aria-expanded={adding}
          aria-controls={formId}
        >
          {adding ? (
            <X size={15} aria-hidden="true" />
          ) : (
            <Plus size={16} aria-hidden="true" />
          )}
          {adding ? "收起添加" : "新增账号"}
        </Button>
      </div>
      <div id={formId} hidden={!adding}>
        {adding ? (
          <AddAccountForm
            onAdded={(account) => {
              setFilter(account.provider);
              setQuery("");
              setNewAccountId(account.id);
              setAdding(false);
            }}
          />
        ) : null}
      </div>
      <Tabs<"all" | Provider>
        value={filter}
        onChange={setFilter}
        className="accounts-browser"
      >
        <div className="accounts-list-toolbar">
          <div>
            <h2>
              我的账号 <span>{accounts.length}</span>
            </h2>
            <p>当前使用只作用于新录入，已有任务仍绑定原账号。</p>
          </div>
          <SearchField
            value={query}
            onChange={setQuery}
            label="搜索网盘账号"
            placeholder="搜索别名、网盘或 UID"
          />
        </div>
        <div className="accounts-provider-filter">
          <TabList
            label="账号网盘筛选"
            items={[
              [
                "all",
                <>
                  全部网盘{" "}
                  <span className="account-filter-count">
                    {accounts.length}
                  </span>
                </>,
              ],
              ...providerIds.map(
                (id) =>
                  [
                    id,
                    <>
                      <ProviderIcon provider={id} size="small" decorative />
                      {providerSpecs[id].name}
                      <span className="account-filter-count">
                        {accounts.filter((a) => a.provider === id).length}
                      </span>
                    </>,
                  ] as const,
              ),
            ]}
          />
        </div>
        <TabPanel value={filter}>
          <div className="accounts-list" aria-label="网盘账号列表">
            {filtered.length ? (
              <>
                <div className="accounts-column-head" aria-hidden="true">
                  <span>网盘与账号</span>
                  <span>网盘容量</span>
                  <span>账号操作</span>
                </div>
                {filtered.map((a) => (
                  <AccountRow
                    key={a.id}
                    account={a}
                    focusLogin={newAccountId === a.id}
                    onLoginFocused={() => setNewAccountId("")}
                    current={
                      (activeAccounts[a.provider] ??
                        accounts.find(
                          (candidate) =>
                            candidate.provider === a.provider &&
                            candidate.isDefault,
                        )?.id) === a.id
                    }
                    busy={busy > 0}
                    pending={pending?.id === a.id ? pending.action : null}
                    onUse={() => setActiveAccount(a.provider, a.id)}
                    onManage={() => setEditing(a)}
                    onOperation={(action) => void run(a, action)}
                  />
                ))}
              </>
            ) : (
              <Empty
                title={
                  !accounts.length
                    ? "添加你的第一个网盘账号"
                    : "没有找到匹配的账号"
                }
                action={
                  accounts.length ? (
                    <Button onClick={clearFilters}>清除筛选</Button>
                  ) : undefined
                }
              >
                {!accounts.length
                  ? "在上方选择网盘并添加账号别名，再在官方窗口完成登录。盘序不会要求你填写网盘密码。"
                  : "试试其他别名或 UID，也可以切换网盘查看。"}
              </Empty>
            )}
          </div>
        </TabPanel>
      </Tabs>
      <p className="accounts-footnote">
        <ShieldCheck size={15} aria-hidden="true" />
        <span>
          登录会话相互隔离，对外分享始终核验本人归属。容量来自网盘官方接口，按
          1024 换算。
        </span>
      </p>
      {editing ? (
        <AccountEditor
          key={editing.id}
          account={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

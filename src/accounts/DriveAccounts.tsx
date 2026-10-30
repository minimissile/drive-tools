import { useId, useState } from "react";
import { Plus, ShieldCheck, X } from "lucide-react";
import { providerIds, providerSpecs } from "../../shared/providers";
import type { Account, Provider } from "../../shared/types";
import {
  useAppActivity,
  useAppData,
  useAppSelection,
  useAppNavigation,
} from "../state";
import { Button, Empty, SearchField } from "../ui/primitives";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { ProviderIcon } from "../resources/ProviderIcon";
import { AddAccountForm } from "./AddAccountForm";
import { AccountRow } from "./AccountRow";
import { AccountEditor } from "./AccountEditor";
import { AccountDeleteDialog } from "./AccountDeleteDialog";
import { useAccountOperations } from "./useAccountOperations";
import "./accounts.css";

export default function DriveAccounts() {
  const { data } = useAppData(),
    { busy } = useAppActivity(),
    {
      activeAccounts,
      setActiveAccount,
      select,
      selectedResourceId,
      selectedCopyId,
    } = useAppSelection(),
    { navigate } = useAppNavigation();
  const { pending, run } = useAccountOperations();
  const accounts = data!.accounts;
  const [deleting, setDeleting] = useState<Account | null>(null);
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
        <p className="accounts-overview">
          <span className="accounts-total">
            <strong>{accounts.length}</strong> 个网盘账号
          </span>
          <span>
            {
              accounts.filter((a) => a.enabled && a.status === "connected")
                .length
            }{" "}
            个已登录
          </span>
          {accounts.some((a) => !a.enabled) ? (
            <span>{accounts.filter((a) => !a.enabled).length} 个已停用</span>
          ) : null}
        </p>
        <div className="accounts-toolbar-actions">
          <SearchField
            value={query}
            onChange={setQuery}
            label="搜索网盘账号"
            placeholder="搜索别名、网盘或 UID"
          />
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
                      (accounts.some(
                        (candidate) =>
                          candidate.id === activeAccounts[a.provider] &&
                          candidate.enabled,
                      )
                        ? activeAccounts[a.provider]
                        : accounts.find(
                            (candidate) =>
                              candidate.provider === a.provider &&
                              candidate.isDefault,
                          )?.id) === a.id
                    }
                    busy={busy > 0}
                    pending={pending?.id === a.id ? pending.action : null}
                    onUse={() => setActiveAccount(a.provider, a.id)}
                    onManage={() => setEditing(a)}
                    onDelete={() => setDeleting(a)}
                    onOperation={(action) => void run(a, action)}
                  />
                ))}
              </>
            ) : (
              <Empty
                compact
                title={
                  !accounts.length
                    ? "添加你的第一个网盘账号"
                    : "没有找到匹配的账号"
                }
                action={
                  accounts.length ? (
                    <Button onClick={clearFilters}>清除筛选</Button>
                  ) : (
                    <Button primary onClick={() => setAdding(true)}>
                      新增账号
                    </Button>
                  )
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
          当前账号用于后续录入，已有任务保留原账号。删除仅清理本地记录，网盘文件保留。容量按
          1024 换算。
        </span>
      </p>
      {deleting ? (
        <AccountDeleteDialog
          account={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(result) => {
            if (result.removedResourceIds.includes(selectedResourceId))
              select("");
            else if (result.removedCopyIds.includes(selectedCopyId))
              select(selectedResourceId);
            if (activeAccounts[result.provider] === result.accountId)
              setActiveAccount(
                result.provider,
                result.replacementAccountId ?? "",
              );
            setDeleting(null);
          }}
          onResource={(id) => {
            setDeleting(null);
            select(id);
            navigate("library");
          }}
        />
      ) : null}
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

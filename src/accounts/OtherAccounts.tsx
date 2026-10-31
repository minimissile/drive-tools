import { useEffect, useId, useRef, useState } from "react";
import { ipc } from "../api/client";
import { environmentAllowsAccount } from "../../shared/browser-environment-sharing";
import { useAppActions, useAppData, useAppNavigation } from "../state";
import { prepareAutoAnswer } from "../zhidao/answer-draft";
import { ZhidaoRightsDialog } from "./ZhidaoRightsDialog";
import { WeiboPublishingDialog } from "./WeiboPublishingDialog";
import { WeiboComposer } from "./WeiboComposer";
import { PublishingAccounts } from "./PublishingAccounts";
import { WeiboAccountStatistics } from "../weibo/Statistics";
import { Plus, RefreshCw, ShieldCheck, X } from "lucide-react";
import { PlatformIcon } from "../platforms/PlatformIcon";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { OtherAccountConnection } from "./OtherAccountConnection";
import { OtherAccountRow, type OtherAccountAction } from "./OtherAccountRow";
import {
  useOtherAccounts,
  otherAccountActions,
  otherProviderItems,
  otherProviderName,
  defaultOtherAccountBrowser,
  type OtherAccount,
  type OtherProvider,
} from "./useOtherAccounts";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  SearchField,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Dialog } from "../ui/Dialog";
import {
  AccountBrowserChoice,
  type AccountBrowserSelection,
} from "./AccountBrowserChoice";
import {
  clearAccountEnvironment,
  readAccountEnvironment,
} from "./environment-navigation";
import "./website-accounts.css";
import {
  documentPlatformSpecs,
  isDocumentProvider,
} from "../../shared/document-platforms";
export default function OtherAccounts({
  initialProvider = "weibo",
}: {
  initialProvider?: OtherProvider;
}) {
  const accounts = useOtherAccounts();
  const { notify } = useAppActions();
  const { data } = useAppData();
  const { navigate } = useAppNavigation();
  const openAutoAnswer = (account: OtherAccount) => {
    try {
      prepareAutoAnswer(data!.dataPath, account.id);
      setRightsAccount(null);
      navigate("zhidao-qa");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "无法打开自动答题。",
        "error",
      );
    }
  };
  const [rightsAccount, setRightsAccount] = useState<OtherAccount | null>(null);
  const [publishingAccount, setPublishingAccount] =
    useState<OtherAccount | null>(null);
  const [composerAccount, setComposerAccount] = useState<OtherAccount | null>(
    null,
  );
  const [statisticsAccountId, setStatisticsAccountId] = useState("");
  const [provider, setProvider] = useState<OtherProvider>(initialProvider);
  const singleSmzdm = provider === "smzdm";
  const documentProvider = isDocumentProvider(provider);
  const nativeOnly = singleSmzdm || documentProvider;
  const hasSmzdm = accounts.data.some(
    (account) => account.provider === "smzdm",
  );
  const [newAlias, setNewAlias] = useState("");
  const initialEnvironment = useRef(readAccountEnvironment(data!.dataPath));
  const [adding, setAdding] = useState(!!initialEnvironment.current);
  const formId = useId();
  const [filter, setFilter] = useState<"all" | OtherProvider>("all");
  const [query, setQuery] = useState("");
  const [browser, setBrowser] = useState<AccountBrowserSelection>(() =>
    defaultOtherAccountBrowser(initialProvider),
  );
  useEffect(() => {
    const id = initialEnvironment.current;
    if (!id || !accounts.environmentsReady) return;
    const env = accounts.environments.find((item) => item.id === id);
    if (env)
      setBrowser({
        fingerprint: env.engine === "bitbrowser",
        environmentId: id,
      });
    clearAccountEnvironment(data!.dataPath, id);
    initialEnvironment.current = "";
  }, [data!.dataPath, accounts.environments, accounts.environmentsReady]);
  const [assigning, setAssigning] = useState<OtherAccount | null>(null);
  const [targetBrowser, setTargetBrowser] = useState<AccountBrowserSelection>({
    fingerprint: false,
    environmentId: "",
  });
  const validBrowser = (
    selection: AccountBrowserSelection,
    platform: OtherProvider = provider,
  ) =>
    !selection.environmentId
      ? !selection.fingerprint
      : accounts.environments.some(
          (env) =>
            env.id === selection.environmentId &&
            environmentAllowsAccount(env, {
              kind: platform === "baidu-zhidao" ? "zhidao" : "website",
              platform,
            }) &&
            env.engine === (selection.fingerprint ? "bitbrowser" : "electron"),
        );
  const [cookie, setCookie] = useState("");
  const [pending, setPending] = useState<string | null>(null),
    [failure, setFailure] = useState<{ id: string; text: string } | null>(null);
  const lock = useRef(false);
  const [removing, setRemoving] = useState<OtherAccount | null>(null),
    [editing, setEditing] = useState<OtherAccount | null>(null),
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
  const needle = query.trim().normalize("NFKC").toLocaleLowerCase();
  const filtered = accounts.data.filter(
    (account) =>
      (filter === "all" || account.provider === filter) &&
      `${account.alias} ${account.nickname ?? ""} ${account.uid ?? ""} ${otherProviderName(account.provider)}`
        .normalize("NFKC")
        .toLocaleLowerCase()
        .includes(needle),
  );
  const changeProvider = (value: OtherProvider) => {
    setProvider(value);
    setCookie("");
    setBrowser(defaultOtherAccountBrowser(value));
  };
  const handleAction = (account: OtherAccount, action: OtherAccountAction) => {
    switch (action) {
      case "login":
        void run(account.key, () => otherAccountActions.login(account));
        break;
      case "check":
        void run(account.key, () => otherAccountActions.check(account));
        break;
      case "document":
        if (isDocumentProvider(account.provider)) {
          const url = documentPlatformSpecs[account.provider].home;
          void run(account.key, () =>
            ipc("websiteAccounts.openDocument", { id: account.id, url }),
          );
        }
        break;
      case "smzdm-workflow":
        navigate("smzdm-workflow");
        break;
      case "smzdm-editor":
        void run(account.key, () => ipc("smzdm.openEditor"));
        break;
      case "zhihu-operations":
        navigate("zhihu-operations");
        break;
      case "weibo-statistics":
        setStatisticsAccountId((current) =>
          current === account.id ? "" : account.id,
        );
        break;
      case "weibo-compose":
        setComposerAccount(account);
        break;
      case "weibo-marketing":
        navigate("weibo-marketing");
        break;
      case "weibo-publishing":
        setPublishingAccount(account);
        break;
      case "zhidao-answer":
        openAutoAnswer(account);
        break;
      case "zhidao-rights":
        setFailure(null);
        setRightsAccount(account);
        break;
      case "environment": {
        setFailure(null);
        setAssigning(account);
        const env = accounts.environments.find(
          (item) => item.id === account.environmentId,
        );
        setTargetBrowser({
          fingerprint: env?.engine === "bitbrowser",
          environmentId: env?.id ?? "",
        });
        break;
      }
      case "rename":
        setFailure(null);
        setEditing(account);
        setAlias(account.alias);
        break;
      case "remove":
        setFailure(null);
        setRemoving(account);
        break;
    }
  };
  const clearFilters = () => {
    setFilter("all");
    setQuery("");
  };
  return (
    <div className="website-accounts-workspace">
      <div className="accounts-list-toolbar">
        <p className="accounts-overview">
          {accounts.ready || accounts.data.length ? (
            <>
              <span>
                {!accounts.ready ? "已读取 " : ""}
                <strong>{accounts.data.length}</strong> 个平台账号
              </span>
              <span>
                {
                  accounts.data.filter(
                    (account) => account.status === "connected",
                  ).length
                }{" "}
                个已登录
              </span>
            </>
          ) : (
            <span>{accounts.error ? "账号读取未完成" : "正在读取账号…"}</span>
          )}
        </p>
        <div className="accounts-toolbar-actions">
          <SearchField
            label="搜索其他账号"
            value={query}
            onChange={setQuery}
            placeholder="搜索备注、平台或 UID"
          />
          <Button
            quiet
            size="compact"
            title="刷新本地状态"
            aria-label="刷新其他账号本地状态"
            disabled={accounts.loading}
            onClick={accounts.reload}
          >
            <RefreshCw size={15} aria-hidden="true" />
          </Button>
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
          <OtherAccountConnection
            provider={provider}
            onProvider={changeProvider}
            alias={newAlias}
            onAlias={setNewAlias}
            cookie={cookie}
            onCookie={setCookie}
            browser={browser}
            onBrowser={(value) => {
              initialEnvironment.current = "";
              setBrowser(value);
            }}
            environments={accounts.environments}
            environmentsReady={accounts.environmentsReady}
            hasSmzdm={hasSmzdm}
            busy={!!pending}
            canAdd={
              !pending &&
              accounts.ready &&
              !accounts.error &&
              (singleSmzdm
                ? !hasSmzdm
                : nativeOnly ||
                  (accounts.environmentsReady && validBrowser(browser)))
            }
            failure={failure?.id === "add" ? failure.text : undefined}
            onConfigure={() => navigate("browser-environments")}
            onAdd={() =>
              void run("add", async () => {
                const fingerprint = !nativeOnly && browser.fingerprint;
                const account = await otherAccountActions.add(
                  provider,
                  newAlias,
                  cookie,
                  nativeOnly ? undefined : browser.environmentId || undefined,
                );
                setNewAlias("");
                setCookie("");
                setBrowser(defaultOtherAccountBrowser(provider));
                setFilter(account.provider);
                setQuery("");
                setAdding(false);
                accounts.reload();
                try {
                  if (fingerprint) await otherAccountActions.check(account);
                  else await otherAccountActions.login(account);
                } catch (cause) {
                  setFailure({
                    id: account.key,
                    text:
                      cause instanceof Error
                        ? cause.message
                        : fingerprint
                          ? "账号已关联，登录核验未完成。请在此账号打开登录窗口处理后重新检查。"
                          : "账号已添加，官方登录窗口未打开，请重试登录。",
                  });
                }
              })
            }
          />
        ) : null}
      </div>
      <QueryError
        error={accounts.error}
        loading={accounts.loading}
        onRetry={accounts.reload}
      />
      {!accounts.ready && !accounts.error && !accounts.data.length ? (
        <LoadingState label="正在读取其他账号…" />
      ) : null}
      <Tabs<"all" | OtherProvider>
        value={filter}
        onChange={(value) => {
          setFilter(value);
          if (value !== "all" && !adding) changeProvider(value);
        }}
      >
        <div className="accounts-provider-filter">
          <TabList
            label="账号平台筛选"
            items={[
              [
                "all",
                <>
                  全部平台
                  {accounts.ready ? (
                    <span className="account-filter-count">
                      {accounts.data.length}
                    </span>
                  ) : null}
                </>,
              ],
              ...otherProviderItems.map(
                (item) =>
                  [
                    item.value as OtherProvider,
                    <>
                      <PlatformIcon platform={item.value} size="small" />
                      {item.label}
                      {accounts.ready ? (
                        <span className="account-filter-count">
                          {
                            accounts.data.filter(
                              (account) => account.provider === item.value,
                            ).length
                          }
                        </span>
                      ) : null}
                    </>,
                  ] as const,
              ),
            ]}
          />
        </div>
        <TabPanel value={filter}>
          {filtered.length ? (
            <div className="website-account-list" aria-label="其他平台账号列表">
              <div className="website-account-column-head" aria-hidden="true">
                <span>平台与账号</span>
                <span>浏览器环境与状态</span>
                <span>账号操作</span>
              </div>
              {filtered.map((account) => (
                <OtherAccountRow
                  key={account.key}
                  account={account}
                  environment={
                    accounts.environments.find(
                      (env) => env.id === account.environmentId,
                    )?.name ??
                    (accounts.environmentsReady
                      ? "未关联浏览器环境"
                      : "正在读取关联环境")
                  }
                  environmentEngine={
                    accounts.environments.find(
                      (env) => env.id === account.environmentId,
                    )?.engine
                  }
                  environmentsReady={accounts.environmentsReady}
                  pending={pending}
                  failure={
                    failure?.id === account.key ? failure.text : undefined
                  }
                  statisticsOpen={statisticsAccountId === account.id}
                  onAction={(action) => handleAction(account, action)}
                >
                  {account.provider === "weibo" &&
                  statisticsAccountId === account.id ? (
                    <WeiboAccountStatistics accountId={account.id} />
                  ) : null}
                </OtherAccountRow>
              ))}
            </div>
          ) : accounts.ready && !accounts.error ? (
            <div className="website-account-list">
              <Empty
                compact
                title={
                  accounts.data.length
                    ? "没有找到匹配的账号"
                    : "添加第一个平台账号"
                }
                action={
                  <Button
                    primary={!accounts.data.length}
                    onClick={
                      accounts.data.length
                        ? clearFilters
                        : () => setAdding(true)
                    }
                  >
                    {accounts.data.length ? "清除筛选" : "新增账号"}
                  </Button>
                }
              >
                {accounts.data.length
                  ? "试试其他备注或 UID，也可以切换平台查看。"
                  : "选择平台，在官方窗口完成登录后检查登录状态。"}
              </Empty>
            </div>
          ) : null}
        </TabPanel>
      </Tabs>
      <p className="accounts-footnote">
        <ShieldCheck size={15} aria-hidden="true" />
        <span>
          登录会话按浏览器环境保存。移除仅解除本地账号关系，保留环境登录数据与历史记录。
        </span>
      </p>
      <PublishingAccounts environments={accounts.environments} />
      {assigning ? (
        <Dialog
          title="关联浏览器环境"
          onClose={() => setAssigning(null)}
          busy={!!pending}
        >
          <p>
            为“{assigning.alias}
            ”选择运行环境。同一环境可以保持多个不同平台的登录。
          </p>
          <AccountBrowserChoice
            platform={assigning.provider}
            value={targetBrowser}
            onChange={setTargetBrowser}
            environments={accounts.environments}
            disabled={!!pending || !accounts.environmentsReady}
            onConfigure={() => {
              setAssigning(null);
              navigate("browser-environments");
            }}
            existing
          />
          <Notice warning>
            {accounts.environments
              .flatMap((env) => env.accounts)
              .filter(
                (ref) =>
                  ref.identityId ===
                  accounts.environments
                    .flatMap((env) => env.accounts)
                    .find((ref) => ref.id === assigning.id)?.identityId,
              ).length > 1
              ? "共享同一登录身份的关联业务将一起迁移。"
              : ""}
            更换后需要重新检查当前平台身份，已准备的发布任务需要重新填写。原环境登录数据及历史发布记录会保留。请先关闭关联环境的账号网页窗口。
          </Notice>
          {failure?.id === assigning.key ? (
            <Notice danger>{failure.text}</Notice>
          ) : null}
          <div className="dialog-actions">
            <Button onClick={() => setAssigning(null)} disabled={!!pending}>
              取消
            </Button>
            <Button
              primary
              disabled={
                !!pending ||
                !accounts.environmentsReady ||
                !validBrowser(targetBrowser, assigning.provider) ||
                targetBrowser.environmentId === assigning.environmentId
              }
              onClick={() =>
                void run(assigning.key, async () => {
                  await ipc("environments.bind", {
                    kind:
                      assigning.provider === "baidu-zhidao"
                        ? "zhidao"
                        : "website",
                    id: assigning.id,
                    environmentId: targetBrowser.environmentId || undefined,
                    confirmed: true,
                  });
                  setAssigning(null);
                  notify("账号已关联新环境，请检查登录。", "success");
                })
              }
            >
              确认关联
            </Button>
          </div>
        </Dialog>
      ) : null}
      {composerAccount ? (
        <WeiboComposer
          account={composerAccount}
          onClose={() => setComposerAccount(null)}
        />
      ) : null}
      {publishingAccount ? (
        <WeiboPublishingDialog
          account={publishingAccount}
          onClose={() => setPublishingAccount(null)}
          onSaved={() => {
            setPublishingAccount(null);
            accounts.reload();
            notify("微博发布能力已保存。", "success");
          }}
        />
      ) : null}
      {rightsAccount ? (
        <ZhidaoRightsDialog
          account={rightsAccount}
          busy={!!pending}
          error={failure?.id === rightsAccount.key ? failure.text : undefined}
          onClose={() => setRightsAccount(null)}
          onAutomate={() => openAutoAnswer(rightsAccount)}
          onOpen={(page) =>
            void run(rightsAccount.key, async () => {
              await ipc("zhidao.account.openRights", {
                id: rightsAccount.id,
                page,
              });
              notify(
                page === "answer"
                  ? "已打开此账号的官方答题页面，完成后请返回检查资格。"
                  : "已打开此账号的答主工作台，请查看发布额度。",
                "info",
              );
            })
          }
          onCheck={() =>
            void run(rightsAccount.key, async () => {
              const result = await otherAccountActions.check(rightsAccount);
              setRightsAccount(null);
              if ("bulkPermission" in result)
                notify(
                  result.bulkPermission === true
                    ? "已获得快捷答题资格。"
                    : result.bulkPermission === false
                      ? "暂未获得资格，请等待审核或继续按官方要求答题。"
                      : "资格暂时无法确认，请稍后重新检查。",
                  result.bulkPermission === true ? "success" : "warning",
                );
            })
          }
        />
      ) : null}
      {editing ? (
        <Dialog
          title="修改其他账号备注"
          onClose={() => setEditing(null)}
          busy={!!pending}
        >
          <Field label="其他账号备注">
            <input
              aria-label="其他账号备注"
              value={alias}
              maxLength={60}
              onChange={(e) => setAlias(e.target.value)}
            />
          </Field>
          {failure?.id === editing.key ? (
            <Notice danger>{failure.text}</Notice>
          ) : null}
          <Button
            primary
            disabled={!alias.trim() || !!pending}
            onClick={() =>
              void run(editing.key, async () => {
                await otherAccountActions.rename(editing, alias);
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
          title="移除其他账号"
          onClose={() => setRemoving(null)}
          busy={!!pending}
        >
          <Notice warning>
            将移除“{removing.alias}
            ”的本地账号管理关系。环境内的登录数据、其他平台账号、历史任务和已保存结果会保留；正在使用此账号的任务需要先停止。
          </Notice>
          {failure?.id === removing.key ? (
            <Notice danger>{failure.text}</Notice>
          ) : null}
          <div className="dialog-actions">
            <Button onClick={() => setRemoving(null)}>取消</Button>
            <Button
              disabled={!!pending}
              onClick={() =>
                void run(removing.key, async () => {
                  await otherAccountActions.remove(removing);
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

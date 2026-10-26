import { useEffect, useRef, useState } from "react";
import { ipc } from "../api/client";
import { useAppActions, useAppData, useAppNavigation } from "../state";
import { prepareAutoAnswer } from "../zhidao/answer-draft";
import { ZhidaoRightsDialog } from "./ZhidaoRightsDialog";
import { WeiboPublishingDialog } from "./WeiboPublishingDialog";
import { WeiboComposer } from "./WeiboComposer";
import { PublishingAccounts } from "./PublishingAccounts";
import { formatTime } from "../lib/format";
import { Globe, LogIn, Plus } from "lucide-react";
import {
  useOtherAccounts,
  otherAccountActions,
  otherProviderItems,
  otherProviderName,
  type OtherAccount,
  type OtherProvider,
} from "./useOtherAccounts";
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
import {
  clearAccountEnvironment,
  readAccountEnvironment,
} from "./environment-navigation";
import "./website-accounts.css";
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
  const [provider, setProvider] = useState<OtherProvider>(initialProvider);
  const [newAlias, setNewAlias] = useState("");
  const [environmentId, setEnvironmentId] = useState(() =>
    readAccountEnvironment(data!.dataPath),
  );
  useEffect(() => {
    clearAccountEnvironment(data!.dataPath, environmentId);
  }, [data!.dataPath, environmentId]);
  const [assigning, setAssigning] = useState<OtherAccount | null>(null);
  const [targetEnvironmentId, setTargetEnvironmentId] = useState("");
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
  return (
    <div className="website-accounts-workspace">
      <Panel title="连接其他账号">
        <p className="muted">
          这里统一管理微博、百度营销、百度知道等非网盘账号。选择平台后打开官方登录窗口，无需填写用户
          ID；完成扫码后点击“检查登录”。可将不同平台账号关联到同一浏览器环境。
        </p>
        <div className="website-account-add">
          <Field label="账号平台">
            <Select
              aria-label="其他账号平台"
              value={provider}
              onValueChange={(v) => {
                setProvider(v as OtherProvider);
                setCookie("");
              }}
              items={otherProviderItems}
            />
          </Field>
          <Field label="账号备注（可选）">
            <input
              value={newAlias}
              maxLength={60}
              onChange={(e) => setNewAlias(e.target.value)}
              placeholder="例如：运营主账号"
            />
          </Field>
          <Field label="浏览器环境">
            <Select
              aria-label="账号浏览器环境"
              value={environmentId}
              onValueChange={setEnvironmentId}
              items={[
                { value: "", label: "自动新建内置环境" },
                ...accounts.environments.map((env) => ({
                  value: env.id,
                  label: `${env.name} · ${env.engine === "electron" ? "内置" : "比特"}`,
                })),
              ]}
            />
          </Field>
          <Button
            primary
            disabled={
              !!pending ||
              (!!environmentId &&
                !accounts.environments.some((env) => env.id === environmentId))
            }
            onClick={() =>
              void run("add", async () => {
                const account = await otherAccountActions.add(
                  provider,
                  newAlias,
                  cookie,
                  environmentId || undefined,
                );
                setNewAlias("");
                setCookie("");
                accounts.reload();
                try {
                  await otherAccountActions.login(account);
                } catch (cause) {
                  setFailure({
                    id: account.key,
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
        {environmentId ? (
          <p className="muted">
            新账号将关联到“
            {accounts.environments.find((env) => env.id === environmentId)
              ?.name ?? "正在读取的环境"}
            ”。 关联已有账号时，请点击下方账号的“环境”按钮。
          </p>
        ) : null}
        {provider === "baidu-zhidao" ? (
          <details>
            <summary>使用已有 Cookie（可选）</summary>
            <Field label="百度知道 Cookie" hint="仅本次提交，不随表单恢复">
              <input
                type="password"
                autoComplete="off"
                value={cookie}
                onChange={(e) => setCookie(e.target.value)}
                maxLength={20000}
              />
            </Field>
          </details>
        ) : null}
        {failure?.id === "add" ? <Notice danger>{failure.text}</Notice> : null}
      </Panel>
      <Panel
        title="我的其他账号"
        extra={
          <Button quiet disabled={accounts.loading} onClick={accounts.reload}>
            刷新本地状态
          </Button>
        }
      >
        <QueryError
          error={accounts.error}
          loading={accounts.loading}
          onRetry={accounts.reload}
        />
        {!accounts.ready && !accounts.error ? (
          <LoadingState label="正在读取其他账号…" />
        ) : null}
        {accounts.data.length ? (
          <div className="website-account-list">
            {accounts.data.map((account) => (
              <article className="website-account-row" key={account.key}>
                <div className="website-account-identity">
                  <Globe size={22} aria-hidden="true" />
                  <div>
                    <strong>{account.nickname || account.alias}</strong>
                    {account.nickname && account.nickname !== account.alias ? (
                      <small>{account.alias}</small>
                    ) : null}
                    <small>
                      {otherProviderName(account.provider)}
                      {account.uid
                        ? ` · UID ${account.uid}`
                        : " · 尚未识别身份"}
                    </small>
                    <small>
                      环境：
                      {accounts.environments.find(
                        (env) => env.id === account.environmentId,
                      )?.name ?? "正在读取关联环境"}
                    </small>
                  </div>
                </div>
                <div className="website-account-state">
                  <Status
                    kind={account.status === "connected" ? "good" : "warning"}
                  >
                    {account.checking
                      ? "正在核实身份"
                      : account.status === "connected"
                        ? "已识别会话"
                        : account.status === "expired"
                          ? "需重新登录"
                          : "待登录"}
                  </Status>
                  <small
                    role={failure?.id === account.key ? "alert" : undefined}
                  >
                    {failure?.id === account.key
                      ? failure.text
                      : account.message}
                  </small>
                  <small>{account.detail}</small>
                  {account.provider === "weibo" ? (
                    <small>
                      {account.checkedAt
                        ? `上次核实：${formatTime(account.checkedAt)}`
                        : "身份尚未经微博核实"}
                      {account.publishing?.verifiedAt
                        ? " · 已记录发布能力"
                        : " · 发布能力待核实"}
                    </small>
                  ) : null}
                  {account.provider === "baidu-zhidao" &&
                  account.status === "connected" &&
                  account.bulkPermission === false ? (
                    <Notice warning>尚未开通发布权益，需先参与答题。</Notice>
                  ) : null}
                </div>
                <div className="website-account-actions">
                  {account.provider === "weibo" &&
                  account.status === "connected" ? (
                    <>
                      <Button
                        disabled={!!pending || account.checking}
                        onClick={() => setComposerAccount(account)}
                      >
                        发布微博
                      </Button>
                      <Button
                        disabled={!!pending}
                        onClick={() => navigate("weibo-marketing")}
                      >
                        微博图文
                      </Button>
                      <Button
                        quiet
                        disabled={!!pending || account.checking}
                        onClick={() => setPublishingAccount(account)}
                      >
                        发布能力
                      </Button>
                    </>
                  ) : null}
                  {account.provider === "baidu-zhidao" &&
                  account.status === "connected" ? (
                    <Button
                      disabled={!!pending}
                      onClick={() => openAutoAnswer(account)}
                    >
                      自动答题
                    </Button>
                  ) : null}
                  {account.provider === "baidu-zhidao" &&
                  account.status === "connected" &&
                  account.bulkPermission === false ? (
                    <Button
                      primary
                      disabled={!!pending}
                      onClick={() => {
                        setFailure(null);
                        setRightsAccount(account);
                      }}
                    >
                      去获取资格
                    </Button>
                  ) : null}
                  <Button
                    disabled={!!pending}
                    onClick={() =>
                      void run(account.key, () =>
                        otherAccountActions.login(account),
                      )
                    }
                  >
                    <LogIn size={14} />
                    {pending === account.key
                      ? "正在处理…"
                      : account.windowOpen
                        ? "返回登录窗口"
                        : "登录 / 扫码"}
                  </Button>
                  <Button
                    quiet
                    disabled={!!pending || account.checking}
                    onClick={() =>
                      void run(account.key, () =>
                        otherAccountActions.check(account),
                      )
                    }
                  >
                    {account.checking ? "正在核实…" : "检查登录"}
                  </Button>
                  <Button
                    quiet
                    disabled={!!pending}
                    onClick={() => {
                      setAssigning(account);
                      setTargetEnvironmentId(
                        environmentId || account.environmentId || "",
                      );
                    }}
                  >
                    环境
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
        ) : accounts.ready && !accounts.error ? (
          <Empty title="添加第一个其他账号">
            点击“登录新账号”，在官方窗口完成登录。后续新增平台的登录状态也会在这里管理。
          </Empty>
        ) : null}
      </Panel>
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
          <Field label="目标浏览器环境">
            <Select
              aria-label="目标浏览器环境"
              value={targetEnvironmentId}
              onValueChange={setTargetEnvironmentId}
              items={accounts.environments.map((env) => ({
                value: env.id,
                label: env.name,
              }))}
            />
          </Field>
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
                !targetEnvironmentId ||
                targetEnvironmentId === assigning.environmentId
              }
              onClick={() =>
                void run(assigning.key, async () => {
                  await ipc("environments.bind", {
                    kind:
                      assigning.provider === "baidu-zhidao"
                        ? "zhidao"
                        : "website",
                    id: assigning.id,
                    environmentId: targetEnvironmentId,
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

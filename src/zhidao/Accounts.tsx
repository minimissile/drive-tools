import { useState } from "react";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  Panel,
  Status,
} from "../ui/primitives";
import { useIpcQuery } from "../api/useIpcQuery";
import { QueryError } from "../ui/QueryError";
import { Dialog } from "../ui/Dialog";
import { useAppNavigation } from "../state";
import type { ZhidaoAccount } from "../../shared/zhidao";
import { OperationsWorkspace } from "./Workspace";
import { useOperationAction } from "./hooks";
export default function Accounts() {
  const { navigate } = useAppNavigation(),
    action = useOperationAction(),
    accounts = useIpcQuery("zhidao.accounts", undefined, {});
  const [alias, setAlias] = useState(""),
    [cookie, setCookie] = useState(""),
    [removing, setRemoving] = useState<ZhidaoAccount | null>(null),
    [editing, setEditing] = useState<ZhidaoAccount | null>(null),
    [newAlias, setNewAlias] = useState("");
  return (
    <OperationsWorkspace
      title="知道账号"
      description="百度知道与百度网盘分别校验身份和权限，登录会话按账号隔离保存在本机。"
    >
      <Panel title="添加知道账号">
        <div className="operations-form-grid">
          <Field label="账号备注">
            <input
              value={alias}
              maxLength={60}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="例如：知道主账号"
            />
          </Field>
          <div className="operations-actions">
            <Button
              primary
              disabled={!alias.trim() || !!action.pending}
              onClick={() =>
                void action.run(
                  "zhidao.account.add",
                  { alias, cookie: cookie || undefined },
                  () => {
                    setAlias("");
                    setCookie("");
                    accounts.reload();
                  },
                  "账号已添加，请登录并检查",
                )
              }
            >
              添加账号
            </Button>
            <Button quiet onClick={() => navigate("accounts")}>
              管理网盘账号
            </Button>
          </div>
        </div>
        <details>
          <summary>使用已有 Cookie（可选）</summary>
          <Field label="百度知道 Cookie" hint="仅本次提交，不随表单暂存恢复">
            <input
              type="password"
              autoComplete="off"
              value={cookie}
              onChange={(e) => setCookie(e.target.value)}
              maxLength={20000}
            />
          </Field>
        </details>
      </Panel>
      <Panel
        title="我的知道账号"
        extra={
          <Button quiet onClick={accounts.reload}>
            刷新本地列表
          </Button>
        }
      >
        <QueryError
          error={accounts.error}
          loading={accounts.loading}
          onRetry={accounts.reload}
        />
        {!accounts.data && !accounts.error ? (
          <LoadingState label="正在读取知道账号…" />
        ) : accounts.data?.length ? (
          <div className="operation-accounts">
            {accounts.data.map((account) => (
              <article key={account.id}>
                <div>
                  <strong>{account.alias}</strong>
                  <span>{account.nickname || "尚未识别账号身份"}</span>
                  <small>{account.message}</small>
                </div>
                <div>
                  <Status
                    kind={account.status === "connected" ? "good" : "warning"}
                  >
                    {account.status === "connected"
                      ? "登录有效"
                      : account.status === "expired"
                        ? "需要重新登录"
                        : "待登录"}
                  </Status>
                  <small>
                    {account.bulkPermission === null
                      ? "上传资格待检查"
                      : account.bulkPermission
                        ? "具有快捷答题资格"
                        : "暂无快捷答题资格"}
                  </small>
                </div>
                <div className="operation-account-actions">
                  <Button
                    disabled={!!action.pending}
                    onClick={() =>
                      void action.run(
                        "zhidao.account.login",
                        { id: account.id },
                        undefined,
                        "已打开本人登录窗口，完成登录后点击检查账号",
                      )
                    }
                  >
                    登录 / 扫码
                  </Button>
                  <Button
                    disabled={!!action.pending}
                    onClick={() =>
                      void action.run(
                        "zhidao.account.check",
                        { id: account.id },
                        accounts.reload,
                        "账号身份与资格已检查",
                      )
                    }
                  >
                    检查账号
                  </Button>
                  <Button
                    quiet
                    onClick={() => {
                      setEditing(account);
                      setNewAlias(account.alias);
                    }}
                  >
                    备注
                  </Button>
                  <Button quiet onClick={() => setRemoving(account)}>
                    移除
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : accounts.data ? (
          <Empty title="添加第一个百度知道账号">
            添加备注后打开登录窗口，在百度官方页面扫码登录，再回到这里检查。
          </Empty>
        ) : null}
      </Panel>
      {removing ? (
        <Dialog
          title="移除知道账号"
          onClose={() => setRemoving(null)}
          busy={!!action.pending}
        >
          <Notice warning>
            将移除「{removing.alias}
            」的本机登录会话与账号记录。历史任务和结果保留，正在使用此账号的任务需要先停止。
          </Notice>
          <div className="dialog-actions">
            <Button onClick={() => setRemoving(null)}>取消</Button>
            <Button
              disabled={!!action.pending}
              onClick={() =>
                void action.run(
                  "zhidao.account.remove",
                  { id: removing.id, confirmed: true },
                  () => {
                    setRemoving(null);
                    accounts.reload();
                  },
                  "账号已移除",
                )
              }
            >
              确认移除
            </Button>
          </div>
        </Dialog>
      ) : null}
      {editing ? (
        <Dialog
          title="修改账号备注"
          onClose={() => setEditing(null)}
          busy={!!action.pending}
        >
          <Field label="新备注">
            <input
              value={newAlias}
              maxLength={60}
              onChange={(e) => setNewAlias(e.target.value)}
            />
          </Field>
          <Button
            primary
            disabled={!newAlias.trim() || !!action.pending}
            onClick={() =>
              void action.run(
                "zhidao.account.update",
                { id: editing.id, alias: newAlias },
                () => {
                  setEditing(null);
                  accounts.reload();
                },
                "备注已更新",
              )
            }
          >
            保存备注
          </Button>
        </Dialog>
      ) : null}
    </OperationsWorkspace>
  );
}

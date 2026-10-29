import { useEffect, useRef, useState } from "react";
import { Globe, Plus, Settings2 } from "lucide-react";
import { useIpcQuery } from "../api/useIpcQuery";
import { ipc } from "../api/client";
import { useAppActions, useAppData, useAppNavigation } from "../state";
import {
  Button,
  Empty,
  LoadingState,
  Notice,
  Panel,
  Status,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Dialog } from "../ui/Dialog";
import type {
  BrowserEnvironment,
  BrowserEnvironmentView,
} from "../../shared/browser-environments";
import { platformSpecs } from "../../shared/platforms";
import {
  documentPlatformSpecs,
  isDocumentProvider,
} from "../../shared/document-platforms";
import "./browser-environments.css";
import { EnvironmentEditor } from "./EnvironmentEditor";
import { EnvironmentJobs } from "./EnvironmentJobs";
import { prepareEnvironmentAccounts } from "./environment-navigation";
import { BitBrowserWindows } from "./BitBrowserWindows";
import type { BitBrowserProfile } from "../../shared/bitbrowser";

export const environmentEngineLabel = (engine: BrowserEnvironment["engine"]) =>
  engine === "electron" ? "内置浏览器" : "比特浏览器";
const platformName = (id: string) =>
  (isDocumentProvider(id) ? documentPlatformSpecs[id].name : undefined) ??
  { "baidu-marketing": "百度营销", "baidu-zhidao": "百度知道" }[id] ??
  platformSpecs.find((p) => p.id === id)?.name ??
  id;

export default function BrowserEnvironments() {
  const query = useIpcQuery("environments.list", undefined, {
    keepPrevious: true,
    refreshInterval: 2500,
  });
  const { navigate } = useAppNavigation(),
    { notify } = useAppActions();
  const { data } = useAppData();
  const editorTrigger = useRef<HTMLButtonElement | null>(null);
  const [importing, setImporting] = useState<
    (BitBrowserProfile & { connectorKey: string }) | undefined
  >();
  const [editing, setEditing] = useState<BrowserEnvironment | "new" | null>(
      null,
    ),
    [removing, setRemoving] = useState<BrowserEnvironmentView | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (editing !== null || !editorTrigger.current) return;
    const trigger = editorTrigger.current;
    const frame = requestAnimationFrame(() => {
      if (trigger.isConnected) {
        trigger.focus({ preventScroll: true });
        trigger.scrollIntoView({ block: "center" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [editing]);
  return (
    <div className="website-accounts-workspace">
      <BitBrowserWindows
        environments={query.data}
        onChanged={query.reload}
        onImport={(profile, trigger) => {
          editorTrigger.current = trigger;
          setImporting(profile);
          setEditing("new");
          setError("");
        }}
      />
      <Panel
        title="已登记环境"
        extra={
          <Button
            primary
            onClick={(event) => {
              editorTrigger.current = event.currentTarget;
              setImporting(undefined);
              setEditing("new");
              setError("");
            }}
            disabled={editing !== null}
          >
            <Plus size={16} />
            新建环境
          </Button>
        }
      >
        <p className="muted">
          一组跨平台账号共用一个环境。不同环境分别保存登录状态、代理和浏览器配置。
        </p>
        {error && !removing ? <Notice danger>{error}</Notice> : null}
        <QueryError
          error={query.error}
          loading={query.loading}
          onRetry={query.reload}
        />
        {!query.data && !query.error ? (
          <LoadingState label="正在读取浏览器环境…" />
        ) : null}
        {query.data?.length ? (
          <div className="environment-list">
            {query.data.map((env) => (
              <article className="environment-row" key={env.id}>
                <div className="environment-identity">
                  <Globe size={21} aria-hidden="true" />
                  <div>
                    <strong>{env.name}</strong>
                    <small>
                      {environmentEngineLabel(env.engine)} ·{" "}
                      {env.engine === "bitbrowser"
                        ? "代理与指纹由比特配置管理"
                        : env.proxy?.mode === "direct"
                          ? "本机网络 · 原生设备特征"
                          : `${env.proxy?.mode.toUpperCase()} 代理 · 原生设备特征`}
                    </small>
                    <small>
                      {env.requireProxy ? "要求独立代理" : "允许本机网络"}
                      {env.network?.revision === env.revision
                        ? ` · 上次出口 ${env.network.ip}`
                        : " · 出口待检查"}
                    </small>
                    <Status kind={env.busy ? "warning" : "normal"}>
                      {env.busy ? "操作进行中" : "本地配置已登记"}
                    </Status>
                  </div>
                </div>
                <div className="environment-accounts">
                  {env.accounts.length ? (
                    env.accounts.map((account) => (
                      <div key={`${account.kind}:${account.id}`}>
                        <span>{platformName(account.platform)}</span>
                        <strong>{account.alias}</strong>
                      </div>
                    ))
                  ) : (
                    <span className="muted">尚未关联平台账号</span>
                  )}
                </div>
                <div className="environment-actions">
                  <Button
                    quiet
                    disabled={env.busy || pending}
                    onClick={() => {
                      setPending(true);
                      setError("");
                      void ipc("environments.checkNetwork", { id: env.id })
                        .then(() => {
                          query.reload();
                          notify("环境出口已核实。", "success");
                        })
                        .catch((cause) => setError(cause.message))
                        .finally(() => setPending(false));
                    }}
                  >
                    检查网络
                  </Button>
                  <Button
                    quiet
                    disabled={env.busy || !!editing}
                    onClick={(event) => {
                      editorTrigger.current = event.currentTarget;
                      setImporting(undefined);
                      setEditing(env);
                      setError("");
                    }}
                  >
                    <Settings2 size={14} />
                    编辑
                  </Button>
                  <Button
                    quiet
                    onClick={() => {
                      prepareEnvironmentAccounts(data!.dataPath, env.id);
                      navigate("website-accounts");
                    }}
                  >
                    关联账号
                  </Button>
                  <Button
                    quiet
                    disabled={env.busy || env.accounts.length > 0}
                    onClick={() => {
                      setRemoving(env);
                      setError("");
                    }}
                  >
                    移除配置
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : query.data && !query.error ? (
          <Empty title="创建第一个浏览器环境">
            先接入已有指纹配置，或创建内置浏览器环境，再为不同平台添加账号。
          </Empty>
        ) : null}
      </Panel>
      {editing ? (
        <EnvironmentEditor
          key={editing === "new" ? (importing?.id ?? "new") : editing.id}
          environment={editing === "new" ? null : editing}
          initialProfile={editing === "new" ? importing : undefined}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            query.reload();
          }}
        />
      ) : null}
      <EnvironmentJobs environments={query.data ?? []} />
      {removing ? (
        <Dialog
          title="移除浏览器环境配置"
          busy={pending}
          onClose={() => setRemoving(null)}
        >
          <p>
            将移除“{removing.name}
            ”在盘序的登记。浏览器登录数据和比特客户端配置会保留。
          </p>
          {error ? <Notice danger>{error}</Notice> : null}
          <div className="dialog-actions">
            <Button disabled={pending} onClick={() => setRemoving(null)}>
              取消
            </Button>
            <Button
              disabled={pending}
              onClick={() => {
                setPending(true);
                void ipc("environments.remove", {
                  id: removing.id,
                  confirmed: true,
                })
                  .then(() => {
                    setRemoving(null);
                    query.reload();
                    notify("环境配置已移除。", "success");
                  })
                  .catch((cause) => setError(cause.message))
                  .finally(() => setPending(false));
              }}
            >
              确认移除配置
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

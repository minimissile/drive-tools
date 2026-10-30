import { useEffect, useId, useRef, useState } from "react";
import { Link2, Save } from "lucide-react";
import { z } from "zod";
import type { ResourceLinkSettings } from "../../shared/resource-links";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppActions, useAppData } from "../state";
import { QueryError } from "../ui/QueryError";
import { Switch } from "../ui/Switch";
import {
  Button,
  Field,
  LoadingState,
  Notice,
  Panel,
  Status,
} from "../ui/primitives";
import "./resource-links-settings.css";

const parseDraft = (value: unknown) =>
  z.object({ enabled: z.boolean(), baseUrl: z.string() }).parse(value);

export function ResourceLinksSettings() {
  const { data } = useAppData();
  const query = useIpcQuery("resourceLinks.settings", undefined, {
    keepPrevious: true,
  });
  return (
    <Panel title="资源固定入口" className="resource-links-settings">
      <p className="muted">
        为资源保存一个固定领取地址。网盘分享更换后，更新入口的目标即可继续使用原地址。
      </p>
      <QueryError
        title="固定入口配置读取失败"
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
      />
      {!query.data && query.loading ? (
        <LoadingState compact label="正在读取固定入口配置…" />
      ) : null}
      {query.data ? (
        <ResourceLinksForm
          key={data!.dataPath}
          workspace={data!.dataPath}
          settings={query.data}
          reading={query.loading}
          readError={!!query.error}
        />
      ) : null}
    </Panel>
  );
}

function ResourceLinksForm({
  workspace,
  settings,
  reading,
  readError,
}: {
  workspace: string;
  settings: ResourceLinkSettings;
  reading: boolean;
  readError: boolean;
}) {
  const { notify } = useAppActions();
  const [saved, setSaved] = useState(settings);
  const draft = useLocalDraft(
    `panxu-resource-links-v1:${workspace}`,
    { enabled: settings.enabled, baseUrl: settings.baseUrl },
    parseDraft,
  );
  // Credentials are deliberately excluded from the persisted non-secret draft.
  const [token, setToken] = useState("");
  const [pending, setPending] = useState<"save" | "check" | null>(null);
  const [connection, setConnection] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  const alive = useRef(true);
  const switchId = useId();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setSaved(settings);
  }, [settings]);
  const dirty =
    draft.value.enabled !== saved.enabled ||
    draft.value.baseUrl.trim() !== saved.baseUrl ||
    !!token.trim();
  const disabled = !!pending || reading || readError;
  const needsConfiguration =
    draft.value.enabled &&
    (!draft.value.baseUrl.trim() || (!saved.configured && !token.trim()));
  const save = async () => {
    if (lock.current || disabled || !dirty || needsConfiguration) return;
    lock.current = true;
    setPending("save");
    setError("");
    setConnection("");
    try {
      const next = await ipc("resourceLinks.configure", {
        enabled: draft.value.enabled,
        baseUrl: draft.value.baseUrl.trim(),
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      if (!alive.current) return;
      setSaved(next);
      setToken("");
      draft.update({ enabled: next.enabled, baseUrl: next.baseUrl });
      draft.clear();
      notify("固定入口配置已保存。", "success");
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : "配置保存失败，请重试。",
        );
    } finally {
      lock.current = false;
      if (alive.current) setPending(null);
    }
  };
  const check = async () => {
    if (
      lock.current ||
      disabled ||
      dirty ||
      !saved.configured ||
      !saved.baseUrl
    )
      return;
    lock.current = true;
    setPending("check");
    setError("");
    setConnection("");
    try {
      const result = await ipc("resourceLinks.checkConnection");
      if (alive.current) setConnection(result.message);
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : "连接检查失败，请重试。",
        );
    } finally {
      lock.current = false;
      if (alive.current) setPending(null);
    }
  };
  return (
    <div className="resource-links-settings-form">
      <div className="resource-links-auto">
        <div>
          <label htmlFor={switchId}>新资源入库时自动创建固定入口</label>
          <p>只对后续录入的资源生效。已有资源可在资源详情中创建。</p>
        </div>
        <Switch
          id={switchId}
          checked={draft.value.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) => {
            setConnection("");
            draft.update({ enabled });
          }}
        />
      </div>
      <Field
        label="领取页服务地址"
        hint="填写部署后的服务根地址，以 https:// 开头"
      >
        <input
          type="url"
          aria-label="领取页服务地址"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://your-service.workers.dev"
          value={draft.value.baseUrl}
          disabled={disabled}
          onChange={(event) => {
            setConnection("");
            draft.update({ baseUrl: event.target.value });
          }}
        />
      </Field>
      <Field
        label={saved.configured ? "更换管理令牌（可选）" : "管理令牌"}
        hint={
          saved.configured
            ? "留空保留已保存令牌；新令牌不会暂存"
            : "使用领取页服务的管理令牌，仅在本机加密保存"
        }
      >
        <input
          type="password"
          aria-label="固定入口管理令牌"
          autoComplete="new-password"
          spellCheck={false}
          value={token}
          disabled={disabled}
          placeholder={
            saved.configured ? "留空保留现有令牌" : "填写服务的管理令牌"
          }
          maxLength={512}
          onChange={(event) => {
            setConnection("");
            setToken(event.target.value);
          }}
        />
      </Field>
      <div className="resource-links-credential">
        <Status kind={saved.configured ? "good" : "normal"}>
          {saved.configured ? "令牌已保存" : "尚未保存令牌"}
        </Status>
        {saved.maskedToken ? <span>{saved.maskedToken}</span> : null}
      </div>
      {needsConfiguration ? (
        <p className="resource-links-settings-hint">
          启用前请填写服务地址与管理令牌。
        </p>
      ) : null}
      {connection ? (
        <p className="resource-links-connection good-text" role="status">
          {connection}
        </p>
      ) : null}
      {error || draft.error ? (
        <Notice danger>{error || draft.error}</Notice>
      ) : null}
      <footer className="resource-links-settings-actions">
        <div>
          <Button
            disabled={disabled || dirty || !saved.configured || !saved.baseUrl}
            title={dirty ? "请先保存当前配置再检查连接" : undefined}
            onClick={() => void check()}
          >
            <Link2 size={14} />
            {pending === "check" ? "正在检查…" : "检查连接"}
          </Button>
          <small>
            {dirty
              ? "先保存配置，再检查连接。"
              : "只检查服务连接，不创建入口。"}
          </small>
        </div>
        <Button
          primary
          disabled={disabled || !dirty || needsConfiguration}
          onClick={() => void save()}
        >
          <Save size={14} />
          {pending === "save" ? "正在保存…" : "保存固定入口配置"}
        </Button>
      </footer>
    </div>
  );
}

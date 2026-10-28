import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ipc } from "../api/client";
import { useAppActions, useAppData } from "../state";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { Button, Field, Notice, Panel } from "../ui/primitives";
import { Select } from "../ui/Select";
import { TextSuggestions } from "../ui/TextSuggestions";
import { CheckboxField } from "../ui/CheckboxField";
import type { BrowserEnvironment } from "../../shared/browser-environments";
import type { BitBrowserProfile } from "../../shared/bitbrowser";

const formSchema = z.object({
  name: z.string(),
  engine: z.enum(["electron", "bitbrowser"]),
  profileId: z.string(),
  connectorKey: z.string().default(""),
  proxyMode: z.enum(["direct", "http", "socks5"]),
  host: z.string(),
  port: z.string(),
});
export function EnvironmentEditor({
  environment,
  initialProfile,
  onSaved,
  onCancel,
}: {
  environment: BrowserEnvironment | null;
  initialProfile?: BitBrowserProfile & { connectorKey: string };
  onSaved(): void;
  onCancel(): void;
}) {
  const { data } = useAppData(),
    { notify } = useAppActions();
  const proxy = environment?.proxy;
  const draft = useLocalDraft(
    `browser-environment:${data!.dataPath}:${environment?.id ?? (initialProfile ? `${encodeURIComponent(initialProfile.connectorKey)}:${initialProfile.id}` : "new")}`,
    {
      name: environment?.name ?? initialProfile?.name.slice(0, 80) ?? "",
      engine: environment?.engine ?? "bitbrowser",
      connectorKey:
        environment?.connectorKey ??
        initialProfile?.connectorKey ??
        data!.settings.bitUrl,
      profileId:
        environment?.engine === "bitbrowser"
          ? environment.profileId
          : (initialProfile?.id ?? ""),
      proxyMode: proxy?.mode ?? "direct",
      host: proxy && proxy.mode !== "direct" ? proxy.host : "",
      port: proxy && proxy.mode !== "direct" ? String(proxy.port) : "",
    },
    (value) => formSchema.parse(value),
  );
  const form = draft.value;
  // Existing environments have an authoritative persisted source, including when
  // restoring an edit draft written before connectorKey was part of the form.
  const profileConnector = environment
    ? environment.connectorKey || data!.settings.bitUrl
    : form.connectorKey;
  const connectorChanged =
    form.engine === "bitbrowser" &&
    !!form.profileId &&
    (!profileConnector || profileConnector !== data!.settings.bitUrl);
  const [requireProxy, setRequireProxy] = useState(
    environment?.requireProxy ?? true,
  );
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [clearCredentials, setClearCredentials] = useState(false);
  const [windows, setWindows] = useState<{ id: string; name: string }[]>([]),
    [pending, setPending] = useState(""),
    [error, setError] = useState("");
  const lock = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameInput.current?.focus({ preventScroll: true });
    nameInput.current?.closest("section")?.scrollIntoView({ block: "start" });
  }, []);
  const save = async () => {
    if (lock.current) return;
    lock.current = true;
    setPending("save");
    setError("");
    try {
      await ipc("environments.save", {
        id: environment?.id,
        expectedRevision: environment?.revision,
        expectedConnectorKey:
          form.engine === "bitbrowser" ? profileConnector : undefined,
        requireProxy,
        name: form.name,
        engine: form.engine,
        ...(form.engine === "bitbrowser"
          ? { profileId: form.profileId }
          : {
              proxy:
                form.proxyMode === "direct"
                  ? { mode: "direct" }
                  : {
                      mode: form.proxyMode,
                      host: form.host,
                      port: Number(form.port),
                    },
              ...(username || password
                ? { proxyUsername: username, proxyPassword: password }
                : {}),
              clearProxyCredentials: clearCredentials,
            }),
      });
      draft.clear();
      setUsername("");
      setPassword("");
      notify("浏览器环境已保存。", "success");
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "环境未保存，请重试。");
    } finally {
      lock.current = false;
      setPending("");
    }
  };
  return (
    <Panel
      title={
        environment
          ? "编辑浏览器环境"
          : initialProfile
            ? "接入比特浏览器窗口"
            : "新建浏览器环境"
      }
    >
      <p className="muted">
        同一环境可以登录多个不同平台。代理与浏览器配置由环境统一管理。
      </p>
      <div className="environment-form">
        <Field label="环境名称">
          <input
            ref={nameInput}
            value={form.name}
            maxLength={80}
            onChange={(e) => draft.update({ name: e.target.value })}
            placeholder="例如：内容运营 A"
          />
        </Field>
        <Field label="浏览器引擎">
          <Select
            aria-label="浏览器引擎"
            value={form.engine}
            disabled={!!environment || !!initialProfile}
            onValueChange={(engine) => {
              draft.update({ engine: engine as typeof form.engine });
              setUsername("");
              setPassword("");
            }}
            items={[
              { value: "bitbrowser", label: "比特浏览器 · 指纹环境" },
              { value: "electron", label: "内置浏览器 · 会话隔离" },
            ]}
          />
        </Field>
        {form.engine === "bitbrowser" ? (
          <>
            <Field label="比特浏览器配置">
              <TextSuggestions
                aria-label="比特浏览器配置"
                value={form.profileId}
                onValueChange={(profileId) =>
                  draft.update({
                    profileId,
                    connectorKey: data!.settings.bitUrl,
                  })
                }
                disabled={!!environment || !!initialProfile || !!pending}
                placeholder="选择或填写已有配置 ID"
                items={windows.map((item) => ({
                  value: item.id,
                  label: item.name,
                }))}
              />
            </Field>
            {!environment && !initialProfile ? (
              <Button
                disabled={!!pending || !data!.settings.bitUrl}
                onClick={() => {
                  setPending("windows");
                  setError("");
                  void ipc("bit.profiles")
                    .then((result) => {
                      setWindows(result.windows);
                      draft.update({
                        connectorKey: result.connectorKey,
                        profileId:
                          form.connectorKey === result.connectorKey
                            ? form.profileId
                            : "",
                      });
                    })
                    .catch((cause) => setError(cause.message))
                    .finally(() => setPending(""));
                }}
              >
                {pending === "windows" ? "正在读取…" : "读取比特配置"}
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <Field label="网络连接">
              <Select
                aria-label="环境网络连接"
                value={form.proxyMode}
                onValueChange={(mode) => {
                  draft.update({ proxyMode: mode as typeof form.proxyMode });
                  setUsername("");
                  setPassword("");
                }}
                items={[
                  { value: "direct", label: "本机网络" },
                  { value: "http", label: "HTTP 代理" },
                  { value: "socks5", label: "SOCKS5 代理（无需认证）" },
                ]}
              />
            </Field>
            {form.proxyMode !== "direct" ? (
              <>
                <Field label="代理主机">
                  <input
                    value={form.host}
                    onChange={(e) => draft.update({ host: e.target.value })}
                    placeholder="代理域名或 IP"
                  />
                </Field>
                <Field label="代理端口">
                  <input
                    inputMode="numeric"
                    value={form.port}
                    onChange={(e) => draft.update({ port: e.target.value })}
                    placeholder="例如：8080"
                  />
                </Field>
                {form.proxyMode === "http" ? (
                  <>
                    <Field label="代理用户名（可选）">
                      <input
                        autoComplete="off"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                      />
                    </Field>
                    <Field
                      label="代理密码（可选）"
                      hint={
                        environment?.hasProxyCredentials
                          ? "已有凭据，留空继续使用；新凭据不暂存"
                          : "凭据加密保存，不随表单恢复"
                      }
                    >
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </Field>
                  </>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </div>
      {connectorChanged ? (
        <Notice warning>
          此配置 ID
          来自其他或未知的比特连接。请恢复原连接，或重新读取配置后选择窗口；也可重新填写当前服务的配置
          ID。
        </Notice>
      ) : null}
      <CheckboxField
        checked={requireProxy}
        onChange={(event) => setRequireProxy(event.target.checked)}
        label="要求独立代理出口"
        hint="启用后，联网操作前检查实际出口；代理异常或与其他隔离环境出口重复时暂停任务。出口检查使用 ipify。"
      />
      {form.engine === "bitbrowser" ? (
        <Notice>
          在比特客户端为这个配置设置代理和稳定指纹。盘序复用整个环境，不按平台复制配置。
        </Notice>
      ) : (
        <Notice>
          内置浏览器隔离登录数据，并支持环境代理；设备指纹仍受本机影响。需要设备指纹隔离时请选择比特浏览器。
        </Notice>
      )}
      {environment?.hasProxyCredentials && form.engine === "electron" ? (
        <CheckboxField
          checked={clearCredentials}
          onChange={(event) => setClearCredentials(event.target.checked)}
          label="清除已保存的代理凭据"
        />
      ) : null}
      {draft.error || error ? (
        <Notice danger>{error || draft.error}</Notice>
      ) : null}
      <div className="environment-form-actions">
        <Button
          primary
          disabled={
            !!pending ||
            connectorChanged ||
            !form.name.trim() ||
            (form.engine === "bitbrowser" && !form.profileId.trim())
          }
          onClick={() => void save()}
        >
          {pending === "save" ? "正在保存…" : "保存环境"}
        </Button>
        <Button disabled={!!pending} onClick={onCancel}>
          取消
        </Button>
      </div>
    </Panel>
  );
}

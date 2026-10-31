import { useRef, useState } from "react";
import type { NewDriveBrowserPreview } from "../../shared/drive-browser";
import { isBaiduSharedMember } from "../../shared/browser-environment-sharing";
import { useIpcQuery } from "../api/useIpcQuery";
import { ipc } from "../api/client";
import { useAppData, useAppNavigation } from "../state";
import { Button, Empty, Field, Notice } from "../ui/primitives";
import { Select } from "../ui/Select";
import { QueryError } from "../ui/QueryError";
import { LoadingState } from "../ui/DataState";
import { DriveBrowserIdentity } from "./DriveBrowserIdentity";
import "./drive-browser-binding.css";

export function DriveBrowserCreation({
  profileId,
  onProfileChange,
  preview,
  onPreview,
  disabled,
  onBusy,
}: {
  profileId: string;
  onProfileChange(value: string): void;
  preview: NewDriveBrowserPreview | null;
  onPreview(value: NewDriveBrowserPreview | null): void;
  disabled: boolean;
  onBusy(value: boolean): void;
}) {
  const { data } = useAppData();
  const { openSettings } = useAppNavigation();
  const [enabled, setEnabled] = useState(false),
    [requireProxy, setRequireProxy] = useState(true),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const profiles = useIpcQuery("bit.profiles", undefined, {
    enabled,
    keepPrevious: true,
  });
  const environments = useIpcQuery("environments.list", undefined);
  const load = () => {
    onPreview(null);
    setError("");
    if (enabled) profiles.reload();
    else setEnabled(true);
  };
  return (
    <div className="account-create-browser drive-browser-picker">
      <div className="drive-browser-section-heading">
        <h3>选择创建后固定使用的比特环境</h3>
        <Button
          size="compact"
          disabled={disabled || pending || profiles.loading}
          onClick={load}
        >
          {profiles.loading
            ? "正在读取…"
            : enabled
              ? "刷新环境"
              : "读取比特环境"}
        </Button>
      </div>
      <p className="muted">
        选择已登录本人百度网盘的环境，可与贴吧、知道共用。读取并核对账号后创建，创建后不能切换内置浏览器或改绑其他环境。
      </p>
      {!data?.settings.bitUrl ? (
        <Button
          size="compact"
          disabled={disabled || pending}
          onClick={() => openSettings("browser")}
        >
          配置比特连接
        </Button>
      ) : null}
      {profiles.loading && !profiles.data ? (
        <LoadingState compact label="正在读取比特环境…" />
      ) : null}
      <QueryError
        error={profiles.error}
        loading={profiles.loading}
        onRetry={load}
        title="比特环境读取失败"
      />
      {profiles.data ? (
        <>
          {profiles.data.statusError ? (
            <Notice warning>{profiles.data.statusError}</Notice>
          ) : null}
          {profiles.data.windows.length ? (
            <Field label="比特浏览器环境">
              <Select
                value={profileId}
                disabled={
                  disabled || pending || profiles.loading || !!profiles.error
                }
                onValueChange={(v) => {
                  onProfileChange(v);
                  onPreview(null);
                  setError("");
                }}
                items={[
                  { value: "", label: "选择已登录百度网盘的环境" },
                  ...profiles.data.windows.map((p) => {
                    const related =
                      environments.data?.find(
                        (e) =>
                          e.engine === "bitbrowser" && e.profileId === p.id,
                      )?.accounts ?? [];
                    const used = related.some(
                      (a) => a.kind === "drive" || !isBaiduSharedMember(a),
                    );
                    return {
                      value: p.id,
                      label: `${p.seq == null ? "" : `#${p.seq} · `}${p.name}${used ? " · 已关联账号" : related.length ? " · 百度业务共用" : ""}`,
                      disabled: !!used,
                    };
                  }),
                ]}
              />
            </Field>
          ) : (
            <Empty compact title="没有可用的比特环境">
              先在比特客户端创建独立环境并登录百度网盘。
            </Empty>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={requireProxy}
              disabled={disabled || pending}
              onChange={(e) => {
                setRequireProxy(e.target.checked);
                onPreview(null);
                setError("");
              }}
            />
            要求代理并固定出口 IP
          </label>
          <p className="muted">
            要求代理时，请在比特中配置代理并启用网络不通停止打开。不要求代理时仍使用该环境网络，但不保证独立出口。
          </p>
          <Button
            disabled={
              disabled ||
              pending ||
              !profileId ||
              profiles.loading ||
              !!profiles.error
            }
            onClick={async () => {
              if (lock.current) return;
              lock.current = true;
              setPending(true);
              onBusy(true);
              onPreview(null);
              setError("");
              try {
                const result = await ipc("driveBrowser.previewNew", {
                  profileId,
                  connectorKey: profiles.data!.connectorKey,
                  requireProxy,
                });
                setRequireProxy(result.requireProxy);
                onPreview(result);
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "读取登录账号失败，请重试。",
                );
              } finally {
                lock.current = false;
                setPending(false);
                onBusy(false);
              }
            }}
          >
            {pending ? "正在读取登录账号…" : "读取登录账号"}
          </Button>
        </>
      ) : null}
      {error ? <Notice danger>{error}</Notice> : null}
      {preview ? <DriveBrowserIdentity preview={preview} /> : null}
    </div>
  );
}

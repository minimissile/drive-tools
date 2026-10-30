import { useEffect, useRef, useState } from "react";
import { Copy, Link2, Pause, Play, RefreshCw, Settings2 } from "lucide-react";
import type {
  ResourceLink,
  ResourceLinkContext,
} from "../../shared/resource-links";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions, useAppNavigation } from "../state";
import { Dialog } from "../ui/Dialog";
import { QueryError } from "../ui/QueryError";
import {
  Button,
  Field,
  Loading,
  LoadingState,
  Notice,
  Status,
} from "../ui/primitives";
import "./resource-link-panel.css";

function linkStatus(link: ResourceLink) {
  if (link.hasPendingOperation)
    return { label: "待核对", kind: "warning" as const };
  if (link.state === "error")
    return { label: "同步失败", kind: "warning" as const };
  if (link.state === "pending")
    return { label: "待同步", kind: "normal" as const };
  if (!link.enabled) return { label: "已停用", kind: "normal" as const };
  if (!link.targetUrl) return { label: "待绑定分享", kind: "normal" as const };
  return { label: "已绑定", kind: "good" as const };
}

/** A resource's durable entry is maintained separately from its saved drive share. */
export function ResourceLinkPanel({
  resourceId,
  revision,
}: {
  resourceId: string;
  revision?: unknown;
}) {
  const { notify } = useAppActions();
  const { openSettings } = useAppNavigation();
  const query = useIpcQuery(
    "resourceLinks.get",
    { resourceId },
    {
      revision,
      keepPrevious: true,
    },
  );
  const [context, setContext] = useState<ResourceLinkContext | null>(null);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [needsRead, setNeedsRead] = useState(false);
  const [editing, setEditing] = useState(false);
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!query.data) return;
    setContext(query.data);
    setNeedsRead(false);
  }, [query.data]);
  const current = context ?? query.data;
  const link = current?.link;
  const status =
    needsRead || query.error
      ? { label: "结果待核对", kind: "warning" as const }
      : link
        ? linkStatus(link)
        : null;
  const disabled = !!pending || query.loading || !!query.error || needsRead;
  const configured =
    !!current?.settings.configured && !!current.settings.baseUrl;
  const unresolved = !!link?.hasPendingOperation;
  const requestMissing = unresolved && !!link?.requestMissing;
  const canMaintain = configured && !disabled && !unresolved;
  const mutate = async (
    action: string,
    request: () => Promise<ResourceLinkContext>,
    message: string,
  ) => {
    if (lock.current || disabled) return false;
    lock.current = true;
    setPending(action);
    setError("");
    try {
      const next = await request();
      if (!alive.current) return false;
      setContext(next);
      const incomplete =
        next.link?.hasPendingOperation || next.link?.state !== "synced";
      notify(
        incomplete ? "入口尚未同步完成，可在此继续核对。" : message,
        incomplete ? "warning" : "success",
      );
      return true;
    } catch (cause) {
      if (alive.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : "入口操作未完成，请重新读取状态。",
        );
        setNeedsRead(true);
        // Read local state after a failed request; never automatically replay a cloud write.
        query.reload();
      }
      return false;
    } finally {
      lock.current = false;
      if (alive.current) setPending("");
    }
  };
  const copy = async () => {
    if (
      lock.current ||
      disabled ||
      !link ||
      link.state !== "synced" ||
      unresolved
    )
      return;
    lock.current = true;
    setPending("copy");
    setError("");
    try {
      const result = await ipc("resourceLinks.copy", { resourceId });
      await ipc("system.copyText", { text: result.text });
      if (alive.current) notify("固定入口已复制。", "success");
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : "复制失败，请重试。");
    } finally {
      lock.current = false;
      if (alive.current) setPending("");
    }
  };
  const issue = !query.error
    ? error ||
      (requestMissing
        ? "原同步参数未随备份恢复，可读取云端并安全停用此入口后继续维护。"
        : link?.error)
    : "";
  return (
    <section
      className="resource-link-panel"
      aria-label="固定入口"
      aria-busy={!!pending || query.loading}
    >
      <div className="resource-link-heading">
        <h3>固定入口</h3>
        {status ? <Status kind={status.kind}>{status.label}</Status> : null}
      </div>
      <QueryError
        title="固定入口读取失败"
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
      />
      {!current && query.loading ? (
        <LoadingState compact label="正在读取固定入口…" />
      ) : null}
      {current ? (
        <>
          {!configured ? (
            <div className="resource-link-setup">
              <p>配置领取页服务后，即可为资源创建固定入口。</p>
              <Button
                quiet
                size="compact"
                onClick={() => openSettings("resource-links")}
              >
                <Settings2 size={14} />
                前往设置
              </Button>
            </div>
          ) : null}
          {link ? (
            <>
              <div className="link-box resource-link-url">{link.url}</div>
              <div className="resource-link-copy-row">
                <Button
                  size="compact"
                  disabled={
                    disabled ||
                    unresolved ||
                    link.state !== "synced" ||
                    !link.enabled
                  }
                  onClick={() => void copy()}
                >
                  <Copy size={13} />
                  复制入口
                </Button>
                {link.syncedAt ? (
                  <time
                    dateTime={link.syncedAt}
                    title={new Date(link.syncedAt).toLocaleString("zh-CN")}
                  >
                    {new Date(link.syncedAt).toLocaleString("zh-CN", {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    同步
                  </time>
                ) : null}
              </div>
              <p className="resource-link-target">
                {!link.enabled
                  ? "入口已停用，访客暂时无法领取。"
                  : link.targetUrl
                    ? "当前目标"
                    : "分享准备好后可绑定，入口地址保持不变。"}
                {link.targetUrl ? (
                  <span>
                    {link.targetUrl}
                    {link.code ? ` · 提取码：${link.code}` : ""}
                  </span>
                ) : null}
              </p>
              {unresolved && !issue ? (
                <p className="resource-link-warning">
                  上次同步结果待核对。可重试同一次操作，或读取云端当前状态。
                </p>
              ) : null}
              {configured ? (
                <div className="resource-link-actions">
                  {requestMissing ? (
                    <Button
                      size="compact"
                      disabled={disabled}
                      onClick={() =>
                        void mutate(
                          "recover",
                          () => ipc("resourceLinks.recover", { resourceId }),
                          "固定入口已停用，可继续维护。",
                        )
                      }
                    >
                      恢复维护并停用
                    </Button>
                  ) : unresolved || link.state !== "synced" ? (
                    <Button
                      size="compact"
                      disabled={disabled}
                      onClick={() =>
                        void mutate(
                          "retry",
                          () => ipc("resourceLinks.retry", { resourceId }),
                          "固定入口已同步。",
                        )
                      }
                    >
                      重试同步
                    </Button>
                  ) : null}
                  {unresolved || link.state !== "synced" || !!error ? (
                    <Button
                      quiet
                      size="compact"
                      disabled={disabled}
                      onClick={() =>
                        void mutate(
                          "refresh",
                          () => ipc("resourceLinks.refresh", { resourceId }),
                          "已读取云端当前状态。",
                        )
                      }
                    >
                      读取云端状态
                    </Button>
                  ) : null}
                  {!unresolved ? (
                    <>
                      <Button
                        quiet
                        size="compact"
                        disabled={
                          !canMaintain ||
                          !current.currentShareUrl ||
                          !!current.currentTargetIssue
                        }
                        title={current.currentTargetIssue ?? undefined}
                        onClick={() =>
                          void mutate(
                            "current",
                            () =>
                              ipc("resourceLinks.useCurrent", { resourceId }),
                            "固定入口已绑定当前本人分享。",
                          )
                        }
                      >
                        绑定当前本人分享
                      </Button>
                      <Button
                        quiet
                        size="compact"
                        disabled={!canMaintain}
                        onClick={() => {
                          setError("");
                          setEditing(true);
                        }}
                      >
                        更换目标
                      </Button>
                      <Button
                        quiet
                        size="compact"
                        disabled={!canMaintain}
                        onClick={() =>
                          void mutate(
                            "enabled",
                            () =>
                              ipc("resourceLinks.setEnabled", {
                                resourceId,
                                enabled: !link.enabled,
                              }),
                            link.enabled
                              ? "固定入口已停用。"
                              : "固定入口已启用。",
                          )
                        }
                      >
                        {link.enabled ? (
                          <Pause size={13} />
                        ) : (
                          <Play size={13} />
                        )}
                        {link.enabled ? "停用入口" : "启用入口"}
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : configured ? (
            <div className="resource-link-setup">
              <p>此资源尚未创建固定入口。可以先创建，稍后绑定网盘分享。</p>
              <Button
                size="compact"
                disabled={disabled}
                onClick={() =>
                  void mutate(
                    "ensure",
                    () => ipc("resourceLinks.ensure", { resourceId }),
                    "固定入口已创建。",
                  )
                }
              >
                {" "}
                <Link2 size={14} />
                创建固定入口
              </Button>
            </div>
          ) : null}
          {configured &&
          !unresolved &&
          current.currentTargetIssue &&
          (!link || !link.targetUrl) ? (
            <p className="resource-link-note">{current.currentTargetIssue}</p>
          ) : null}
        </>
      ) : null}
      {issue && !editing ? (
        <p className="resource-link-warning" role="alert">
          {issue}
        </p>
      ) : null}
      {pending ? (
        <Loading
          label={
            pending === "copy"
              ? "正在复制入口…"
              : pending === "refresh"
                ? "正在读取云端状态…"
                : pending === "recover"
                  ? "正在恢复维护并停用…"
                  : "正在同步入口…"
          }
        />
      ) : null}
      {editing && current && link ? (
        <TargetDialog
          targetUrl={link.targetUrl ?? ""}
          initialCode={link.code}
          busy={!!pending}
          disabled={!canMaintain}
          error={error || query.error}
          onClose={() => setEditing(false)}
          onSave={async (text, code) => {
            if (
              await mutate(
                "target",
                () =>
                  ipc("resourceLinks.setTarget", {
                    resourceId,
                    text,
                    ...(code ? { code } : {}),
                  }),
                "固定入口目标已更新。",
              )
            )
              setEditing(false);
          }}
        />
      ) : null}
    </section>
  );
}

function TargetDialog({
  targetUrl,
  initialCode,
  busy,
  disabled,
  error,
  onClose,
  onSave,
}: {
  targetUrl: string;
  initialCode: string;
  busy: boolean;
  disabled: boolean;
  error: string;
  onClose(): void;
  onSave(text: string, code: string): Promise<void>;
}) {
  const [text, setText] = useState(targetUrl);
  const [code, setCode] = useState(initialCode);
  return (
    <Dialog
      title="更换固定入口目标"
      className="resource-link-target-dialog"
      busy={busy}
      onClose={onClose}
      footer={
        <Button
          primary
          disabled={disabled || !text.trim()}
          onClick={() => void onSave(text.trim(), code.trim())}
        >
          <RefreshCw size={14} />
          {busy ? "正在更新…" : "更新入口目标"}
        </Button>
      }
    >
      <p className="muted">固定入口地址保持不变，领取页将使用新的网盘分享。</p>
      <Field label="网盘分享链接" hint="可粘贴包含提取码的完整分享文字">
        <textarea
          aria-label="新的网盘分享链接"
          rows={3}
          value={text}
          disabled={busy}
          onChange={(event) => {
            setText(event.target.value);
            // A new share must not inherit the previous target's extraction code.
            setCode("");
          }}
        />
      </Field>
      <Field label="提取码（可选）">
        <input
          aria-label="新的分享提取码"
          autoComplete="off"
          value={code}
          disabled={busy}
          onChange={(event) => setCode(event.target.value)}
        />
      </Field>
      {error ? (
        <Notice danger>{error}</Notice>
      ) : disabled && !busy ? (
        <Notice warning>请先在资源详情中恢复入口状态，再更新目标。</Notice>
      ) : null}
    </Dialog>
  );
}

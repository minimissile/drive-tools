import { useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { Button } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import "./dev-updates.css";

export function DevUpdateBanner() {
  const enabled = import.meta.env.DEV && !!window.panxu?.windowId;
  const update = useIpcQuery("dev.updates", undefined, {
    enabled,
    keepPrevious: true,
    refreshInterval: 1500,
  });
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState("");
  const locked = useRef(false);
  if (!enabled) return null;
  const state = update.data;
  // Older supervisors have no update state until the one-time service restart.
  if (!state)
    return update.error ? (
      <div className="dev-update-banner">
        <QueryError
          title="开发更新状态读取失败"
          error={update.error}
          loading={update.loading}
          onRetry={update.reload}
        />
      </div>
    ) : null;
  if (
    !state.pending &&
    !state.buildError &&
    !state.applying &&
    !update.error &&
    !actionError
  )
    return null;
  const busy = submitting || state.applying;
  return (
    <div className="dev-update-banner" aria-label="开发后端更新">
      <div className="dev-update-summary" role="status">
        <strong>
          {busy
            ? "正在应用后端更新…"
            : state.buildError
              ? "后端编译未完成"
              : "后端有更新待应用"}
        </strong>
        <span>
          {busy
            ? "各会话窗口将重新打开。"
            : state.buildError ||
              (state.compiling
                ? "正在编译，当前窗口继续可用。"
                : "继续使用当前后端；应用时会重新打开所有会话窗口。")}
        </span>
        {state.applyError && !busy ? (
          <span className="dev-update-reason">{state.applyError}</span>
        ) : null}
      </div>
      <Button
        size="compact"
        disabled={
          busy || state.compiling || !!state.buildError || !state.pending
        }
        onClick={async () => {
          if (locked.current) return;
          locked.current = true;
          setSubmitting(true);
          setActionError("");
          try {
            await ipc("dev.applyUpdates");
            update.reload();
          } catch (error) {
            setActionError(
              error instanceof Error
                ? error.message
                : "更新请求未发送，请重试。",
            );
          } finally {
            locked.current = false;
            setSubmitting(false);
          }
        }}
      >
        <RotateCw size={14} aria-hidden="true" />
        {busy ? "正在应用…" : "应用更新并重启"}
      </Button>
      <QueryError
        title="开发更新状态读取失败"
        error={update.error || actionError}
        loading={update.loading || submitting}
        onRetry={() => {
          setActionError("");
          update.reload();
        }}
      />
    </div>
  );
}

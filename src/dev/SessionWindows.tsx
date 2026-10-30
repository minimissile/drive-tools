import { useEffect, useState } from "react";
import { AppWindow, Plus, Settings2 } from "lucide-react";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppNavigation } from "../state";
import { useFeedbackActions } from "../state/feedback";
import { pageTitle } from "../navigation";
import { Dialog } from "../ui/Dialog";
import { Button, Field, LoadingState, Status } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import {
  devSessionStatusLabels,
  type DevSession,
} from "../../shared/dev-sessions";
import "./session-windows.css";

function useSessions(enabled: boolean) {
  const current = useIpcQuery("dev.session", undefined, {
    enabled,
    keepPrevious: true,
  });
  const sessions = useIpcQuery("dev.sessions", undefined, {
    enabled,
    keepPrevious: true,
  });
  const { reload: reloadCurrent } = current,
    { reload: reloadSessions } = sessions;
  useEffect(() => {
    if (!enabled) return;
    return window.panxu.onDevSessionsChanged?.(() => {
      reloadCurrent();
      reloadSessions();
    });
  }, [enabled, reloadCurrent, reloadSessions]);
  return { current, sessions };
}

export function SessionWindows() {
  const available = import.meta.env.DEV && !!window.panxu?.windowId;
  const { current, sessions } = useSessions(available);
  const [open, setOpen] = useState(false);
  if (!available) return null;
  const info = current.data;
  return (
    <>
      <Button
        quiet
        size="compact"
        className="session-window-trigger"
        aria-label={
          info
            ? `管理会话窗口：${info.label}，${devSessionStatusLabels[info.status]}${info.session ? `，${info.session}` : ""}`
            : "管理会话窗口"
        }
        aria-haspopup="dialog"
        title={
          info
            ? [devSessionStatusLabels[info.status], info.label, info.session]
                .filter(Boolean)
                .join(" · ")
            : "管理会话窗口"
        }
        onClick={() => setOpen(true)}
      >
        <AppWindow size={15} aria-hidden="true" />
        <span className="session-window-label">
          {info?.label ?? "会话窗口"}
        </span>
        {info ? (
          <span
            className={`session-window-state session-window-state--${info.status}`}
          >
            {info.mode === "development"
              ? "开发中"
              : devSessionStatusLabels[info.status]}
          </span>
        ) : null}
        {info?.session ? (
          <span className="session-window-name">{info.session}</span>
        ) : null}
      </Button>
      {open ? (
        <SessionWindowDialog
          current={info}
          sessions={sessions.data ?? []}
          error={current.error || sessions.error}
          loading={current.loading || sessions.loading}
          retry={() => {
            current.reload();
            sessions.reload();
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function SessionWindowDialog({
  current,
  sessions,
  error,
  loading,
  retry,
  onClose,
}: {
  current: DevSession | null;
  sessions: DevSession[];
  error: string;
  loading: boolean;
  retry(): void;
  onClose(): void;
}) {
  const { page } = useAppNavigation();
  const { notify } = useFeedbackActions();
  const [label, setLabel] = useState(pageTitle(page) ?? "开发工作台");
  const [session, setSession] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } catch (cause) {
      notify(
        cause instanceof Error ? cause.message : "会话窗口操作失败，请重试。",
        "error",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="会话窗口"
      onClose={onClose}
      busy={busy}
      className="session-window-dialog"
    >
      <p className="session-window-description">
        所有窗口共用当前工作空间与登录状态，各自保留页面和未提交输入。
      </p>
      <QueryError error={error} loading={loading} onRetry={retry} />
      <div className="session-window-list" aria-label="已打开的会话">
        {loading && !sessions.length ? (
          <LoadingState label="正在读取会话窗口…" />
        ) : null}
        {sessions.map((item) => (
          <div className="session-window-row" key={item.id}>
            <div className="session-window-row-info">
              <strong>
                {item.label}
                {item.id === current?.id ? "（当前窗口）" : ""}
              </strong>
              <span>{item.session || "未填写会话名称"}</span>
              <Status
                kind={
                  item.status === "failed"
                    ? "danger"
                    : item.status === "passed"
                      ? "good"
                      : item.status === "paused"
                        ? "warning"
                        : "normal"
                }
              >
                {item.mode === "development"
                  ? "开发中"
                  : devSessionStatusLabels[item.status]}
              </Status>
            </div>
            <div className="session-window-row-actions">
              {item.id === current?.id ? (
                <Button
                  quiet
                  size="compact"
                  disabled={busy}
                  onClick={() => {
                    setEditing(true);
                    setLabel(item.label);
                    setSession(item.session);
                  }}
                >
                  <Settings2 size={13} aria-hidden="true" />
                  修改标识
                </Button>
              ) : (
                <Button
                  quiet
                  size="compact"
                  disabled={busy}
                  onClick={() =>
                    void run(() => ipc("dev.session.focus", { id: item.id }))
                  }
                >
                  切换窗口
                </Button>
              )}
              {item.mode === "automation" &&
              ["running", "paused"].includes(item.status) ? (
                <>
                  <Button
                    quiet
                    size="compact"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        ipc("dev.session.update", {
                          id: item.id,
                          status:
                            item.status === "running" ? "paused" : "running",
                          expectedStatus: item.status,
                        }),
                      )
                    }
                  >
                    {item.status === "running" ? "暂停测试" : "继续测试"}
                  </Button>
                  <Button
                    quiet
                    size="compact"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        ipc("dev.session.update", {
                          id: item.id,
                          status: "interrupted",
                        }),
                      )
                    }
                  >
                    手动接管
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <form
        className="session-window-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!label.trim()) return;
          void run(async () => {
            if (editing && current) {
              await ipc("dev.session.update", {
                id: current.id,
                label: label.trim(),
                session: session.trim(),
              });
              setEditing(false);
            } else
              await ipc("dev.session.open", {
                label: label.trim(),
                session: session.trim(),
                mode: "development",
                initialPage: page,
              });
          });
        }}
      >
        <h3>{editing ? "修改当前窗口标识" : "打开新窗口"}</h3>
        <Field label="正在处理的内容" required>
          <input
            value={label}
            maxLength={80}
            required
            onChange={(event) => setLabel(event.target.value)}
            placeholder="例如：资源目录编辑"
          />
        </Field>
        <Field label="所属会话">
          <input
            value={session}
            maxLength={80}
            onChange={(event) => setSession(event.target.value)}
            placeholder="例如：资源清单开发会话"
          />
        </Field>
        <div className="session-window-form-actions">
          {editing ? (
            <Button disabled={busy} onClick={() => setEditing(false)}>
              取消修改
            </Button>
          ) : null}
          <Button type="submit" primary disabled={busy || !label.trim()}>
            {!editing ? <Plus size={14} aria-hidden="true" /> : null}
            {busy ? "正在处理…" : editing ? "保存标识" : "打开窗口"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

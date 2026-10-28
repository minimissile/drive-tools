import { useEffect, useState } from "react";
import { useIpcQuery } from "../api/useIpcQuery";
import { ipc } from "../api/client";
import { Dialog } from "../ui/Dialog";
import { CheckboxField } from "../ui/CheckboxField";
import { Button, LoadingState, Notice } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import type {
  BitBrowserWindow,
  BitProfileCommand,
} from "../../shared/bitbrowser";
import type { BrowserEnvironmentView } from "../../shared/browser-environments";

export function BitBrowserCloseDialog({
  profile,
  command,
  environment,
  onClose,
  onClosed,
}: {
  profile: BitBrowserWindow;
  command: BitProfileCommand;
  environment?: BrowserEnvironmentView;
  onClose(): void;
  onClosed(): void;
}) {
  const query = useIpcQuery("bit.diagnose", command, {
    revision: environment?.revision,
  });
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setConfirmed(false), [environment?.revision]);
  const blocked = environment?.busy || !!query.data?.blockers.length;
  const close = async () => {
    if (pending || blocked || !confirmed || !query.data) return;
    setPending(true);
    setError("");
    try {
      await ipc("bit.closeProfile", {
        ...command,
        confirmed: true,
        expectedRevision: environment?.revision,
      });
      onClosed();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "关闭请求未完成，请刷新窗口状态后核对。",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog title={`关闭“${profile.name}”`} onClose={onClose} busy={pending}>
      <p>
        关闭此比特窗口的全部网页。窗口配置和登录数据会保留；未保存的页面内容可能丢失。
      </p>
      <QueryError
        error={query.error}
        loading={query.loading}
        onRetry={query.reload}
        title="关闭前检查未完成"
      />
      {!query.data && !query.error ? (
        <LoadingState compact label="正在检查业务占用和未完成操作…" />
      ) : null}
      {query.data?.blockers.length ? (
        <Notice warning>{query.data.blockers.join(" ")}</Notice>
      ) : environment?.busy ? (
        <Notice warning>环境任务正在执行或排队，请处理后再关闭。</Notice>
      ) : null}
      {query.data?.pendingOperations.length ? (
        <Notice warning>
          请先核对：{query.data.pendingOperations.join("；")}
          。关闭后需回原业务重新准备，提交结果未知的任务仍须人工核对。
        </Notice>
      ) : null}
      {query.data?.configurationError ? (
        <Notice>
          窗口配置暂不可读；关闭请求仍可发送，实际状态请刷新列表核对。
        </Notice>
      ) : null}
      <CheckboxField
        checked={confirmed}
        disabled={pending || blocked || !query.data}
        onChange={(event) => setConfirmed(event.target.checked)}
        label="我已保存网页内容并核对未完成操作，确认关闭此窗口"
      />
      {error ? <Notice danger>{error}</Notice> : null}
      <div className="dialog-actions">
        <Button disabled={pending} onClick={onClose}>
          取消
        </Button>
        <Button
          primary
          disabled={pending || blocked || !confirmed || !query.data}
          onClick={() => void close()}
        >
          {pending ? "正在请求关闭…" : "确认关闭窗口"}
        </Button>
      </div>
    </Dialog>
  );
}

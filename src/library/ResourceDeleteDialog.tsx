import { useRef, useState } from "react";
import type { Resource } from "../../shared/types";
import type { ResourceDeleteResult } from "../../shared/resource-deletion";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions } from "../state";
import { Dialog } from "../ui/Dialog";
import { QueryError } from "../ui/QueryError";
import { Button, Field, LoadingState, Notice } from "../ui/primitives";

export function ResourceDeleteDialog({
  resource,
  onClose,
  onDeleted,
}: {
  resource: Resource;
  onClose(): void;
  onDeleted(): void;
}) {
  const preview = useIpcQuery(
    "resource.deletePreview",
    {
      resourceId: resource.id,
    },
    { keepPrevious: true },
  );
  const { notify, refresh } = useAppActions();
  const [mode, setMode] = useState<"local" | "remote">("local");
  const [result, setResult] = useState<ResourceDeleteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const progress = result ?? preview.data?.pending ?? null;
  const blockers = preview.data?.blockers ?? [];
  const remoteBlockers = preview.data?.remoteBlockers ?? [];
  const operationMode = progress?.mode ?? mode;
  const canSubmit =
    !!preview.data &&
    !preview.loading &&
    !preview.error &&
    !blockers.length &&
    !busy &&
    (operationMode === "local" || !remoteBlockers.length) &&
    (!progress || progress.state === "pending");
  const run = async (action: "remove" | "recheck") => {
    if (running.current || (action === "remove" && !canSubmit)) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const value =
        action === "recheck" && progress
          ? await ipc("resource.deleteRecheck", {
              operationId: progress.operationId,
            })
          : await ipc("resource.remove", {
              token: progress?.operationId ?? preview.data!.token,
              mode: operationMode,
              confirmed: true,
            });
      setResult(value);
      if (value.state === "deleted") {
        notify(value.message, "success");
        onDeleted();
        void refresh().catch(() => {
          notify(
            "资源已删除，本地视图刷新失败；请重试读取，无需再次删除。",
            "warning",
          );
        });
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "删除未完成，请重新读取状态。",
      );
      // Recover the durable operation before offering another submission.
      preview.reload();
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="删除资源"
      className="resource-delete-dialog"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            {progress ? "稍后处理" : "取消"}
          </Button>
          {progress?.state === "uncertain" ? (
            <Button primary disabled={busy} onClick={() => void run("recheck")}>
              {busy ? "正在核对…" : "只读核对删除结果"}
            </Button>
          ) : (
            <Button
              primary
              disabled={!canSubmit}
              onClick={() => void run("remove")}
            >
              {busy
                ? "正在删除并核对…"
                : progress
                  ? "继续删除剩余副本"
                  : mode === "remote"
                    ? "删除网盘文件与本地记录"
                    : "仅删除本地记录"}
            </Button>
          )}
        </>
      }
    >
      <p className="resource-delete-title">{resource.title}</p>
      <QueryError
        error={preview.error}
        loading={preview.loading}
        onRetry={preview.reload}
      />
      {preview.loading && !preview.data ? (
        <LoadingState label="正在读取删除范围…" compact />
      ) : null}
      {preview.data ? (
        <>
          {!progress ? (
            <Field as="div" label="删除范围">
              <div
                className="resource-delete-scope"
                role="group"
                aria-label="资源删除范围"
              >
                {(
                  [
                    ["local", "仅删除本地记录"],
                    ["remote", "同时删除网盘文件"],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    aria-pressed={mode === value}
                    disabled={busy || !!blockers.length}
                    onClick={() => {
                      setMode(value);
                      setError("");
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </Field>
          ) : null}
          <Notice warning>
            {progress
              ? progress.message
              : mode === "local"
                ? `删除本地资源、${preview.data.copies.length}个账号副本记录及${preview.data.draftCount}份关联草稿。网盘文件保留。`
                : "删除以下所有账号副本对应的网盘文件，再删除本地记录。文件夹包含其中全部内容；此操作不能在盘序内撤销。"}
          </Notice>
          {progress ? (
            <p className="muted">
              关闭后会保留进度。核对只读取网盘结果；全部确认删除后，完成已授权的本地记录删除。
            </p>
          ) : null}
          {blockers.length ? (
            <Notice warning>{blockers.join("；")}</Notice>
          ) : null}
          {operationMode === "remote" && remoteBlockers.length ? (
            <Notice warning>{remoteBlockers.join("；")}</Notice>
          ) : null}
          <div className="resource-delete-copies" aria-label="涉及的账号副本">
            {preview.data.copies.map((copy) => {
              const status = progress?.copies.find(
                (item) => item.copyId === copy.copyId,
              );
              return (
                <section key={copy.copyId}>
                  <div className="resource-delete-copy-heading">
                    <strong>{copy.accountAlias}</strong>
                    {status ? (
                      <span>
                        {
                          {
                            waiting: "尚未提交",
                            uncertain: "待核对",
                            success: "已确认删除",
                          }[status.state]
                        }
                      </span>
                    ) : null}
                  </div>
                  <p className="muted">{copy.directory || "未记录网盘目录"}</p>
                  {copy.files.length ? (
                    <ul>
                      {copy.files.map((file) => (
                        <li key={file.id}>
                          {file.name}
                          {file.isDirectory ? "（含全部子内容）" : ""}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">未记录文件清单</p>
                  )}
                  {!copy.canDeleteRemote ? (
                    <p className="muted">{copy.reason}</p>
                  ) : null}
                  {status?.receipt ? (
                    <p className="muted">{status.receipt.message}</p>
                  ) : null}
                </section>
              );
            })}
          </div>
        </>
      ) : null}
      {error ? <Notice danger>{error}</Notice> : null}
    </Dialog>
  );
}

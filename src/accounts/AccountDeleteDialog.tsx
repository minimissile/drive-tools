import { useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { Account } from "../../shared/types";
import type { AccountDeleteResult } from "../../shared/account-deletion";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions } from "../state";
import { Dialog } from "../ui/Dialog";
import { Pagination } from "../ui/Pagination";
import { QueryError } from "../ui/QueryError";
import { Button, LoadingState, Notice } from "../ui/primitives";

export function AccountDeleteDialog({
  account,
  onClose,
  onDeleted,
  onResource,
}: {
  account: Account;
  onClose(): void;
  onDeleted(result: AccountDeleteResult): void;
  onResource(id: string): void;
}) {
  const preview = useIpcQuery(
    "account.deletePreview",
    { id: account.id },
    { keepPrevious: true },
  );
  const { notify, refresh } = useAppActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [retryToken, setRetryToken] = useState<string | null>(null);
  const lock = useRef(false);
  const data = preview.data;
  const canDelete =
    !busy &&
    (!!retryToken ||
      (!!data && !preview.loading && !preview.error && !data.blockers.length));
  const remove = async () => {
    if (lock.current || !canDelete) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const token = retryToken ?? data!.token;
    try {
      const result = await ipc("account.remove", { token });
      notify(result.message, "success");
      onDeleted(result);
      void refresh().catch(() =>
        notify(
          "账号已删除，界面刷新失败，请重新读取；无需再次删除。",
          "warning",
        ),
      );
    } catch (cause) {
      const code = (cause as { code?: string })?.code;
      const rejected = [
        "ACCOUNT_DELETE_PREVIEW_CHANGED",
        "ACCOUNT_DELETE_PREVIEW_EXPIRED",
        "ACCOUNT_IN_USE",
        "ACCOUNT_RESOURCES_IN_USE",
      ].includes(code ?? "");
      setRetryToken(rejected ? null : token);
      setError(
        cause instanceof Error
          ? cause.message
          : "删除结果暂未确认，请重试上次操作读取结果。",
      );
      if (rejected) preview.reload();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const resources = data?.resources ?? [];
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(resources.length / 6)),
  );
  return (
    <Dialog
      title="删除网盘账号"
      className="account-delete-dialog"
      busy={busy}
      onClose={onClose}
      focus="container"
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!canDelete}
            className="account-delete-submit"
            onClick={() => void remove()}
          >
            <Trash2 size={15} />
            {busy
              ? "正在清理…"
              : retryToken
                ? "重试上次删除"
                : "删除账号及本地记录"}
          </Button>
        </>
      }
    >
      <div className="account-delete-intro">
        <strong>{data?.alias ?? account.alias}</strong>
        <p>
          清理本机账号、登录凭据和关联资源记录。网盘实际文件与已有分享链接保留。
        </p>
      </div>
      <QueryError
        error={retryToken ? "" : preview.error}
        loading={preview.loading}
        onRetry={preview.reload}
        title="删除范围读取失败"
      />
      {!data && preview.loading ? (
        <LoadingState compact label="正在读取关联资源…" />
      ) : null}
      {data ? (
        <>
          <dl className="account-delete-counts">
            <div>
              <dt>移除账号副本</dt>
              <dd>{data.copyCount} 份</dd>
            </div>
            <div>
              <dt>删除本地资源</dt>
              <dd>{resources.filter((r) => r.removeResource).length} 份</dd>
            </div>
            <div>
              <dt>关联未发布稿件</dt>
              <dd>{data.draftCount} 份</dd>
            </div>
          </dl>
          {resources.length ? (
            <>
              <ul className="account-delete-resources">
                {resources
                  .slice((currentPage - 1) * 6, currentPage * 6)
                  .map((r) => (
                    <li key={r.id}>
                      <div>
                        <strong>{r.title}</strong>
                        <small>
                          {r.removeResource
                            ? "删除本地资源及此账号副本"
                            : "只移除此账号副本，保留其他账号资源"}
                        </small>
                      </div>
                      <Button
                        quiet
                        size="compact"
                        disabled={busy}
                        onClick={() => onResource(r.id)}
                      >
                        查看资源
                      </Button>
                    </li>
                  ))}
              </ul>
              {resources.length > 6 ? (
                <Pagination
                  page={currentPage}
                  pageSize={6}
                  total={resources.length}
                  onPageChange={setPage}
                  disabled={busy}
                  label="待删除账号的关联资源"
                />
              ) : null}
            </>
          ) : (
            <p className="muted">此账号没有关联的本地资源。</p>
          )}
          {data.blockers.length ? (
            <Notice warning>
              <strong>请先处理以下关联，再删除账号</strong>
              <ul className="account-delete-blockers">
                {data.blockers.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
        </>
      ) : null}
      {error ? <Notice danger>{error}</Notice> : null}
      {retryToken ? (
        <p className="muted">重试沿用原操作编号；已完成的删除不会重复执行。</p>
      ) : null}
    </Dialog>
  );
}

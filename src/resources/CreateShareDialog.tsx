import { useRef, useState } from "react";
import { Copy, Link2 } from "lucide-react";
import type { ResourceCopy } from "../../shared/types";
import type { ShareCreationReceipt } from "../../shared/share-creation";
import { shareCreationOptionsError } from "../../shared/share-options";
import { copyShareStatus } from "../../shared/share-status";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppActions, useAppActivity, useAppData } from "../state";
import { Dialog } from "../ui/Dialog";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Button, Field, LoadingState, Notice } from "../ui/primitives";
import "./create-share.css";

/** Creates an independent link without changing the resource's saved share. */
export function CreateShareDialog({
  copyId,
  onClose,
}: {
  copyId: string;
  onClose(): void;
}) {
  const { notify } = useAppActions();
  const options = useIpcQuery(
    "share.creationOptions",
    { copyId },
    { keepPrevious: true },
  );
  const [days, setDays] = useState<number | null>(null);
  const [code, setCode] = useState("");
  const [result, setResult] = useState<ShareCreationReceipt | null>(null);
  const [fresh, setFresh] = useState(false);
  const [operationId, setOperationId] = useState("");
  const [pending, setPending] = useState(false);
  const [reading, setReading] = useState(false);
  const [creationFailed, setCreationFailed] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const context = options.data;
  const receipt = result ?? (!fresh ? context?.latest : null);
  const expiresInDays =
    days ?? context?.capabilities.expiryOptions[0]?.days ?? 0;
  const validation = context
    ? shareCreationOptionsError(context.provider, {
        expiresInDays,
        extractionCode: code.trim() || undefined,
      })
    : null;
  const unresolved = !!operationId && !receipt;
  const canCreate =
    !!context &&
    !options.loading &&
    !options.error &&
    !context.issue &&
    !validation &&
    !receipt &&
    !unresolved &&
    !pending;
  const readResult = async (id: string, allowMissing = false) => {
    const value = await ipc("share.creationResult", { operationId: id });
    if (value) {
      setResult(value);
      setError("");
    } else if (allowMissing) {
      setOperationId("");
      setCreationFailed(false);
    } else setError("这次创建结果暂时无法确认，请稍后重新读取。");
  };
  const create = async () => {
    if (lock.current || !canCreate) return;
    lock.current = true;
    setPending(true);
    setReading(false);
    setCreationFailed(false);
    setError("");
    const id = crypto.randomUUID();
    setOperationId(id);
    try {
      setResult(
        await ipc("share.create", {
          operationId: id,
          copyId,
          expiresInDays,
          extractionCode: code.trim() || undefined,
        }),
      );
    } catch (cause) {
      setCreationFailed(true);
      setError(
        cause instanceof Error ? cause.message : "分享创建结果未读取成功。",
      );
      // Recover only the local journal; never retry the submitted cloud request.
      try {
        await readResult(id, true);
      } catch {
        // The original failure remains visible with an explicit read-only retry.
      }
      options.reload();
    } finally {
      lock.current = false;
      setPending(false);
    }
  };
  const refreshResult = async () => {
    const id = receipt?.operationId ?? operationId;
    if (!id || lock.current) return;
    lock.current = true;
    setPending(true);
    setReading(true);
    setError("");
    try {
      await readResult(id, creationFailed);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "创建记录读取失败，请重试。",
      );
    } finally {
      lock.current = false;
      setPending(false);
    }
  };
  const reconcile = async (action: "check" | "not_created" | "handled") => {
    if (lock.current || receipt?.state !== "uncertain") return;
    lock.current = true;
    setPending(true);
    setReading(true);
    setError("");
    try {
      setResult(
        action === "check"
          ? await ipc("share.recheckCreation", {
              operationId: receipt.operationId,
            })
          : await ipc("share.resolveCreation", {
              operationId: receipt.operationId,
              outcome: action,
            }),
      );
      options.reload();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "创建结果处理失败，请重试。",
      );
    } finally {
      lock.current = false;
      setPending(false);
    }
  };
  const newShare = () => {
    setFresh(true);
    setResult(null);
    setOperationId("");
    setCreationFailed(false);
    setError("");
    setCode("");
  };
  return (
    <Dialog
      title="创建新分享"
      className="create-share-dialog"
      onClose={onClose}
      busy={pending}
      footer={
        receipt?.state === "success" ? (
          <>
            <Button
              disabled={
                pending || !!context?.issue || !context?.capabilities.supported
              }
              onClick={newShare}
            >
              再创建一条分享
            </Button>
            <Button
              primary
              disabled={!receipt.url}
              onClick={() =>
                void ipc("system.copyText", {
                  text: `${receipt.url}${receipt.code ? `\n提取码：${receipt.code}` : ""}`,
                })
                  .then(() => notify("新分享链接已复制。", "success"))
                  .catch((cause: unknown) =>
                    notify(
                      cause instanceof Error
                        ? cause.message
                        : "复制失败，请重试。",
                      "error",
                    ),
                  )
              }
            >
              <Copy size={14} />
              复制新分享
            </Button>
          </>
        ) : receipt?.state === "failed" ? (
          <Button
            primary
            disabled={
              pending ||
              options.loading ||
              !!context?.issue ||
              !context?.capabilities.supported
            }
            onClick={newShare}
          >
            调整设置后重试
          </Button>
        ) : receipt?.state === "uncertain" ? (
          <>
            <Button
              disabled={pending}
              onClick={() =>
                void reconcile(
                  receipt.hasReturnedShare || receipt.url
                    ? "handled"
                    : "not_created",
                )
              }
            >
              {receipt.hasReturnedShare || receipt.url
                ? "已在网盘处理本次分享，结束核对"
                : "已在网盘核对未创建"}
            </Button>
            <Button
              primary
              disabled={pending}
              onClick={() => void reconcile("check")}
            >
              {pending ? "正在核对…" : "检查创建结果"}
            </Button>
          </>
        ) : unresolved ? (
          <Button disabled={pending} onClick={() => void refreshResult()}>
            {pending
              ? reading
                ? "正在读取…"
                : "正在创建分享…"
              : "刷新创建结果"}
          </Button>
        ) : (
          <Button primary disabled={!canCreate} onClick={() => void create()}>
            <Link2 size={14} />
            {pending ? "正在创建分享…" : "创建新分享"}
          </Button>
        )
      }
    >
      <QueryError
        error={options.error}
        loading={options.loading}
        onRetry={options.reload}
      />
      {!context && options.loading ? (
        <LoadingState compact label="正在读取分享设置…" />
      ) : null}
      {context ? (
        <>
          <div className="create-share-identity">
            <strong>{context.title}</strong>
            <span>{context.accountAlias}</span>
          </div>
          <p className="muted">
            新链接可直接复制使用，不新增资源，也不替换原分享。
          </p>
          {receipt ? (
            <div className="create-share-result">
              <p
                className={
                  receipt.state === "success"
                    ? "good-text"
                    : "create-share-warning"
                }
              >
                {receipt.message}
              </p>
              {receipt.state === "success" && receipt.url ? (
                <>
                  <div className="link-box">{receipt.url}</div>
                  {receipt.code ? (
                    <p>
                      提取码：<strong>{receipt.code}</strong>
                    </p>
                  ) : null}
                  <small>
                    {receipt.expiresAt
                      ? `有效至 ${new Date(receipt.expiresAt).toLocaleString("zh-CN")}`
                      : receipt.expiresInDays === 0
                        ? "永久有效"
                        : `有效期 ${receipt.expiresInDays} 天`}
                    {` · 创建于 ${new Date(receipt.createdAt).toLocaleString("zh-CN")}`}
                  </small>
                </>
              ) : receipt.state === "uncertain" ? (
                <p className="muted">
                  {receipt.hasReturnedShare || receipt.url
                    ? "网盘已返回分享，请在原账号核对并处理。关闭后可重新打开继续查看。"
                    : "请在原账号网盘核对是否已创建。关闭后可重新打开继续查看。"}
                </p>
              ) : null}
            </div>
          ) : !unresolved ? (
            <>
              {context.issue || !context.capabilities.supported ? (
                <Notice warning>
                  {context.issue ??
                    context.capabilities.note ??
                    "此网盘暂不支持创建独立分享。"}
                </Notice>
              ) : (
                <>
                  <Field as="div" label="有效期">
                    <Select
                      aria-label="新分享有效期"
                      value={String(expiresInDays)}
                      disabled={pending}
                      onValueChange={(value) => setDays(Number(value))}
                      items={context.capabilities.expiryOptions.map((item) => ({
                        value: String(item.days),
                        label: item.label,
                      }))}
                    />
                  </Field>
                  {context.capabilities.extractionCode.mode === "custom" ? (
                    <Field
                      label="提取码"
                      hint={context.capabilities.extractionCode.description}
                    >
                      <input
                        aria-label="新分享提取码"
                        autoComplete="off"
                        value={code}
                        maxLength={context.capabilities.extractionCode.length}
                        disabled={pending}
                        onChange={(event) => setCode(event.target.value)}
                        placeholder="留空自动生成"
                      />
                    </Field>
                  ) : (
                    <p className="muted">
                      {context.capabilities.extractionCode.description}
                    </p>
                  )}
                  {validation ? (
                    <p className="create-share-warning">{validation}</p>
                  ) : null}
                </>
              )}
            </>
          ) : null}
        </>
      ) : null}
      {error ? <Notice danger>{error}</Notice> : null}
    </Dialog>
  );
}

/** The same creation entry is used by the resource inspector and paused tasks. */
export function CreateShare({ copy }: { copy: ResourceCopy }) {
  const { data } = useAppData();
  const { busy } = useAppActivity();
  const [open, setOpen] = useState(false);
  const account = data?.accounts.find((item) => item.id === copy.accountId);
  if (!copyShareStatus(copy, account).canCreate) return null;
  return (
    <>
      <Button
        quiet
        size="compact"
        disabled={busy > 0}
        onClick={() => setOpen(true)}
      >
        <Link2 size={14} />
        创建新分享
      </Button>
      {open ? (
        <CreateShareDialog
          key={copy.id}
          copyId={copy.id}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

import { useRef, useState } from "react";
import { Copy, Trash2 } from "lucide-react";
import type {
  Provider,
  RemoteFile,
  Resource,
  ShareInspection,
} from "../../shared/types";
import type { ResourceDriveLink } from "../../shared/resource-drive-links";
import { providerDriveName } from "../../shared/providers";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppData, useAppNavigation, useAppSelection } from "../state";
import { ProviderIcon } from "../resources/ProviderIcon";
import { chooseIntakeAccount } from "../resources/intake-share";
import { SourceContents, type ShareParent } from "../resources/SourceContents";
import { useTaskFocus } from "../tasks/TaskFocus";
import { Dialog } from "../ui/Dialog";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { Button, Field, LoadingState, Notice } from "../ui/primitives";

const root = [{ id: "0", name: "分享根目录" }];
const problemStages = ["failed", "needs_review", "waiting_login", "cancelled"];
type Destination = { provider: Provider; accountId: string; directory: string };

export function ResourceDriveLinksDialog({
  resource,
  onClose,
  onUpdated,
}: {
  resource: Resource;
  onClose(): void;
  onUpdated(): void;
}) {
  const { data } = useAppData();
  const { activeAccounts } = useAppSelection();
  const { navigate } = useAppNavigation();
  const { request: focusTask } = useTaskFocus();
  const accounts = data?.accounts ?? [];
  const resourceId = resource.id;
  const links = useIpcQuery(
    "resource.driveLinks",
    { resourceId },
    { keepPrevious: true },
  );
  const [editing, setEditing] = useState<ResourceDriveLink | null>(null);
  const [text, setText] = useState("");
  const [destination, setDestination] = useState<Destination | null>(null);
  const [inspection, setInspection] = useState<ShareInspection | null>(null);
  const [selected, setSelected] = useState<RemoteFile[]>([]);
  const [parents, setParents] = useState<ShareParent[]>(root);
  const [readError, setReadError] = useState("");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const account = accounts.find(
    (a) => a.id === destination?.accountId && a.enabled,
  );
  const codeOnly = !!editing?.copyId;
  const showTask = (jobId: string) => {
    focusTask({ kind: "job", id: jobId });
    onClose();
    navigate("tasks");
  };
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const resetFiles = () => {
    setInspection(null);
    setSelected([]);
    setParents(root);
    setReadError("");
  };
  const setSource = (link: ResourceDriveLink | null) => {
    setEditing(link);
    setText(link?.url ?? "");
    setDestination(null);
    setError("");
    resetFiles();
    input.current?.focus();
  };
  const sourceArgs = {
    resourceId,
    sourceText: text,
    sourceLinkId: editing?.id,
  };
  const readFiles = async (
    accountId: string,
    parentId = "0",
    page = 1,
    cursor?: string,
    path = root,
  ) => {
    setReadError("");
    try {
      const next = await ipc("share.inspect", {
        ...sourceArgs,
        accountId,
        parentId,
        page,
        cursor,
      });
      setInspection((previous) =>
        page > 1 && previous?.parentId === parentId
          ? {
              ...next,
              files: [
                ...previous.files,
                ...next.files.filter(
                  (file) => !previous.files.some((old) => old.id === file.id),
                ),
              ],
            }
          : next,
      );
      setParents(path);
    } catch (cause) {
      setReadError(
        cause instanceof Error ? cause.message : "读取分享失败，请重试。",
      );
    }
  };
  const configure = () =>
    void run(async () => {
      if (codeOnly && editing) {
        const items = await ipc("resource.updateDriveSourceCode", {
          resourceId,
          linkId: editing.id,
          text,
        });
        links.setData(items);
        setSource(null);
        setFeedback("提取码已更新，请在原任务中重试。");
        return;
      }
      const share = await ipc("share.parse", { text });
      if (share.provider === resource.provider)
        throw new Error("补充转存请选择主资源之外的网盘。");
      const previous = links.data?.find(
        (link) => link.provider === share.provider,
      );
      if (previous?.copyId)
        throw new Error("该网盘已有副本或转存任务，请查看原任务。");
      if (previous?.id !== editing?.id)
        throw new Error("请从对应网盘的待转存记录继续，或移除旧来源后添加。");
      const accountId = chooseIntakeAccount(
        accounts,
        activeAccounts,
        share.provider,
      );
      const chosen = accounts.find((a) => a.id === accountId);
      setDestination({
        provider: share.provider,
        accountId,
        directory: chosen?.defaultDirectory ?? "/盘序资源",
      });
      if (chosen?.uid) await readFiles(chosen.id);
    });
  const transfer = () =>
    void run(async () => {
      if (!account?.uid || !destination || !selected.length) return;
      await ipc("resource.transferDriveLink", {
        resourceId,
        text,
        replaceId: editing?.id,
        accountId: account.id,
        directory: destination.directory,
        selectedFiles: selected,
      });
      setSource(null);
      links.reload();
      onUpdated();
      setFeedback("已创建转存任务，完成后可复制本人分享。");
    });

  return (
    <Dialog
      title="补充网盘链接"
      className={`resource-drive-links-dialog${destination ? " resource-drive-transfer-dialog" : ""}`}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <span className="resource-drive-links-feedback" role="status">
            {feedback}
          </span>
          <Button
            disabled={busy}
            onClick={
              destination
                ? () => {
                    setDestination(null);
                    resetFiles();
                    setError("");
                  }
                : onClose
            }
          >
            {destination ? "返回来源" : "完成"}
          </Button>
          <Button
            primary
            disabled={
              busy ||
              !!links.error ||
              (destination
                ? !selected.length || !account?.uid
                : !links.data || !text.trim())
            }
            onClick={destination ? transfer : configure}
          >
            {destination
              ? "开始转存"
              : codeOnly
                ? "更新提取码"
                : "选择账号与文件"}
          </Button>
        </>
      }
    >
      <p className="resource-drive-links-title">{resource.title}</p>
      {destination ? (
        <>
          <div className="field-pair">
            <Field label={`${providerDriveName(destination.provider)}转存账号`}>
              <Select
                value={destination.accountId}
                aria-label="转存账号"
                disabled={busy}
                items={accounts
                  .filter(
                    (a) => a.provider === destination.provider && a.enabled,
                  )
                  .map((a) => ({ value: a.id, label: a.alias }))
                  .concat(
                    destination.accountId
                      ? []
                      : [{ value: "", label: "没有可用账号" }],
                  )}
                onValueChange={(accountId) => {
                  const next = accounts.find((a) => a.id === accountId);
                  setDestination({
                    ...destination,
                    accountId,
                    directory: next?.defaultDirectory ?? "/盘序资源",
                  });
                  resetFiles();
                  if (next?.uid) void run(() => readFiles(accountId));
                }}
              />
            </Field>
            <Field label="保存目录">
              <input
                value={destination.directory}
                disabled={busy}
                maxLength={500}
                onChange={(e) =>
                  setDestination({ ...destination, directory: e.target.value })
                }
              />
            </Field>
          </div>
          {!account?.uid ? (
            <Notice warning>
              请先连接{providerDriveName(destination.provider)}账号。
              <Button
                quiet
                onClick={() => {
                  onClose();
                  navigate("accounts");
                }}
              >
                账号管理
              </Button>
            </Notice>
          ) : null}
          <SourceContents
            context="resource"
            own={false}
            provider={destination.provider}
            inspection={inspection}
            selected={selected}
            parents={parents}
            loading={busy}
            error={readError}
            enabled={!!account?.uid}
            onSelect={setSelected}
            onRead={(parentId, page, cursor, path) => {
              if (account)
                void run(() =>
                  readFiles(account.id, parentId, page, cursor, path),
                );
            }}
            onOpenOfficial={() => {
              if (account)
                void run(() =>
                  ipc("share.open", {
                    ...sourceArgs,
                    accountId: account.id,
                  }).then(() => {}),
                );
            }}
          />
        </>
      ) : (
        <>
          {links.loading && !links.data ? (
            <LoadingState label="正在读取补充网盘…" />
          ) : null}
          <QueryError
            error={links.error}
            loading={links.loading}
            onRetry={links.reload}
          />
          {links.data?.length ? (
            <ul className="resource-drive-links-list" aria-label="补充网盘">
              {links.data.map((link) => {
                const name = providerDriveName(link.provider);
                const ready = link.status === "ready" && !!link.shareUrl;
                const problem = problemStages.includes(link.status ?? "");
                return (
                  <li key={link.id} className="resource-drive-link">
                    <div className="resource-drive-link-address">
                      <strong className="resource-provider">
                        <ProviderIcon
                          provider={link.provider}
                          size="small"
                          decorative
                        />
                        {name}
                      </strong>
                      <span className="muted">
                        {ready
                          ? link.shareUrl
                          : problem
                            ? "任务需要处理"
                            : link.copyId
                              ? "转存进行中"
                              : "待转存"}
                      </span>
                    </div>
                    <div className="row compact">
                      {ready && link.copyId ? (
                        <Button
                          size="compact"
                          quiet
                          disabled={busy}
                          aria-label={`复制${name}本人分享`}
                          onClick={() =>
                            void run(async () => {
                              const result = await ipc("copy.link", {
                                copyId: link.copyId!,
                              });
                              await ipc("system.copyText", result);
                              setFeedback("本人分享已复制。");
                            })
                          }
                        >
                          <Copy size={14} />
                          复制本人分享
                        </Button>
                      ) : link.jobId ? (
                        <Button
                          size="compact"
                          quiet
                          disabled={busy}
                          onClick={() => showTask(link.jobId!)}
                        >
                          查看任务
                        </Button>
                      ) : null}
                      {!link.copyId || problem ? (
                        <Button
                          size="compact"
                          quiet
                          disabled={busy}
                          onClick={() => setSource(link)}
                        >
                          {link.copyId ? "补填提取码" : "继续转存"}
                        </Button>
                      ) : null}
                      {!link.copyId ? (
                        <Button
                          size="compact"
                          quiet
                          disabled={busy}
                          aria-label={`移除${name}待转存来源`}
                          onClick={() =>
                            void run(async () => {
                              links.setData(
                                await ipc("resource.removeDriveLink", {
                                  resourceId,
                                  linkId: link.id,
                                }),
                              );
                              onUpdated();
                              if (editing?.id === link.id) setSource(null);
                            })
                          }
                        >
                          <Trash2 size={14} />
                          移除
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <Field
            label={codeOnly ? "原链接与提取码" : "外部网盘分享"}
            hint="可粘贴含提取码的整段分享文案"
          >
            <textarea
              ref={input}
              rows={3}
              maxLength={8000}
              disabled={busy}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="粘贴要转存的其他网盘分享"
            />
          </Field>
          {editing ? (
            <Button
              size="compact"
              quiet
              disabled={busy}
              onClick={() => setSource(null)}
            >
              取消编辑
            </Button>
          ) : null}
        </>
      )}
      {error ? <Notice danger>{error}</Notice> : null}
    </Dialog>
  );
}

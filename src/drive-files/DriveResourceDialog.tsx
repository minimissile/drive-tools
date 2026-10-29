import { useEffect, useRef, useState } from "react";
import { ShieldCheck, ShieldQuestion } from "lucide-react";
import type {
  Resource,
  ResourceCopy,
  ShareInspection,
} from "../../shared/types";
import type { DriveDirectory } from "../../shared/drive-files";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useAppData } from "../state";
import { Empty, LoadingState } from "../ui/primitives";
import { Dialog } from "../ui/Dialog";
import { QueryError } from "../ui/QueryError";
import { SourceContents, type ShareParent } from "../resources/SourceContents";
import { providerName } from "../resources/labels";
import { DriveBrowser } from "./DriveBrowser";
import { childPath } from "./FileTable";
import "./drive-resource-dialog.css";

export type DriveResourceTarget =
  | { kind: "resource"; resource: Resource; copy?: ResourceCopy }
  | {
      kind: "share";
      accountId: string;
      sourceText: string;
      code?: string;
      title?: string;
      ownership?: "external" | "unknown";
    }
  | {
      kind: "own";
      accountId: string;
      path: string;
      copy?: ResourceCopy;
      title?: string;
    };

type ResourceContents =
  | {
      identity: string;
      kind: "own";
      directory: DriveDirectory;
      selected: string[];
    }
  | {
      identity: string;
      kind: "share";
      inspection: ShareInspection;
      parents: ShareParent[];
    };
const shareRoot: ShareParent[] = [{ id: "0", name: "分享根目录" }];

/** Opening the viewer authorizes a remote read; file changes remain explicit. */
export function DriveResourceDialog({
  target,
  onClose,
}: {
  target: DriveResourceTarget;
  onClose(): void;
}) {
  const identity =
    target.kind === "resource"
      ? `${target.kind}:${target.resource.id}:${target.copy?.id ?? ""}`
      : target.kind === "share"
        ? `${target.kind}:${target.accountId}:${target.sourceText}:${target.code ?? ""}`
        : `${target.kind}:${target.accountId}:${target.path}`;
  return (
    <DriveResourceViewer key={identity} target={target} onClose={onClose} />
  );
}

function DriveResourceViewer({
  target,
  onClose,
}: {
  target: DriveResourceTarget;
  onClose(): void;
}) {
  const { data } = useAppData();
  const query = useIpcQuery(
    "resource.get",
    { id: target.kind === "resource" ? target.resource.id : "" },
    { enabled: target.kind === "resource" },
  );
  const resource =
    target.kind === "resource" ? (query.data ?? target.resource) : null;
  const copy = resource
    ? target.kind === "resource" && target.copy
      ? resource.copies.find((item) => item.id === target.copy?.id)
      : resource.copies[0]
    : target.kind === "own"
      ? target.copy
      : undefined;
  const accountId = resource
    ? (copy?.accountId ?? "")
    : target.kind !== "resource"
      ? target.accountId
      : "";
  const account = data?.accounts.find((item) => item.id === accountId);
  const knownOwn =
    target.kind === "own" || !!(account?.uid && copy?.ownerUid === account.uid);
  const sourceText =
    resource?.sourceUrl ?? (target.kind === "share" ? target.sourceText : "");
  const sourceCode = target.kind === "share" ? target.code : undefined;
  const title =
    resource?.title ??
    (target.kind !== "resource" ? target.title : undefined) ??
    "网盘资源";
  const identity = `${accountId}:${account?.uid ?? ""}:${account?.enabled ?? ""}:${copy?.id ?? ""}:${knownOwn}:${sourceText}`;
  const accountAvailable = !!account;
  const ready = target.kind !== "resource" || !!query.data;
  const [contents, setContents] = useState<ResourceContents | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const request = useRef(0);
  const mounted = useRef(true);
  const reading = useRef(false);
  const attemptedShare = useRef<{
    parentId: string;
    page: number;
    cursor?: string;
    parents: ShareParent[];
  }>({ parentId: "0", page: 1, parents: shareRoot });
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const activeContents = contents?.identity === identity ? contents : null;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, []);
  useEffect(() => {
    if (!ready || query.error || !account) return;
    const serial = ++request.current;
    const current = () =>
      mounted.current &&
      serial === request.current &&
      currentIdentity.current === identity;
    setContents(null);
    setError("");
    setLoading(true);
    reading.current = true;
    attemptedShare.current = { parentId: "0", page: 1, parents: shareRoot };
    // One tick prevents duplicate remote reads in the development setup/cleanup cycle.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (knownOwn) {
            let directory: DriveDirectory;
            let selected: string[] = [];
            if (target.kind === "own") {
              directory = await ipc("drive.directory", {
                accountId,
                path: target.path,
              });
            } else {
              if (!copy) throw new Error("此资源没有可定位的账号记录。");
              // A maintained resource may have a stale manifest. Its saved
              // owner and exact folder ID still identify the directory to browse.
              let recordedDirectory: DriveDirectory | null = null;
              if (copy.folderId) {
                try {
                  recordedDirectory = await ipc("drive.directory", {
                    accountId,
                    path: copy.directory,
                  });
                } catch {
                  // A moved or renamed directory can still be located by ID.
                }
              }
              if (!current()) return;
              const location =
                recordedDirectory && recordedDirectory.folderId === copy.folderId
                  ? {
                      directory: recordedDirectory,
                      files: recordedDirectory.files.filter((file) =>
                        copy.files.some((expected) => expected.id === file.id),
                      ),
                    }
                  : await ipc("drive.locateCopy", { copyId: copy.id });
              if (!current()) return;
              directory = location.directory;
              const only =
                location.files.length === 1 ? location.files[0] : undefined;
              if (only?.isDirectory) {
                directory = await ipc("drive.directory", {
                  accountId,
                  path: childPath(directory.path, only.name),
                });
              } else selected = location.files.map((file) => file.id);
            }
            if (current())
              setContents({ identity, kind: "own", directory, selected });
          } else {
            if (!sourceText) throw new Error("未记录可查看的网盘分享链接。");
            const inspection = await ipc("share.inspect", {
              accountId,
              sourceText,
              code: sourceCode,
              resourceId: resource?.id,
              parentId: "0",
              page: 1,
            });
            if (current())
              setContents({
                identity,
                kind: "share",
                inspection,
                parents: shareRoot,
              });
          }
        } catch (cause) {
          if (current())
            setError(
              cause instanceof Error ? cause.message : "资源读取失败，请重试。",
            );
        } finally {
          if (current()) {
            reading.current = false;
            setLoading(false);
          }
        }
      })();
    }, 0);
    return () => {
      clearTimeout(timer);
      request.current++;
      reading.current = false;
    };
  }, [ready, query.error, identity, accountAvailable, retry]);

  const readShare = async (
    parentId = "0",
    page = 1,
    cursor?: string,
    parents = shareRoot,
  ) => {
    if (reading.current || !account || !sourceText) return;
    const serial = ++request.current;
    const current = () =>
      mounted.current &&
      serial === request.current &&
      currentIdentity.current === identity;
    reading.current = true;
    attemptedShare.current = { parentId, page, cursor, parents };
    setLoading(true);
    setError("");
    try {
      const value = await ipc("share.inspect", {
        accountId,
        sourceText,
        code: sourceCode,
        resourceId: resource?.id,
        parentId,
        page,
        cursor,
      });
      if (!current()) return;
      setContents((old) => ({
        identity,
        kind: "share",
        parents,
        inspection:
          page > 1 &&
          old?.identity === identity &&
          old.kind === "share" &&
          old.inspection.parentId === parentId
            ? {
                ...value,
                files: [
                  ...new Map(
                    [...old.inspection.files, ...value.files].map((file) => [
                      file.id,
                      file,
                    ]),
                  ).values(),
                ],
              }
            : value,
      }));
    } catch (cause) {
      if (current())
        setError(
          cause instanceof Error ? cause.message : "分享读取失败，请重试。",
        );
    } finally {
      if (current()) {
        reading.current = false;
        setLoading(false);
      }
    }
  };
  const label = knownOwn
    ? "本人资源"
    : target.kind === "share" && target.ownership === "external"
      ? "他人资源 · 只读"
      : "归属未核验 · 只读";
  return (
    <Dialog
      title="查看网盘资源"
      className="drive-resource-dialog"
      onClose={onClose}
      focus="container"
    >
      <div className="drive-resource-body">
        <div className="drive-resource-heading">
          <div>
            <h3>{title}</h3>
            <p>
              {account
                ? `${providerName(account.provider)} · ${account.alias}`
                : "请先连接此资源对应的网盘账号。"}
            </p>
          </div>
          <span
            className="drive-resource-ownership"
            data-own={knownOwn || undefined}
          >
            {knownOwn ? (
              <ShieldCheck size={16} aria-hidden="true" />
            ) : (
              <ShieldQuestion size={16} aria-hidden="true" />
            )}
            {label}
          </span>
        </div>
        <QueryError
          error={query.error}
          loading={query.loading}
          onRetry={query.reload}
        />
        {!query.error && !activeContents ? (
          query.loading || (account && knownOwn && loading) ? (
            <LoadingState label="正在读取网盘资源内容…" layout="list" />
          ) : !account ? (
            <Empty compact title="缺少可用网盘账号">
              请先为此资源连接相同网盘类型的账号。
            </Empty>
          ) : null
        ) : null}
        {knownOwn ? (
          <QueryError
            error={error}
            loading={loading}
            onRetry={() => setRetry((value) => value + 1)}
          />
        ) : null}
        {activeContents?.kind === "own" && account ? (
          <>
            {activeContents.selected.length > 0 &&
            activeContents.directory.files.length >
              activeContents.selected.length ? (
              <p className="drive-resource-context">
                已选中当前资源文件，列表同时显示其所在目录的其他项目。
              </p>
            ) : null}
            <DriveBrowser
              key={`${identity}:${activeContents.directory.readAt}`}
              accountId={accountId}
              initialPath={activeContents.directory.path}
              initialDirectory={activeContents.directory}
              initialSelected={activeContents.selected}
              workspace={data!.dataPath}
              copy={copy}
              context="resource"
            />
          </>
        ) : ready && !query.error && !knownOwn && account ? (
          <SourceContents
            inspection={
              activeContents?.kind === "share"
                ? activeContents.inspection
                : null
            }
            provider={account.provider}
            selected={[]}
            parents={
              activeContents?.kind === "share"
                ? activeContents.parents
                : shareRoot
            }
            loading={loading}
            error={error}
            enabled
            own={false}
            readOnly
            context="resource"
            onRead={(parentId, page, cursor, parents) =>
              void readShare(parentId, page, cursor, parents)
            }
            onRetry={() => {
              const attempt = attemptedShare.current;
              void readShare(
                attempt.parentId,
                attempt.page,
                attempt.cursor,
                attempt.parents,
              );
            }}
            onSelect={() => {}}
            onOpenOfficial={() =>
              void ipc("share.open", {
                accountId,
                sourceText,
                code: sourceCode,
                resourceId: resource?.id,
              }).catch((cause: unknown) => {
                if (mounted.current && currentIdentity.current === identity)
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "官方分享打开失败。",
                  );
              })
            }
          />
        ) : null}
      </div>
    </Dialog>
  );
}

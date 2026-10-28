import { useState } from "react";
import { ArrowUp, FolderPlus, RefreshCw, Upload } from "lucide-react";
import { ipc } from "../api/client";
import { useAppActions } from "../state";
import {
  Button,
  Empty,
  Field,
  Loading,
  LoadingState,
  Notice,
  Panel,
} from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Dialog } from "../ui/Dialog";
import type {
  DriveDirectory,
  DriveWriteReceipt,
} from "../../shared/drive-files";
import { childPath, FileTable } from "./FileTable";
import { useDriveDirectory } from "./useDriveDirectory";
import { DriveMutationDialog, type DriveMutation } from "./DriveMutationDialog";
import { DriveSharePanel } from "./DriveSharePanel";
import { CopyManifestPanel } from "./CopyManifestPanel";
import type { ResourceCopy } from "../../shared/types";

export function DriveBrowser({
  accountId,
  initialPath = "/",
  workspace,
  onPathChange,
  copy,
  initialDirectory,
  initialSelected = [],
}: {
  accountId: string;
  initialPath?: string;
  workspace: string;
  onPathChange?(path: string): void;
  copy?: ResourceCopy;
  /** A snapshot obtained by an explicit caller action, never an automatic remote read. */
  initialDirectory?: DriveDirectory;
  initialSelected?: string[];
}) {
  const query = useDriveDirectory(accountId, initialPath, initialDirectory);
  const { directory, path, setPath, loading, error, mounted } = query;
  const { refresh, notify } = useAppActions();
  const [selected, setSelected] = useState<string[]>(initialSelected);
  const [mutation, setMutation] = useState<DriveMutation | null>(null);
  const [receipt, setReceipt] = useState<DriveWriteReceipt | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [resolve, setResolve] = useState(false);
  const [sharing, setSharing] = useState(false);
  const read = async (next?: string) => {
    const success = await query.read(next);
    if (success && mounted.current) {
      setSelected([]);
      setReceipt(null);
      setCheckError("");
      if (next) onPathChange?.(next);
    }
    return success;
  };
  const pending =
    directory?.pending ?? (receipt?.state !== "success" ? receipt : null);
  const blocked = loading || checking || sharing || !!pending;
  const files = directory?.files.filter((f) => selected.includes(f.id)) ?? [];
  const open = (action: DriveMutation["action"]) =>
    setMutation({
      action,
      files: action === "mkdir" || action === "upload" ? [] : files,
      id: crypto.randomUUID(),
    });
  const completed = (value: DriveWriteReceipt) => {
    if (!mounted.current) return;
    setMutation(null);
    setReceipt(value);
    setSelected([]);
    notify(value.message, value.state === "success" ? "success" : "warning");
    if (value.state === "success")
      void query.read(directory!.path).then((ok) => {
        if (!ok && mounted.current)
          notify(
            "操作已完成，目录刷新失败；请重试读取，无需再次提交。",
            "warning",
          );
      });
    void refresh().catch(() => {
      if (mounted.current)
        notify("网盘操作已提交，本地资料状态刷新失败，请稍后刷新。", "warning");
    });
  };
  const check = async () => {
    setChecking(true);
    setCheckError("");
    try {
      const value = await ipc("drive.recheck", {
        accountId,
        path: directory!.path,
      });
      if (!mounted.current) return;
      setReceipt(value);
      if (!value || value.state === "success") {
        await read(directory!.path);
        if (value) notify(value.message, "success");
      }
    } catch (e) {
      if (mounted.current)
        setCheckError(e instanceof Error ? e.message : "核对失败。");
    } finally {
      if (mounted.current) setChecking(false);
    }
  };
  const segments = directory?.path.split("/").filter(Boolean) ?? [];
  return (
    <div className="drive-browser">
      <Panel title="本人网盘目录">
        <div className="drive-location">
          <Field label="目录路径" hint="支持从根目录逐层浏览">
            <input
              aria-label="本人网盘目录路径"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/"
              disabled={loading || checking || sharing}
            />
          </Field>
          <Button
            primary
            disabled={!accountId || loading || checking || sharing}
            onClick={() => void read(path)}
          >
            {loading ? "正在读取…" : "读取目录"}
          </Button>
        </div>
        <small>
          读取后显示当前目录的全部文件，可按名称筛选。选择文件夹可进入下一层。
        </small>
      </Panel>
      <Panel
        title="文件内容"
        extra={
          directory ? (
            <small>
              {directory.files.length} 项 · {directory.path}
            </small>
          ) : undefined
        }
      >
        <QueryError
          error={error}
          loading={loading}
          onRetry={() => void query.retry()}
        />
        {directory ? (
          <>
            <nav className="drive-breadcrumb" aria-label="本人网盘目录导航">
              <Button
                quiet
                size="compact"
                disabled={
                  loading || checking || sharing || directory.path === "/"
                }
                onClick={() =>
                  void read(
                    directory.path.slice(0, directory.path.lastIndexOf("/")) ||
                      "/",
                  )
                }
              >
                <ArrowUp size={14} />
                上一级
              </Button>
              <Button
                quiet
                size="compact"
                disabled={loading || checking || sharing}
                onClick={() => void read("/")}
              >
                根目录
              </Button>
              {segments.map((s, i) => (
                <span key={i}>
                  /{" "}
                  <Button
                    quiet
                    size="compact"
                    disabled={loading || checking || sharing}
                    onClick={() =>
                      void read("/" + segments.slice(0, i + 1).join("/"))
                    }
                  >
                    {s}
                  </Button>
                </span>
              ))}
            </nav>
            {loading ? (
              <Loading label="正在读取，仍显示上次成功读取的目录…" />
            ) : null}
            {pending ? (
              <Notice warning>
                <p>{pending.message}</p>
                <div className="drive-browser-actions">
                  <Button
                    disabled={loading || checking || sharing}
                    onClick={() => void check()}
                  >
                    只读核对上次结果
                  </Button>
                  <Button
                    quiet
                    disabled={loading || checking || sharing}
                    onClick={() => setResolve(true)}
                  >
                    我已手动核对目录
                  </Button>
                </div>
                {checkError ? <p role="alert">{checkError}</p> : null}
              </Notice>
            ) : null}
            <div className="drive-selection-actions">
              <strong>已选 {files.length} 项</strong>
              <Button disabled={blocked} onClick={() => open("mkdir")}>
                <FolderPlus size={14} />
                新建文件夹
              </Button>
              <Button disabled={blocked} onClick={() => open("upload")}>
                <Upload size={14} />
                插入广告
              </Button>
              <Button
                disabled={
                  blocked ||
                  files.length !== 1 ||
                  !directory.capabilities.rename
                }
                onClick={() => open("rename")}
              >
                重命名
              </Button>
              <Button
                disabled={
                  blocked ||
                  files.length !== 1 ||
                  files[0]?.isDirectory ||
                  !/\.(txt|png|jpe?g|webp)$/i.test(files[0]?.name ?? "") ||
                  !directory.capabilities.rename ||
                  !directory.capabilities.upload
                }
                onClick={() => open("replace")}
              >
                替换广告
              </Button>
              <Button
                disabled={
                  blocked || !files.length || !directory.capabilities.delete
                }
                onClick={() => open("delete")}
              >
                删除 / 清理广告
              </Button>
              <Button
                quiet
                disabled={loading || checking || sharing}
                onClick={() => void read(directory.path)}
                aria-label="刷新当前目录"
              >
                <RefreshCw size={14} />
              </Button>
            </div>
            <FileTable
              key={`files:${directory.path}`}
              files={directory.files}
              selected={selected}
              onSelect={setSelected}
              disabled={loading || checking || sharing}
              onOpen={(f) => void read(childPath(directory.path, f.name))}
            />
            <DriveSharePanel
              key={`share:${directory.path}`}
              accountId={accountId}
              path={directory.path}
              selected={selected}
              disabled={blocked}
              mounted={mounted}
              onBusyChange={setSharing}
            />
            {copy?.accountId === accountId &&
            copy.folderId === directory.folderId &&
            copy.directory === directory.path ? (
              <CopyManifestPanel
                copy={copy}
                path={directory.path}
                files={files}
                disabled={blocked}
                mounted={mounted}
                onBusyChange={setSharing}
              />
            ) : null}
          </>
        ) : loading ? (
          <LoadingState label="正在读取本人网盘目录…" layout="list" />
        ) : !error ? (
          <Empty title="读取目录后查看资源内容">
            所有新增、删除、重命名和广告处理均由你明确提交。
          </Empty>
        ) : null}
      </Panel>
      {directory && mutation ? (
        <DriveMutationDialog
          key={mutation.id}
          directory={directory}
          workspace={workspace}
          mutation={mutation}
          onClose={() => setMutation(null)}
          onComplete={completed}
        />
      ) : null}
      {resolve && pending && directory ? (
        <Dialog
          title="确认已核对远端目录"
          onClose={() => setResolve(false)}
          busy={checking}
        >
          <Notice warning>
            请先查看目录、原文件备份和目标文件，确认上次操作的实际结果。解除记录后不会重新执行上次请求；再次操作需要重新选择。
          </Notice>
          {checkError ? <Notice danger>{checkError}</Notice> : null}
          <div className="dialog-actions">
            <Button disabled={checking} onClick={() => setResolve(false)}>
              取消
            </Button>
            <Button
              disabled={checking}
              onClick={async () => {
                setChecking(true);
                setCheckError("");
                try {
                  await ipc("drive.resolve", {
                    accountId,
                    path: directory.path,
                    operationId: pending.id,
                    confirmed: true,
                  });
                  if (mounted.current) {
                    setResolve(false);
                    await read(directory.path);
                  }
                } catch (e) {
                  if (mounted.current)
                    setCheckError(
                      e instanceof Error ? e.message : "解除记录失败。",
                    );
                } finally {
                  if (mounted.current) setChecking(false);
                }
              }}
            >
              已核对，解除待处理记录
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

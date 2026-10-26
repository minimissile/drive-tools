import { useRef, useState } from "react";
import { z } from "zod";
import { Folder, File, ArrowUp } from "lucide-react";
import { useAppActions, useAppData, useAppNavigation } from "../state";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { ipc } from "../api/client";
import {
  Button,
  Empty,
  Field,
  LoadingState,
  Notice,
  Panel,
} from "../ui/primitives";
import { Select } from "../ui/Select";
import { Dialog } from "../ui/Dialog";
import { QueryError } from "../ui/QueryError";
import { SelectionCheckbox } from "../ui/SelectionCheckbox";
import { updateSelection } from "../lib/selection";
import type { RemoteFile } from "../../shared/types";
import type { DriveShareResult } from "../../shared/zhidao";
import { OperationsWorkspace } from "../workbench/OperationsWorkspace";
import { useOperationAction } from "../zhidao/hooks";
export default function DriveFiles() {
  const { data } = useAppData(),
    { navigate } = useAppNavigation(),
    { notify, refresh } = useAppActions(),
    action = useOperationAction();
  const draft = useLocalDraft(
    `panxu-drive-files:${data!.dataPath}`,
    { accountId: "", path: "/" },
    (v) => z.object({ accountId: z.string(), path: z.string() }).parse(v),
  );
  const [files, setFiles] = useState<RemoteFile[] | null>(null),
    [loadedPath, setLoadedPath] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [error, setError] = useState(""),
    [rights, setRights] = useState(false),
    [shareResult, setShareResult] = useState<DriveShareResult | null>(null),
    [resetShare, setResetShare] = useState(false),
    [mutation, setMutation] = useState<{
      action: "mkdir" | "rename" | "delete";
      file?: RemoteFile;
    } | null>(null),
    [name, setName] = useState("");
  const epoch = useRef(0);
  const read = (path = draft.value.path) => {
    const serial = ++epoch.current;
    setError("");
    void action.run(
      "drive.files",
      { accountId: draft.value.accountId, path },
      (items) => {
        if (epoch.current !== serial) return;
        setFiles(items);
        setLoadedPath(path);
        draft.update({ path });
        setSelected([]);
        setRights(false);
      },
      undefined,
      (error) => setError(error.message),
    );
  };
  const current = loadedPath || draft.value.path;
  const filePath = (file: RemoteFile) =>
    file.path ?? current.replace(/\/$/, "") + "/" + file.name;
  const afterMutation = () => {
    setMutation(null);
    setFiles(null);
    setSelected([]);
    setRights(false);
    void refresh().catch(() =>
      notify("网盘操作已完成；本地资源状态刷新失败，请稍后刷新。", "warning"),
    );
    notify("操作已完成，请重新读取目录核对。", "success");
  };
  return (
    <OperationsWorkspace
      title="网盘文件"
      description="管理本人百度网盘文件，将核验后的分享归档到资源库，用于后续创作与导出。"
    >
      <Panel
        title="打开本人网盘"
        extra={
          <Button quiet onClick={() => navigate("accounts")}>
            管理网盘账号
          </Button>
        }
      >
        <div className="operations-form-grid">
          <Field label="百度网盘账号">
            <Select
              value={draft.value.accountId}
              onValueChange={(accountId) => {
                epoch.current++;
                draft.update({ accountId, path: "/" });
                setFiles(null);
                setLoadedPath("");
                setSelected([]);
                setRights(false);
                setShareResult(null);
              }}
              items={[
                { value: "", label: "选择已登录的本人账号" },
                ...data!.accounts
                  .filter(
                    (a) =>
                      a.provider === "baidu" &&
                      a.enabled &&
                      a.status === "connected",
                  )
                  .map((a) => ({ value: a.id, label: a.alias })),
              ]}
            />
          </Field>
          <Field label="目录路径">
            <input
              value={draft.value.path}
              onChange={(e) => {
                draft.update({ path: e.target.value });
                setRights(false);
              }}
              placeholder="/"
            />
          </Field>
        </div>
        <div className="operations-actions">
          <Button
            primary
            disabled={!draft.value.accountId || !!action.pending}
            onClick={() => read()}
          >
            读取目录
          </Button>
          <Button
            disabled={
              !draft.value.accountId || !!action.pending || current === "/"
            }
            onClick={() => read(current.replace(/\/[^/]+\/?$/, "") || "/")}
          >
            <ArrowUp size={14} />
            上一级
          </Button>
          <Button
            disabled={!files || !!action.pending}
            onClick={() => {
              setName("");
              setMutation({ action: "mkdir" });
            }}
          >
            新建文件夹
          </Button>
        </div>
      </Panel>
      <Panel title={files ? current : "文件列表"}>
        <QueryError error={error} onRetry={() => read()} />
        {files?.length ? (
          <>
            <div className="operations-table-scroll">
              <table className="operations-table">
                <thead>
                  <tr>
                    <th>
                      <SelectionCheckbox
                        aria-label="选择本页文件"
                        total={files.length}
                        selected={selected.length}
                        onChange={(e) => {
                          setSelected(
                            updateSelection(
                              selected,
                              files.map((f) => f.id),
                              e.target.checked,
                              100,
                            ),
                          );
                          setRights(false);
                        }}
                      />
                    </th>
                    <th>名称</th>
                    <th>大小</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((file) => (
                    <tr key={file.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`选择文件 ${file.name}`}
                          checked={selected.includes(file.id)}
                          onChange={(e) => {
                            setSelected(
                              updateSelection(
                                selected,
                                [file.id],
                                e.target.checked,
                                100,
                              ),
                            );
                            setRights(false);
                          }}
                        />
                      </td>
                      <td>
                        <button
                          className="operation-file-name"
                          disabled={!file.isDirectory || !!action.pending}
                          onClick={() => read(filePath(file))}
                        >
                          {file.isDirectory ? (
                            <Folder size={17} />
                          ) : (
                            <File size={17} />
                          )}
                          <span>{file.name}</span>
                        </button>
                      </td>
                      <td>
                        {file.isDirectory
                          ? "文件夹"
                          : file.size === null
                            ? "未知"
                            : `${(file.size / 1024 / 1024).toFixed(2)} MB`}
                      </td>
                      <td>
                        <div className="operation-row-actions">
                          <Button
                            quiet
                            size="compact"
                            disabled={!!action.pending}
                            onClick={() => {
                              setName(file.name);
                              setMutation({ action: "rename", file });
                            }}
                          >
                            重命名
                          </Button>
                          <Button
                            quiet
                            size="compact"
                            disabled={!!action.pending}
                            onClick={() =>
                              setMutation({ action: "delete", file })
                            }
                          >
                            删除
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={rights}
                onChange={(e) => setRights(e.target.checked)}
              />
              我有权分享所选文件，并用于问答模板
            </label>
            <div className="operations-actions">
              <span>已选{selected.length}项，最多100项</span>
              <Button
                primary
                disabled={!selected.length || !rights || !!action.pending}
                onClick={() =>
                  void action.run(
                    "drive.files.share",
                    {
                      accountId: draft.value.accountId,
                      path: current,
                      fileIds: selected,
                      rightsConfirmed: true,
                    },
                    (result) => {
                      setRights(false);
                      setShareResult(result);
                      notify(
                        `已核验归档${result.urls.length}个分享${result.failures.length ? `，${result.failures.length}项待处理` : ""}。`,
                        result.failures.length ? "warning" : "success",
                      );
                      void refresh().catch(() =>
                        notify(
                          "分享已完成；资源列表刷新失败，请稍后刷新。",
                          "warning",
                        ),
                      );
                    },
                  )
                }
              >
                分别分享并归档
              </Button>
              <Button quiet onClick={() => navigate("zhidao-templates")}>
                去生成问答模板
              </Button>
            </div>
          </>
        ) : files ? (
          <Empty title="此目录没有文件" />
        ) : action.pending === "drive.files" ? (
          <LoadingState label="正在读取目录…" />
        ) : (
          <Empty title="选择账号并读取目录">
            目录读取完成后显示文件，网盘操作由你主动触发。
          </Empty>
        )}
      </Panel>
      {shareResult?.failures.length ? (
        <Notice warning>
          {shareResult.failures.map((f) => (
            <p key={f.id}>
              {f.name}：{f.message}
            </p>
          ))}
          <Button
            quiet
            disabled={!!action.pending}
            onClick={() => setResetShare(true)}
          >
            已在平台核对未创建，准备重试
          </Button>
        </Notice>
      ) : null}
      {resetShare ? (
        <Dialog
          title="确认平台未创建分享"
          onClose={() => setResetShare(false)}
          busy={!!action.pending}
        >
          <Notice warning>
            请先在本人网盘核对这些项目。只有确认未生成分享，才清除未知请求记录；已有明确分享记录的项目仍会要求核对。
          </Notice>
          <div className="dialog-actions">
            <Button onClick={() => setResetShare(false)}>取消</Button>
            <Button
              disabled={!!action.pending}
              onClick={() =>
                void action.run(
                  "drive.share.reset",
                  {
                    accountId: draft.value.accountId,
                    fileIds: shareResult!.failures.map((f) => f.id),
                    confirmed: true,
                  },
                  () => {
                    setResetShare(false);
                    setShareResult(null);
                    setRights(false);
                  },
                  "已记录核对结果，请重新选择并确认分享",
                )
              }
            >
              确认未创建
            </Button>
          </div>
        </Dialog>
      ) : null}
      {mutation ? (
        <Dialog
          title={
            mutation.action === "mkdir"
              ? "新建文件夹"
              : mutation.action === "rename"
                ? "重命名网盘文件"
                : "删除网盘文件"
          }
          onClose={() => setMutation(null)}
          busy={!!action.pending}
        >
          {mutation.file ? <p>{filePath(mutation.file)}</p> : null}
          {mutation.action !== "delete" ? (
            <Field label="名称">
              <input
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
          ) : (
            <Notice warning>
              将从本人网盘删除此项目及其内容。关联资料的核验状态会失效，请确认选中的文件。
            </Notice>
          )}
          <div className="dialog-actions">
            <Button onClick={() => setMutation(null)}>取消</Button>
            <Button
              primary
              disabled={
                !!action.pending ||
                (mutation.action !== "delete" && !name.trim())
              }
              onClick={() =>
                void action.run(
                  "drive.manage",
                  {
                    accountId: draft.value.accountId,
                    action: mutation.action,
                    path: mutation.file ? filePath(mutation.file) : current,
                    name,
                    fileId: mutation.file?.id,
                    confirmed: true,
                  },
                  afterMutation,
                )
              }
            >
              {mutation.action === "delete" ? "确认删除" : "确认保存"}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </OperationsWorkspace>
  );
}

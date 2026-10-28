import { useState } from "react";
import type { RemoteFile } from "../../shared/types";
import type {
  DriveDirectory,
  DriveWriteReceipt,
} from "../../shared/drive-files";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { InsertionMaterials } from "../batch/InsertionMaterials";
import { Button, Field, Notice } from "../ui/primitives";
import { Dialog } from "../ui/Dialog";
import { QueryError } from "../ui/QueryError";
import "../batch/batch.css";

export interface DriveMutation {
  action: "mkdir" | "rename" | "delete" | "upload" | "replace";
  files: RemoteFile[];
  id: string;
}
const titles = {
  mkdir: "新建文件夹",
  rename: "重命名文件",
  delete: "删除 / 清理所选文件",
  upload: "插入广告素材",
  replace: "替换广告文件",
};

export function DriveMutationDialog({
  mutation,
  directory,
  workspace,
  onClose,
  onComplete,
}: {
  mutation: DriveMutation;
  directory: DriveDirectory;
  workspace: string;
  onClose(): void;
  onComplete(receipt: DriveWriteReceipt): void;
}) {
  const [name, setName] = useState(
    mutation.action === "rename" ? mutation.files[0].name : "",
  );
  const [material, setMaterial] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const advertisement =
    mutation.action === "upload" || mutation.action === "replace";
  const kinds =
    mutation.action === "replace"
      ? /\.txt$/i.test(mutation.files[0].name)
        ? (["txt"] as const)
        : (["image"] as const)
      : (["folder", "txt", "image"] as const);
  const library = useIpcQuery("insertion.materials", undefined, {
    enabled: advertisement,
    keepPrevious: true,
  });
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const location = {
        operationId: mutation.id,
        accountId: directory.accountId,
        path: directory.path,
        confirmed: true as const,
      };
      const receipt = advertisement
        ? await ipc("drive.material", {
            ...location,
            materialId: material,
            replace:
              mutation.action === "replace" ? mutation.files[0] : undefined,
          })
        : await ipc("drive.write", {
            ...location,
            action: mutation.action as "mkdir" | "rename" | "delete",
            files: mutation.files,
            name: mutation.action === "delete" ? undefined : name,
          });
      onComplete(receipt);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "提交失败，请核对后重试。",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={titles[mutation.action]}
      className={advertisement ? "drive-ad-dialog" : ""}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            primary
            disabled={
              busy ||
              !confirmed ||
              (advertisement
                ? !material || library.loading || !!library.error
                : mutation.action !== "delete" && !name.trim())
            }
            onClick={() => void submit()}
          >
            {busy
              ? "正在提交并核对…"
              : mutation.action === "delete"
                ? "确认删除所选项目"
                : mutation.action === "replace"
                  ? "备份原文件并替换"
                  : "确认写入本人网盘"}
          </Button>
        </>
      }
    >
      <p>
        目标目录：<strong>{directory.path}</strong>
      </p>
      {mutation.files.length ? (
        <ul className="drive-confirm-list">
          {mutation.files.map((f) => (
            <li key={f.id}>
              {f.name}
              {f.isDirectory ? "（含文件夹内全部内容）" : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {mutation.action === "delete" ? (
        <Notice warning>
          仅清理以上明确选中的项目。删除会同时影响文件夹内的内容，关联资料和分享需要重新核验。
        </Notice>
      ) : null}
      {mutation.action === "replace" ? (
        <Notice warning>
          先将原文件重命名为备份，再用所选素材写入原文件名。备份会保留在同一目录；失败时请先核对备份和目标文件。TXT、图片需要与原文件格式一致。
        </Notice>
      ) : null}
      {advertisement ? (
        <>
          <QueryError
            error={library.error}
            loading={library.loading}
            onRetry={library.reload}
          />
          <InsertionMaterials
            workspace={workspace}
            title="广告素材"
            compactEditor
            selectionLimit={1}
            kinds={kinds}
            materials={(library.data ?? []).filter((m) =>
              (kinds as readonly string[]).includes(m.kind),
            )}
            selected={material ? [material] : []}
            disabled={busy}
            libraryState={
              library.loading ? "loading" : library.error ? "error" : "ready"
            }
            onChanged={library.reload}
            onSelect={(id, checked) => {
              setMaterial(checked ? id : "");
              setConfirmed(false);
            }}
          />
        </>
      ) : mutation.action !== "delete" ? (
        <Field label="名称">
          <input
            value={name}
            disabled={busy}
            maxLength={160}
            onChange={(e) => {
              setName(e.target.value);
              setConfirmed(false);
            }}
          />
        </Field>
      ) : null}
      {error ? <Notice danger>{error}</Notice> : null}
      <label className="check">
        <input
          type="checkbox"
          disabled={busy}
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        我已核对本人网盘中的目标目录和所选项目
      </label>
    </Dialog>
  );
}

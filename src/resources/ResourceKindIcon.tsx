import { File, FileQuestion, Files, Folder, Folders } from "lucide-react";
import type { RemoteFile, ResourceCopy } from "../../shared/types";
import "./resource-kind.css";

/** Destination folderId is a transfer container, not the resource's type. */
export function resourceFiles(
  copies: ResourceCopy[],
  accountId = "all",
  copyId?: string,
) {
  const visible = copies.filter(
    (copy) => accountId === "all" || copy.accountId === accountId,
  );
  return (
    (visible.find((copy) => copy.id === copyId) ?? visible[0])?.files ?? []
  );
}

export function ResourceKindIcon({ files }: { files: RemoteFile[] }) {
  const folders = files.filter((file) => file.isDirectory).length;
  const [Icon, label, kind] = !files.length
    ? ([FileQuestion, "资源类型尚未读取", "unknown"] as const)
    : files.length === 1
      ? folders
        ? ([Folder, "文件夹", "folder"] as const)
        : ([File, "文件", "file"] as const)
      : folders
        ? ([
            Folders,
            folders === files.length ? "多个文件夹" : "多项资源（含文件夹）",
            "folder",
          ] as const)
        : ([Files, "多个文件", "file"] as const);
  return (
    <span
      className="resource-kind-icon"
      data-kind={kind}
      role="img"
      aria-label={label}
      title={label}
    >
      <Icon size={22} strokeWidth={1.5} aria-hidden="true" />
    </span>
  );
}

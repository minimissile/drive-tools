import { File, FileArchive, FileText } from "lucide-react";
import type { RemoteFile, ResourceCopy } from "../../shared/types";
import { resourceKind } from "../lib/resource-kind";
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

export function ResourceKindIcon({
  files,
  title,
}: {
  files: RemoteFile[];
  title?: string;
}) {
  const kind = resourceKind(files, title);
  const icons = {
    archive: [FileArchive, "压缩包"],
    file: [File, "文件"],
    document: [FileText, "文档"],
  } as const;
  const [Icon, label] = icons[kind];
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

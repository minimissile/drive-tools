import { z } from "zod";
import type { DriveDirectory } from "../../shared/drive-files";
import type { ResourceCopy } from "../../shared/types";
import type { VideoProject } from "../../shared/video";

export interface VideoDirectoryTarget {
  id: string;
  name: string;
  accountId: string;
  path: string;
}
const snapshotSchema = z
  .object({
    folderId: z.string().min(1),
    accountId: z.string().min(1),
    path: z.string().min(1),
    readAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    total: z.number().int().min(0),
    truncated: z.boolean(),
    entries: z
      .array(
        z.object({
          name: z.string().min(1).max(500),
          kind: z.enum(["folder", "file"]),
        }),
      )
      .max(120),
  })
  .refine((value) => value.entries.length === Math.min(120, value.total));
export type VideoDirectorySnapshot = z.infer<typeof snapshotSchema>;

function folderPath(parent: string, name: string) {
  if (
    !parent.startsWith("/") ||
    parent.includes("\\") ||
    parent.split("/").some((part) => part === "." || part === "..") ||
    !name ||
    name === "." ||
    name === ".." ||
    /[\\/]/.test(name)
  )
    throw new Error("文件夹名称或路径不正确，未读取资源范围外的内容。");
  return `${parent.replace(/\/$/, "")}/${name}`;
}

export function videoDirectoryTargets(
  copy: ResourceCopy,
): VideoDirectoryTarget[] {
  return copy.files
    .filter((file) => file.isDirectory)
    .flatMap((file) => {
      try {
        return [
          {
            id: file.id,
            name: file.name,
            accountId: copy.accountId,
            path: folderPath(copy.directory, file.name),
          },
        ];
      } catch {
        // Malformed historical metadata must not create a browse target outside
        // the resource. The original resource list remains available to the editor.
        return [];
      }
    });
}

export function videoDirectorySnapshotKey(
  scope: string,
  copyId: string,
  target: VideoDirectoryTarget,
) {
  // Attachment storage adds the current window ID. Path/account changes also
  // invalidate the snapshot even if a provider reuses a folder identifier.
  return `panxu-video-directory-v1:${JSON.stringify([scope, copyId, target.accountId, target.id, target.path])}`;
}

function matchesTarget(
  snapshot: VideoDirectorySnapshot,
  target: VideoDirectoryTarget,
) {
  return (
    snapshot.folderId === target.id &&
    snapshot.accountId === target.accountId &&
    snapshot.path.replace(/\/$/, "") === target.path.replace(/\/$/, "")
  );
}

export function readVideoDirectorySnapshot(
  raw: string | null | undefined,
  target: VideoDirectoryTarget,
) {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("文件夹目录暂存无法恢复，请重新读取。原记录已保留。");
  }
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success || !matchesTarget(parsed.data, target))
    throw new Error("文件夹目录暂存无法恢复，请重新读取。原记录已保留。");
  return parsed.data;
}

export function videoDirectorySnapshot(
  target: VideoDirectoryTarget,
  directory: DriveDirectory,
): VideoDirectorySnapshot {
  const entries: VideoProject["entries"] = directory.files
    .slice(0, 120)
    .map((file) => ({
      name: file.name.slice(0, 500),
      kind: file.isDirectory ? "folder" : "file",
    }));
  const snapshot = snapshotSchema.parse({
    folderId: directory.folderId,
    accountId: directory.accountId,
    path: directory.path,
    readAt: directory.readAt,
    total: directory.files.length,
    truncated: directory.files.length > 120,
    entries,
  });
  if (!matchesTarget(snapshot, target))
    throw new Error("读取到的文件夹与当前资源不一致，请重新核对资源目录。");
  return snapshot;
}

/** Fixed two-level read: never recursively scan a resource or count unseen files. */
export async function loadVideoDirectorySnapshot(
  target: VideoDirectoryTarget,
  browse: (accountId: string, path: string) => Promise<DriveDirectory>,
): Promise<VideoDirectorySnapshot> {
  const root = await browse(target.accountId, target.path);
  const snapshot = videoDirectorySnapshot(target, root);
  const folders = root.files.filter((file) => file.isDirectory);
  snapshot.truncated ||= folders.length > 12;
  let expanded = 0;
  for (const folder of folders) {
    if (expanded >= 12 || snapshot.entries.length >= 120) {
      snapshot.truncated = true;
      break;
    }
    const child = {
      id: folder.id,
      name: folder.name,
      accountId: target.accountId,
      path: folderPath(root.path, folder.name),
    };
    const directory = await browse(child.accountId, child.path);
    const checked = videoDirectorySnapshot(child, directory);
    const remaining = 120 - snapshot.entries.length;
    snapshot.total += checked.total;
    snapshot.entries.push(
      ...checked.entries.slice(0, remaining).map((entry) => ({
        name: `${folder.name}/${entry.name}`.slice(0, 500),
        kind: entry.kind,
      })),
    );
    snapshot.truncated ||= checked.total > remaining;
    expanded++;
  }
  return snapshotSchema.parse(snapshot);
}

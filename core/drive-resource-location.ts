import type { Account, RemoteFile, ResourceCopy } from "../shared/types";
import type { DriveProvider } from "./providers/provider";
import { normalizedDirectory } from "./providers/provider";
import type { DriveManagement } from "./drive-management";
import { AppError } from "./errors";

function containsResource(files: RemoteFile[], expected: RemoteFile[]) {
  return expected.every((file) =>
    files.some(
      (actual) =>
        actual.id === file.id && actual.isDirectory === file.isDirectory,
    ),
  );
}

/** Read-only lookup in the authenticated owner's drive. Never matches by name. */
export async function locateResourceParent(
  account: Account,
  provider: DriveProvider,
  copy: ResourceCopy,
  management: DriveManagement,
) {
  if (!account.uid || !copy.ownerUid || copy.ownerUid !== account.uid)
    throw new AppError(
      "OWNERSHIP_UNVERIFIED",
      "此资源尚未确认属于当前网盘账号，请先核验本人分享。",
    );
  if (!copy.files.length)
    throw new AppError(
      "RESOURCE_FILES_MISSING",
      "此资源没有已记录的本人文件清单，请先核验资源。",
    );
  const paths = new Set<string>();
  if (copy.folderId && copy.directory)
    paths.add(normalizedDirectory(copy.directory));
  const parents = copy.files.map((file) =>
    file.path?.startsWith("/")
      ? file.path.slice(0, file.path.lastIndexOf("/")) || "/"
      : null,
  );
  if (parents[0] !== null && parents.every((parent) => parent === parents[0]))
    paths.add(normalizedDirectory(parents[0]));
  for (const path of paths) {
    try {
      const directory = await management.resolveDirectory(
        account,
        provider,
        path,
      );
      if (containsResource(directory.files, copy.files)) return directory;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "DIRECTORY_CHANGED")
        throw error;
    }
  }
  // Directly recorded own shares often have no local path. Search only after the
  // user explicitly asks to locate this resource, with finite read limits.
  const queue = [
    { path: "/", id: account.provider === "baidu" ? "/" : "0", depth: 0 },
  ];
  const seen = new Set<string>();
  let entries = 0;
  for (let index = 0; index < queue.length; index++) {
    if (index >= 200)
      throw new AppError(
        "RESOURCE_LOOKUP_LIMIT",
        "已读取200个目录，尚未定位到此资源。请在网盘文件中确认原目录后更新资源清单。",
      );
    const current = queue[index];
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    const files = await provider.list(account, current.id);
    entries += files.length;
    if (entries > 10_000)
      throw new AppError(
        "RESOURCE_LOOKUP_LIMIT",
        "已读取10000个网盘项目，尚未定位到此资源。请先确认原目录后更新资源清单。",
      );
    if (containsResource(files, copy.files))
      return { path: current.path, folderId: current.id, files };
    if (current.depth >= 32) continue;
    for (const file of files) {
      if (!file.isDirectory) continue;
      const path = current.path.replace(/\/$/, "") + "/" + file.name;
      queue.push({
        path,
        id: account.provider === "baidu" ? (file.path ?? path) : file.id,
        depth: current.depth + 1,
      });
    }
  }
  throw new AppError(
    "RESOURCE_FILES_MISSING",
    "本人网盘中没有找到此资源的完整文件清单，文件可能已移动、删除或账号归属发生变化。",
  );
}

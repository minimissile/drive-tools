import type { Account } from "../shared/types";
import { AppError } from "./errors";
import { normalizedDirectory, type DriveProvider } from "./providers/provider";

/** Resolve an existing directory without creating folders or acquiring an account lock. */
export async function resolveDriveDirectory(
  account: Account,
  provider: DriveProvider,
  raw: string,
) {
  const path = normalizedDirectory(raw);
  const segments = path.split("/").filter(Boolean);
  if (segments.length > 32)
    throw new AppError(
      "DIRECTORY_DEPTH",
      "目录层级超过32层，请使用更浅的目录。",
    );
  let folderId = account.provider === "baidu" ? "/" : "0";
  let currentPath = "";
  for (const name of segments) {
    const matches = (await provider.list(account, folderId)).filter(
      (file) => file.name === name && file.isDirectory,
    );
    if (matches.length !== 1)
      throw new AppError(
        "DIRECTORY_CHANGED",
        "目录不存在或重名，请从上级目录重新选择。",
      );
    currentPath += "/" + name;
    folderId =
      account.provider === "baidu"
        ? (matches[0].path ?? currentPath)
        : matches[0].id;
  }
  return { path, folderId, files: await provider.list(account, folderId) };
}

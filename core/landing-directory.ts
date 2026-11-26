import { isLandingDocument } from "../shared/landing-document";
import type { Account, RemoteFile, ResourceCopy } from "../shared/types";
import { locateResourceParent } from "./drive-resource-location";
import { AppError } from "./errors";
import { extractLandingDocument, landingDocumentLimit } from "./landing-document";
import type { DriveProvider } from "./providers/provider";

const directoryLimit = 12;
const itemLimit = 400;
const skippedName = /^(?:请?先看|提取码|解压密码|扫码|广告|备用网址|防失联)/u;

/** Look for a readable source inside one verified resource folder. */
export async function readLandingFolder(
  account: Account,
  provider: DriveProvider,
  copy: ResourceCopy,
  folderId: string,
) {
  if (!provider.readFile)
    throw new AppError(
      "UNSUPPORTED",
      "当前网盘暂不支持直接读取目录内正文。",
    );
  const root = copy.files.find(
    (file) => file.id === folderId && file.isDirectory,
  );
  if (!root || !copy.verifiedAt || copy.status !== "ready")
    throw new AppError("DOCUMENT_REQUIRED", "请选择当前已核验资源的文件夹。");
  const parent = await locateResourceParent(account, provider, copy);
  const actual = parent.files.find(
    (file) => file.id === root.id && file.isDirectory && file.name === root.name,
  );
  if (!actual)
    throw new AppError("FILES_CHANGED", "网盘目录已变化，请重新核对资源。");

  const queue = [{ folder: actual, depth: 1 }];
  const visited = new Set<string>();
  const candidates: RemoteFile[] = [];
  let entries = 0;
  while (queue.length && visited.size < directoryLimit && entries < itemLimit) {
    const { folder, depth } = queue.shift()!;
    if (visited.has(folder.id)) continue;
    if (provider.id === "baidu" && !folder.path?.startsWith("/")) continue;
    visited.add(folder.id);
    const parentId = provider.id === "baidu" ? folder.path! : folder.id;
    const nodes = await provider.list(account, parentId);
    const available = nodes.slice(0, itemLimit - entries);
    entries += available.length;
    for (const file of available) {
      if (file.isDirectory) {
        if (
          depth < 3 &&
          queue.length < directoryLimit &&
          !skippedName.test(file.name)
        )
          queue.push({ folder: file, depth: depth + 1 });
      } else if (
        isLandingDocument(file.name) &&
        !skippedName.test(file.name) &&
        (file.size == null || (file.size > 0 && file.size <= landingDocumentLimit))
      ) {
        candidates.push(file);
      }
    }
    if (candidates.some((file) => /\.(?:pdf|docx)$/i.test(file.name))) break;
  }

  const priority = (file: RemoteFile) => Number(/\.(?:pdf|docx)$/i.test(file.name));
  candidates.sort((a, b) => priority(b) - priority(a));
  for (const file of candidates.slice(0, 3)) {
    const bytes = await provider.readFile(account, file, landingDocumentLimit);
    if (file.size != null && file.size !== bytes.length)
      throw new AppError("DOCUMENT_MISMATCH", "目录内文件大小已变化，请重新读取。");
    try {
      const reading = await extractLandingDocument(file.name, bytes);
      return {
        ...reading,
        fileId: file.id,
        copyId: copy.id,
        rootFolder: { id: root.id, name: root.name },
      };
    } catch (error) {
      if (!(error instanceof AppError) || !error.code.startsWith("DOCUMENT_")) throw error;
    }
  }
  throw new AppError(
    "LANDING_FOLDER_NO_DOCUMENT",
    "已在资源目录中查找，未能读取可用的 PDF、DOCX 或文本正文。",
  );
}

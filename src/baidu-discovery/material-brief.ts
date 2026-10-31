import type { ShareInput } from "../../shared/types";
import { ipc } from "../api/client";

// A brief needs representative names, rather than an exhaustive remote scan.
const directoryReadLimit = 6;
const directoryDepthLimit = 3;
const namesPerDirectory = 12;
type PackageNames = { line: number; names: string[]; limited: boolean };
const checkStopped = (signal: AbortSignal) => {
  if (signal.aborted) throw new Error("已停止读取，原有资料依据已保留。");
};

async function readPackageNames(
  share: ShareInput,
  line: number,
  signal: AbortSignal,
) {
  const result: PackageNames = { line, names: [], limited: false };
  const queue = [{ parentId: "0", path: "", depth: 0, page: 1 }];
  const seen = new Set(["0"]);
  let reads = 0;
  while (queue.length && reads < directoryReadLimit) {
    checkStopped(signal);
    const directory = queue.shift()!;
    const inspection = await ipc("baiduDiscovery.inspectShare", {
      sourceText: share.url,
      code: share.code,
      parentId: directory.parentId,
      page: directory.page,
    });
    checkStopped(signal);
    reads++;
    const files = inspection.files.slice(0, namesPerDirectory);
    if (files.length < inspection.files.length) result.limited = true;
    for (const file of files) {
      const name = file.name.replace(/[\r\n\t]/g, " ");
      const path = directory.path ? `${directory.path}/${name}` : name;
      result.names.push(`${file.isDirectory ? "[文件夹]" : "[文件]"} ${path}`);
      if (!file.isDirectory) continue;
      if (directory.depth + 1 >= directoryDepthLimit) {
        result.limited = true;
        continue;
      }
      // Baidu's share/list uses the folder path, rather than fs_id, as dir.
      if (!file.path)
        throw new Error(
          "网盘未返回文件夹路径，暂时无法读取包内目录，请稍后重试。",
        );
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      queue.push({
        parentId: file.path,
        path,
        depth: directory.depth + 1,
        page: 1,
      });
    }
    if (inspection.hasMore) {
      result.limited = true;
      // Prefer entering the sampled folders before reading more root entries.
      queue.push({
        ...directory,
        page: directory.page + 1,
      });
    }
  }
  if (queue.length) result.limited = true;
  if (!result.names.length) throw new Error("分享中没有可读取的文件或文件夹。");
  return result;
}

export async function readMaterialBrief({
  links,
  signal,
  onProgress,
}: {
  links: string;
  signal: AbortSignal;
  onProgress(message: string): void;
}) {
  const lines = links
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length || lines.length > 100)
    throw new Error("请先填写1–100条百度网盘链接，每行一条，可附提取码。");
  const shares: { share: ShareInput; line: number }[] = [];
  const seen = new Set<string>();
  for (const [index, text] of lines.entries()) {
    checkStopped(signal);
    try {
      const share = await ipc("share.parse", { text });
      if (share.provider !== "baidu") throw new Error("仅支持百度网盘链接。");
      const key = `${share.shareKey}:${share.code}`;
      if (!seen.has(key)) {
        seen.add(key);
        shares.push({ share, line: index + 1 });
      }
    } catch (cause) {
      throw new Error(
        `第${index + 1}条链接：${cause instanceof Error ? cause.message : "链接识别失败，请检查。"}`,
      );
    }
  }
  const packages: PackageNames[] = [];
  for (const [index, { share, line }] of shares.entries()) {
    checkStopped(signal);
    onProgress(`正在读取资源包 ${index + 1}/${shares.length}…`);
    try {
      packages.push(await readPackageNames(share, line, signal));
    } catch (cause) {
      checkStopped(signal);
      const error = new Error(
        `第${line}条链接：${cause instanceof Error ? cause.message : "目录读取失败，请重试。"} 原有资料依据已保留。`,
      );
      if (cause instanceof Error && "code" in cause)
        Object.assign(error, { code: cause.code });
      throw error;
    }
  }
  checkStopped(signal);
  const intro =
    "资料依据：以下名称来自网盘资源包内部的文件、文件夹，保留相对目录关系。";
  const conclusion =
    "仅根据这些名称概括资料主题和可能涉及的内容；未读取文件正文，不要将名称推断写成已核实的事实，不要虚构版本、完整性、出处或效果。资料使用建议应与问题相关。";
  // Give every package space, including when many links are pasted together.
  const perPackage = Math.floor(
    (6000 - intro.length - conclusion.length - 10) / packages.length,
  );
  let shortened = false;
  const sections = packages.map((entry) => {
    const heading = `链接${entry.line} · 包内名称${entry.limited ? "（采样）" : ""}：\n`;
    const text = entry.names.join("\n");
    const budget = perPackage - heading.length - 2;
    const truncated = text.length > budget;
    if (truncated) shortened = true;
    return heading + (truncated ? text.slice(0, budget - 1) + "…" : text);
  });
  return {
    brief: [intro, ...sections, conclusion].join("\n\n"),
    packageCount: packages.length,
    nameCount: packages.reduce((sum, entry) => sum + entry.names.length, 0),
    sampled: shortened || packages.some((entry) => entry.limited),
  };
}

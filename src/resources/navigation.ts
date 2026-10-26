import { Flame, FolderSearch, FolderOpen } from "lucide-react";

export const discoveryEntries = [
  {
    page: "zhidao-mine",
    title: "热门挖词",
    description: "从八类榜单发现具体资源名称",
    Icon: Flame,
  },
  {
    page: "zhidao-collect",
    title: "资源采集",
    description: "按关键词搜索链接，接续转存分享",
    Icon: FolderSearch,
  },
] as const;
export const driveFilesEntry = {
  page: "drive-files",
  title: "网盘文件",
  description: "浏览、管理与分享本人百度网盘文件",
  Icon: FolderOpen,
} as const;
export const resourceToolEntries = [...discoveryEntries, driveFilesEntry];

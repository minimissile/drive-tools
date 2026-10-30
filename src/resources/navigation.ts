import { Flame, FolderSearch, FolderOpen, Search } from "lucide-react";

export const discoveryEntries = [
  {
    page: "baidu-discovery",
    title: "百度批量扩词",
    description: "采集联想词与相关搜索，继续扩词、去重导出",
    Icon: Search,
  },
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
  description: "浏览全部本人网盘，管理资源与广告文件",
  Icon: FolderOpen,
} as const;
export const resourceToolEntries = [...discoveryEntries, driveFilesEntry];

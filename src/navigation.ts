import {
  ChartNoAxesCombined,
  FileOutput,
  FilePlus2,
  Files,
  Fingerprint,
  FolderTree,
  LayoutDashboard,
  Library,
  ListChecks,
  NotebookPen,
  Plug,
  Radar,
  Send,
  Share2,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { Page } from "./state";
import { operationEntries } from "./zhidao/navigation";
import { discoveryEntries, driveFilesEntry } from "./resources/navigation";

interface NavigationEntry {
  page: Page;
  title: string;
  Icon: LucideIcon;
  group?: string;
}
export interface WorkbenchEntry extends NavigationEntry {
  description: string;
}

export const sidebarEntries: NavigationEntry[] = [
  { page: "workbench", title: "工作台", Icon: LayoutDashboard },
  { page: "library", title: "资源库", Icon: Library, group: "内容资产" },
  { page: "traffic", title: "流量发现", Icon: Radar, group: "内容规划" },
  { page: "search", title: "搜索运营", Icon: Workflow },
  { page: "distribution", title: "内容分发", Icon: Share2 },
  {
    page: "share-statistics",
    title: "分享统计",
    Icon: ChartNoAxesCombined,
    group: "运营复盘",
  },
  { page: "accounts", title: "账号管理", Icon: Users, group: "工作空间" },
  { page: "browser-environments", title: "指纹浏览器", Icon: Fingerprint },
  { page: "settings", title: "连接与设置", Icon: Plug },
];
export const resourceOperations: WorkbenchEntry[] = [
  driveFilesEntry,
  {
    page: "intake",
    title: "录入资源",
    description: "整理链接、资料说明与封面",
    Icon: FilePlus2,
  },
  {
    page: "resource-export",
    title: "AI 资源导出",
    description: "按需求筛选资源并导出清单",
    Icon: FileOutput,
  },
  {
    page: "batch",
    title: "批量处理",
    description: "导入资料、批量转存与插入素材",
    Icon: Files,
  },
  {
    page: "split",
    title: "资料拆分",
    description: "选择目录项，生成独立本人分享",
    Icon: FolderTree,
  },
  {
    page: "tasks",
    title: "转存任务",
    description: "查看进度、核对异常与恢复任务",
    Icon: ListChecks,
  },
];
export const contentOperations: WorkbenchEntry[] = [
  { page: "pipix-sources", title: "皮皮虾采集", description: "采集图文与评论，共用于知乎、微博等渠道草稿", Icon: Library },
  {page:"resource-answers", title:"资源问答", description:"围绕问题和资源生成文字、图片与图文，逐版校准", Icon:NotebookPen},
  {
    page: "studio",
    title: "内容工作室",
    description: "制作文案、图片、组图与视频",
    Icon: NotebookPen,
  },
  {
    page: "publish",
    title: "发布准备",
    description: "审阅交付内容，打开窗口并回填链接",
    Icon: Send,
  },
];
export const csdnOperations: WorkbenchEntry[] = [
  {
    page: "csdn-workflow",
    title: "CSDN 自动创作与发布",
    description: "选词配资料，审阅后自动填写与提交",
    Icon: Workflow,
  },
  {
    page: "csdn-studio",
    title: "CSDN 教程创作",
    description: "关联本人资料，创作与审阅技术教程",
    Icon: NotebookPen,
  },
  {
    page: "csdn-publish",
    title: "CSDN 发布准备",
    description: "交付 Markdown，记录提交与审核结果",
    Icon: Send,
  },
];
export const weiboOperations: WorkbenchEntry[] = [
  { page: "weibo-marketing", title: "微博图文营销", description: "选词配资料，准备图文包，回填发布与效果", Icon: Send },
];
export const zhihuOperations: WorkbenchEntry[] = [
  { page: "zhihu-operations", title: "知乎多号运营", description: "比特多号养号、素材审核、错峰发布与结果核对", Icon: Send },
];
export const smzdmOperations: WorkbenchEntry[] = [
  {
    page: "smzdm-workflow",
    title: "什么值得买文章分发",
    description: "导入公众号文章，关联本人资源，编辑检查后发布",
    Icon: NotebookPen,
  },
];

export const workbenchEntries: readonly WorkbenchEntry[] = [
  ...discoveryEntries,
  ...resourceOperations,
  ...operationEntries,
  ...csdnOperations,
  ...weiboOperations,
  ...zhihuOperations,
  ...smzdmOperations,
  ...contentOperations,
];

const accountPages: Page[] = [
  "accounts",
  "website-accounts",
  "smzdm-accounts",
  "zhidao-accounts",
];
export function sidebarPage(page: Page): Page {
  if (accountPages.includes(page)) return "accounts";
  return sidebarEntries.some((entry) => entry.page === page)
    ? page
    : "workbench";
}
export function pageTitle(page: Page) {
  if (accountPages.includes(page)) return "账号管理";
  const target = page === "bulk" ? "batch" : page;
  return [...sidebarEntries, ...workbenchEntries].find(
    (entry) => entry.page === target,
  )?.title;
}

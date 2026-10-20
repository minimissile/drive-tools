import type { Page } from "../state";
import {
  Flame,
  FolderSearch,
  MessageSquareText,
  FilePenLine,
  Send,
  FolderOpen,
  Users,
} from "lucide-react";
export const operationEntries = [
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
  {
    page: "zhidao-qa",
    title: "智能问答",
    description: "手动创作回答或运行账号答题任务",
    Icon: MessageSquareText,
  },
  {
    page: "zhidao-templates",
    title: "问答模板",
    description: "用本人资源生成、编辑和导出问答",
    Icon: FilePenLine,
  },
  {
    page: "zhidao-publish",
    title: "发布任务",
    description: "审核后上传模板，登记平台任务",
    Icon: Send,
  },
  {
    page: "drive-files",
    title: "网盘文件",
    description: "浏览、管理与分享本人百度网盘文件",
    Icon: FolderOpen,
  },
  {
    page: "zhidao-accounts",
    title: "知道账号",
    description: "登录、核对身份和快捷答题资格",
    Icon: Users,
  },
] as const satisfies readonly {
  page: Page;
  title: string;
  description: string;
  Icon: typeof Users;
}[];
export const operationPage = {
  mine: "zhidao-mine",
  collect: "zhidao-collect",
  answer: "zhidao-qa",
  template: "zhidao-templates",
  publish: "zhidao-publish",
} as const;

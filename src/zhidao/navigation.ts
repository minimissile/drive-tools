import type { Page } from "../state";
import { MessageSquareText, FilePenLine, Send } from "lucide-react";
export const operationEntries = [
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
] as const satisfies readonly {
  page: Page;
  title: string;
  description: string;
  Icon: typeof MessageSquareText;
}[];
export const operationPage = {
  mine: "zhidao-mine",
  collect: "zhidao-collect",
  answer: "zhidao-qa",
  template: "zhidao-templates",
  publish: "zhidao-publish",
} as const;

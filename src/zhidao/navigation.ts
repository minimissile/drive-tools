import type { Page } from "../state";
import { MessageSquareText, Send, Search } from "lucide-react";
export const operationEntries = [
  {
    page: "zhidao-page-discovery",
    title: "网盘回答发现",
    description: "批量发现回答正文含网盘链接的百度知道页面",
    Icon: Search,
  },
  {
    page: "zhidao-qa",
    title: "智能问答",
    description: "手动创作回答或运行账号答题任务",
    Icon: MessageSquareText,
  },
  {
    page: "zhidao-publish",
    title: "问答发布",
    description: "生成问答、审核上传，跟进发布与审核记录",
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
  template: "zhidao-publish",
  publish: "zhidao-publish",
} as const;

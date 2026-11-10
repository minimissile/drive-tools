import { z } from "zod";

export const systemLogQuery = z.object({
  page: z.number().int().min(1).max(100000).default(1),
  domain: z.string().trim().max(80).default(""),
  level: z.enum(["issues", "warning", "error"]).default("issues"),
  range: z.enum(["24h", "7d", "30d", "all"]).default("7d"),
  search: z.string().trim().max(200).default(""),
});
export interface SystemLogEntry {
  id: string;
  domain: string;
  level: "warning" | "error";
  event: string;
  message: string;
  accountId: string | null;
  taskId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}
export interface SystemLogPage {
  items: SystemLogEntry[];
  total: number;
  page: number;
  pageSize: number;
  domains: string[];
}
export interface SystemLogContract {
  "systemLogs.list": {
    args: z.input<typeof systemLogQuery>;
    value: SystemLogPage;
  };
}
const labels: Record<string, string> = {
  system: "系统",
  ai: "AI 服务",
  api: "外部服务",
  wechat: "微信公众号",
  zhihu: "知乎",
  "zhihu-autocare": "知乎养号",
  "zhihu-participation": "知乎互动",
  tieba: "贴吧",
  "tieba-autocare": "贴吧养号",
  "tieba-automation": "贴吧自动运营",
  "tieba-participation": "贴吧互动",
  "tieba-publishing": "贴吧发布",
  "tieba-topics": "贴吧话题",
  "tieba-insights": "贴吧洞察",
  "content-supply": "内容供给",
  "intelligent-operations": "智能运营",
  weibo: "微博",
  csdn: "CSDN",
  zhidao: "百度知道",
  pipix: "皮皮虾",
  resource: "资源管理",
  account: "网盘账号",
  "website-accounts": "其他账号",
  studio: "内容工作室",
  video: "视频制作",
  music: "配乐",
  bilibili: "哔哩哔哩",
  "resource-landing": "资源落地页",
  "resource-catalog": "资源清单",
  search: "搜索运营",
  settings: "连接与设置",
};
export const systemLogDomainLabel = (domain: string) =>
  labels[domain] ?? domain;

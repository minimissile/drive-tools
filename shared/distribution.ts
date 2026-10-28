import { z } from "zod";

export const distributionPlatformId = z.enum(["esoua", "panku8", "repanso"]);
export type DistributionPlatformId = z.infer<typeof distributionPlatformId>;
export const distributionStatus = z.enum([
  "ready",
  "verifying",
  "submitting",
  "uncertain",
  "blocked",
  "waiting_login",
  "waiting_rules",
  "submitted",
  "processing",
  "reviewing",
  "published",
  "rejected",
  "failed",
  "skipped",
  "superseded",
]);
export type DistributionStatus = z.infer<typeof distributionStatus>;
export const distributionSubmittedStatuses: readonly DistributionStatus[] = [
  "submitted",
  "processing",
  "reviewing",
  "published",
  "rejected",
];
export const distributionStatusLabels: Record<DistributionStatus, string> = {
  ready: "待分发",
  verifying: "核验分享中",
  submitting: "提交中",
  uncertain: "结果待核对",
  blocked: "分享未就绪",
  waiting_login: "待登录",
  waiting_rules: "待核实规则",
  submitted: "已提交",
  processing: "处理中",
  reviewing: "待审核",
  published: "已收录",
  rejected: "未通过",
  failed: "提交失败",
  skipped: "已跳过",
  superseded: "旧链接已替换",
};
export interface DistributionPlatform {
  id: DistributionPlatformId;
  name: string;
  host: string;
  submitUrl: string;
  loginUrl: string | null;
  login: "required" | "not_observed";
  format: "links" | "unverified";
  batchLimit: number | null;
  dailyLimit: number | null;
  characterLimit: number | null;
  checkedAt: string;
  summary: string;
  rules: string[];
  unknowns: string[];
  stages: DistributionStatus[];
}
const commonStages: DistributionStatus[] = [
  "ready",
  "submitted",
  "processing",
  "reviewing",
  "published",
  "rejected",
  "failed",
  "skipped",
];
export const distributionPlatforms: readonly DistributionPlatform[] = [
  {
    id: "esoua",
    name: "爱搜",
    host: "www.esoua.com",
    submitUrl: "https://www.esoua.com/submit",
    loginUrl: null,
    login: "not_observed",
    format: "links",
    batchLimit: 500,
    dailyLimit: null,
    characterLimit: 50000,
    checkedAt: "2026-10-26",
    summary: "批量链接导入，后台异步处理",
    rules: [
      "每行一个完整分享链接，建议带提取码。",
      "单次提交建议不超过 500 条，盘序按此检查单批数量。",
      "后台处理，提交后通过原页面的“查询状态”核对。",
      "禁止带广告性质和版权争议的资源，广告资源可能被屏蔽并加入黑名单。",
    ],
    unknowns: [
      "未登录页面可见提交按钮；实际提交是否有额外验证尚未实测。",
      "未见公开每日限额、处理时限与完整状态枚举。",
      "UC、光鸭、PikPak 等其他网盘未在投稿页明确列出，兼容性需另行确认。",
    ],
    stages: commonStages,
  },
  {
    id: "panku8",
    name: "盘库吧",
    host: "panku8.com",
    submitUrl: "https://panku8.com/m/user/resource_add",
    loginUrl: "https://panku8.com/m/user/login",
    login: "required",
    format: "unverified",
    batchLimit: null,
    dailyLimit: null,
    characterLimit: null,
    checkedAt: "2026-10-26",
    summary: "邮箱登录后投稿，表单规则待核实",
    rules: [
      "投稿入口会跳转登录页，需要邮箱与密码登录。",
      "每个平台保留一个常用会话，在官网自行登录。",
    ],
    unknowns: [
      "登录后的必填字段、资源类别、支持的网盘、单次与每日限额待核实。",
      "审核机制与结果查询入口待核实；自动分发暂不可用。",
    ],
    stages: [
      "waiting_rules",
      "waiting_login",
      "ready",
      "submitted",
      "reviewing",
      "published",
      "rejected",
      "failed",
      "skipped",
    ],
  },
  {
    id: "repanso",
    name: "热盘搜",
    host: "repanso.net",
    submitUrl: "https://repanso.net/submit",
    loginUrl: "https://repanso.net/login?redirect=%2Fsubmit",
    login: "required",
    format: "links",
    batchLimit: 1000,
    dailyLimit: 10000,
    characterLimit: 50000,
    checkedAt: "2026-10-26",
    summary: "登录后批量导入，按用户限制每日条数",
    rules: [
      "必须使用用户名 / 邮箱与密码登录后才能提交资源。",
      "严格一行一条链接，建议带提取码，否则可能解析失败。",
      "单次提交建议不超过 1,000 条；每日每用户限 10,000 条。",
      "输入区显示 50,000 字符上限，盘序同时检查字数。",
      "禁止引流信息，包括图片二维码；违规可能封号。",
      "同一份资源禁止生成多个分享链接重复提交。",
      "提交后在原页面使用“查询状态”核对处理与审核结果。",
    ],
    unknowns: [
      "每日限额重置时区、处理时限和完整状态枚举未公开。",
      "盘序只能统计本地登记的提交，官网其他提交仍需自行核对。",
      "UC、光鸭、PikPak 等其他网盘未在投稿页明确列出，兼容性需另行确认。",
    ],
    stages: ["waiting_login", ...commonStages],
  },
];
export function distributionPlatform(
  id: DistributionPlatformId,
): DistributionPlatform {
  return distributionPlatforms.find((platform) => platform.id === id)!;
}
export interface DistributionReadiness {
  status:
    | "ready"
    | "login_required"
    | "rules_required"
    | "verification_required"
    | "unavailable";
  message: string;
  checkedAt: string;
}
export type DistributionRunState =
  | "idle"
  | "scanning"
  | "ready"
  | "running"
  | "pausing"
  | "paused"
  | "blocked"
  | "completed";
export interface DistributionRun {
  state: DistributionRunState;
  scanned: number;
  message: string;
  updatedAt: string;
  startedAt: string | null;
}
export interface DistributionTask {
  id: string;
  platformId: DistributionPlatformId;
  shareRecordId: string;
  resourceId: string;
  copyId: string;
  splitItemId: string | null;
  title: string;
  provider: string;
  shareUrl: string;
  shareVersion: number;
  status: DistributionStatus;
  message: string;
  batchId: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
}
export interface DistributionEvent {
  id: number;
  at: string;
  status: DistributionStatus;
  note: string;
  receipt: string;
  url: string;
}
export interface DistributionPlatformSummary {
  platform: DistributionPlatform;
  alias: string;
  note: string;
  total: number;
  historyTotal: number;
  delivered: number;
  pending: number;
  published: number;
  submitted: number;
  processing: number;
  reviewing: number;
  failed: number;
  uncertain: number;
  blocked: number;
  skipped: number;
  active: number;
  resourceCount: number;
  submittedToday: number;
  run: DistributionRun;
  readiness: DistributionReadiness | null;
}
export interface DistributionOverview {
  library: { resources: number; readyShares: number; unreadyResources: number };
  platforms: DistributionPlatformSummary[];
}
export interface DistributionPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface DistributionBatch {
  id: string;
  status: string;
  count: number;
  message: string;
  receipt: string;
  createdAt: string;
  submittedAt: string | null;
  completedAt: string | null;
}
export interface DistributionSubmitResult {
  status:
    | "accepted"
    | "rejected"
    | "login_required"
    | "verification_required"
    | "uncertain";
  message: string;
  receipt: string;
}
export const distributionListInput = z.object({
  platformId: distributionPlatformId,
  query: z.string().max(200).default(""),
  status: z.union([distributionStatus, z.literal("all")]).default("all"),
  page: z.number().int().min(1).default(1),
});
export const distributionResolveInput = z.object({
  taskId: z.string().min(1).max(100),
  status: z.enum([
    "submitted",
    "processing",
    "reviewing",
    "published",
    "rejected",
    "failed",
    "skipped",
  ]),
  note: z.string().trim().min(1, "请填写官网结果或处理说明。").max(2000),
  receipt: z.string().trim().max(500).default(""),
  url: z.string().trim().max(2000).default(""),
});
export interface DistributionContract {
  "distribution.overview": { args: undefined; value: DistributionOverview };
  "distribution.list": {
    args: z.input<typeof distributionListInput>;
    value: DistributionPage<DistributionTask> & {
      platformId: DistributionPlatformId;
    };
  };
  "distribution.prepare": {
    args: { platformId: DistributionPlatformId };
    value: boolean;
  };
  "distribution.start": {
    args: { platformId: DistributionPlatformId; rightsConfirmed: true };
    value: boolean;
  };
  "distribution.pause": {
    args: { platformId: DistributionPlatformId };
    value: boolean;
  };
  "distribution.retry": {
    args: { platformId: DistributionPlatformId };
    value: { updated: number };
  };
  "distribution.resolve": {
    args: z.input<typeof distributionResolveInput>;
    value: boolean;
  };
  "distribution.history": {
    args: { taskId: string; page?: number };
    value: DistributionPage<DistributionEvent>;
  };
  "distribution.batches": {
    args: { platformId: DistributionPlatformId; page?: number };
    value: DistributionPage<DistributionBatch>;
  };
  "distribution.open": {
    args: { platformId: DistributionPlatformId; page: "submit" | "login" };
    value: boolean;
  };
  "distribution.configure": {
    args: { platformId: DistributionPlatformId; alias: string; note: string };
    value: boolean;
  };
}

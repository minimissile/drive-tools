import { z } from "zod";

export const distributionPlatformId = z.enum([
  "esoua",
  "panku8",
  "repanso",
  "yiso",
  "pikasoo",
]);
export type DistributionPlatformId = z.infer<typeof distributionPlatformId>;
export const distributionStatus = z.enum([
  "ready",
  "preparing",
  // Retained for records created before direct use of saved library links.
  "verifying",
  "waiting_verification",
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
  preparing: "准备提交中",
  verifying: "核验分享中",
  waiting_verification: "待人工打码",
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
  login: "required" | "not_required" | "not_observed";
  format: "links" | "unverified";
  batchLimit: number | null;
  dailyLimit: number | null;
  characterLimit: number | null;
  checkedAt: string;
  summary: string;
  rules: string[];
  unknowns: string[];
  stages: DistributionStatus[];
  supportedProviders?: readonly string[];
  distinctResource?: boolean;
  manualVerification?: boolean | "website";
  localBatchLimit?: number;
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
    manualVerification: "website",
    batchLimit: 500,
    dailyLimit: null,
    characterLimit: 50000,
    checkedAt: "2026-10-26",
    summary: "批量链接导入，运行中在官网完成人工验证",
    rules: [
      "每行一个完整分享链接，建议带提取码。",
      "点击提交后会打开官网安全验证；请在官网完成验证，官网随后会继续提交本批。",
      "单次提交建议不超过 500 条，盘序按此检查单批数量。",
      "后台处理，提交后通过原页面的“查询状态”核对。",
      "禁止带广告性质和版权争议的资源，广告资源可能被屏蔽并加入黑名单。",
    ],
    unknowns: [
      "2026-11-05 公开投稿脚本确认提交前需人工验证；已补上显示原页面并等待的代码，真实投稿回执仍待验收。",
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
    distinctResource: true,
  },
  {
    id: "yiso",
    name: "易搜",
    host: "yiso.fun",
    submitUrl: "https://yiso.fun/submit",
    loginUrl: null,
    login: "not_required",
    format: "links",
    batchLimit: null,
    dailyLimit: null,
    characterLimit: null,
    checkedAt: "2026-10-31",
    summary: "无需账号，逐条等待官网处理结果",
    rules: [
      "官网目前支持阿里、夸克、百度、迅雷；当前资源库可分发其中的夸克、百度和迅雷分享。",
      "每行一个永久有效的分享链接；有提取码时必须拼接到 URL，否则不会收录。",
      "相同链接只收录一次；同一份资源反复霸屏可能被拉黑，盘序跳过整份资源的重复链接变体。",
      "每个会话只允许一个投稿页面。提交后必须等所有链接识别完成，不能立即关闭页面。",
      "盘序每批只提交 1 条，取得对应链接的官网结果后再处理下一条，批次间隔 5 秒。",
    ],
    unknowns: [
      "官网未公开单批和每日限额；本地逐条提交上限不代表平台配额。",
      "直接使用资源库已保存的本人分享与提取码，不重新查询有效期；是否符合永久有效要求由官网处理。",
      "真实投稿尚未验收；开头的成功提示不是最终回执，未知结果会暂停并保留官网页面供核对。",
    ],
    stages: commonStages,
    supportedProviders: ["quark", "baidu", "xunlei"],
    distinctResource: true,
  },
  {
    id: "pikasoo",
    name: "皮卡搜索",
    host: "www.pikasoo.top",
    submitUrl: "https://www.pikasoo.top/",
    loginUrl: null,
    login: "not_required",
    format: "links",
    batchLimit: null,
    localBatchLimit: 100,
    dailyLimit: null,
    characterLimit: null,
    checkedAt: "2026-10-31",
    summary: "支持批量链接，每批由你手动输入验证码",
    rules: [
      "从首页“分享投稿”打开投稿表单，多个链接以换行分隔。",
      "同一批多行链接与一个验证码一起提交；验证码错误时官网会刷新，需要重新输入。",
      "收录范围为阿里、夸克、百度、天翼、蓝奏；当前资源库发送其中的夸克和百度分享。",
      "盘序自动填写本批链接，你在官网窗口输入验证码后，回盘序点击“提交本批”。",
      "官网每隔一段时间处理收录；本地“已提交”只表示整批投稿已被接受，不代表逐条收录。",
    ],
    unknowns: [
      "官网未公开单批数量、字数、每日限额及收录时限；盘序本地每批最多 100 条，不代表平台配额。",
      "批量上限及真实投稿尚未实测；遇未知回执会暂停，不自动重投。",
    ],
    stages: ["waiting_verification", ...commonStages],
    supportedProviders: ["quark", "baidu"],
    manualVerification: true,
  },
];
export function distributionBatchSize(platform: DistributionPlatform) {
  return Math.min(100, platform.batchLimit ?? platform.localBatchLimit ?? 1);
}
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
  | "waiting_verification"
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
  /** Only a definite captcha rejection may safely put this batch back into the queue. */
  notAccepted?: boolean;
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
    args: { platformId: DistributionPlatformId };
    value: boolean;
  };
  "distribution.pause": {
    args: { platformId: DistributionPlatformId };
    value: boolean;
  };
  "distribution.continue": {
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

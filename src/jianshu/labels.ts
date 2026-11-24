import type { JianshuStage } from "../../shared/jianshu";
import type { WebsiteAccountView } from "../../shared/website-accounts";
export const jianshuAccountLabel = (account: WebsiteAccountView) =>
  `${account.nickname || account.alias}${account.unverified ? " · 待核验" : account.status === "expired" ? " · 登录已失效" : account.status === "connected" ? "" : " · 待登录"}`;
export const stageLabels: Record<JianshuStage, string> = {
  editing: "草稿",
  preparing: "正在填写",
  prepared: "待官网发布",
  uncertain: "待核对",
  published: "已发布",
};
export const localServiceError = (error: string) =>
  /不支持此操作|UNKNOWN_METHOD/.test(error)
    ? "简书服务尚未加载。请先点击顶部“应用更新并重启”，再重试当前操作。"
    : error;

import type { WechatStage } from "../../shared/wechat";
export const stageLabel: Record<WechatStage, string> = {
  editing: "待编辑",
  sending: "发送中",
  synced: "已存微信",
  uncertain: "待核对",
};

export const channelNames: Record<string, string> = {
  zhihu: "知乎",
  weibo: "微博",
  wechat: "公众号",
};
export const taskNames: Record<string, string> = {
  warming: "养号内容",
  regular: "正式内容",
  publish: "发布内容",
  progress: "创作进度检查",
  statistics: "效果数据检查",
  check: "账号进度检查",
  reconcile: "发布结果核对",
  handoff: "人工交接",
  supply: "等待素材补充",
};
export const stateNames: Record<string, string> = {
  planned: "待执行",
  queued: "已排队",
  running: "执行中",
  submitted: "已提交",
  completed: "已完成",
  published: "已发布",
  paused: "已暂停",
  deferred: "已顺延",
  blocked: "等待条件",
  attention: "待本人处理",
  cancelled: "已取消",
  awaiting_review: "待审核",
  review: "待审核",
  waiting: "等待条件",
  handoff: "待交接",
  failed: "待处理",
  delegated: "渠道处理中",
};
export function stateKind(
  state: string,
): "good" | "warning" | "normal" | "danger" {
  return ["completed", "published"].includes(state)
    ? "good"
    : ["attention", "failed"].includes(state)
      ? "danger"
      : ["blocked", "review", "awaiting_review", "handoff"].includes(state)
        ? "warning"
        : "normal";
}

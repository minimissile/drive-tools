export const zhidaoPublishLimit = 100;
export const zhidaoTaskNameLimit = 15;
export const zhidaoQuestionTitleLimit = 49;

export function zhidaoContentIssue(item: { question: string; answer: string }) {
  if (!item.question.trim()) return "请先填写问题标题";
  if (item.question.trim().length > zhidaoQuestionTitleLimit)
    return `标题当前${item.question.trim().length}字，需缩短到${zhidaoQuestionTitleLimit}字以内`;
  if (!item.answer.trim()) return "请先填写回答内容";
  return "";
}

export interface ZhidaoPublishingRights {
  hasPermission: boolean;
  isBanned: boolean;
  quota: number | null;
  usedQuota: number | null;
  remainingQuota: number | null;
}

export interface ZhidaoUploadTask {
  id: string;
  taskName: string;
  status: "pending" | "running" | "finished" | "unknown";
  successCount: number | null;
  failCount: number | null;
  usedQuota: number | null;
}

export interface ZhidaoPublishReceipt extends ZhidaoUploadTask {
  checkedAt: string;
}

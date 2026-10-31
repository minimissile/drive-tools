import { zhidaoQuestionIssue, zhidaoAnswerIssue } from "./zhidao-content";
export { zhidaoQuestionTitleLimit } from "./zhidao-content";

export const zhidaoPublishLimit = 100;
export const zhidaoTaskNameLimit = 15;

export interface QuestionDraftInsertResult {
  added: number;
  duplicates: number;
  titleIssues: number;
  runId: string | null;
}

export function zhidaoContentIssue(item: { question: string; answer: string }) {
  return zhidaoQuestionIssue(item.question) || zhidaoAnswerIssue(item.answer);
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

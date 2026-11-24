import { z } from "zod";
export const accountBatchPolicy = {
  concurrency: 3,
  minStaggerMs: 400,
  maxStaggerMs: 1000,
  maxAccounts: 100,
} as const;
export const accountBatchInput = z.object({
  scope: z.enum(["drive", "other"]),
  provider: z.string().min(1).max(60),
  action: z.enum(["verify", "refresh"]),
  accountIds: z
    .array(z.string().min(1).max(150))
    .min(1)
    .max(accountBatchPolicy.maxAccounts),
});
export type AccountBatchInput = z.infer<typeof accountBatchInput>;
export const accountBatchItemSchema = z.object({
  id: z.string(),
  alias: z.string(),
  status: z.enum([
    "queued",
    "running",
    "success",
    "warning",
    "failed",
    "cancelled",
  ]),
  message: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type AccountBatchItem = z.infer<typeof accountBatchItemSchema>;
export const accountBatchSchema = z.object({
  id: z.string(),
  scope: z.enum(["drive", "other"]),
  provider: z.string(),
  providerName: z.string(),
  action: z.enum(["verify", "refresh"]),
  status: z.enum([
    "running",
    "stopping",
    "completed",
    "cancelled",
    "interrupted",
  ]),
  items: z.array(accountBatchItemSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AccountBatch = z.infer<typeof accountBatchSchema>;
export const accountBatchActive = (batch: AccountBatch | null | undefined) =>
  batch?.status === "running" || batch?.status === "stopping";
export const accountBatchItemLabel: Record<AccountBatchItem["status"], string> =
  {
    queued: "等待启动",
    running: "正在处理",
    success: "已完成",
    warning: "部分完成",
    failed: "失败",
    cancelled: "未执行",
  };
export interface AccountBatchContract {
  "accountBatch.start": { args: AccountBatchInput; value: AccountBatch };
  "accountBatch.current": { args: undefined; value: AccountBatch | null };
  "accountBatch.stop": { args: { id: string }; value: AccountBatch };
}

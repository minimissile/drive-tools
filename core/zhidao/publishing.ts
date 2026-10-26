import { AppError } from "../errors";
import { xlsx } from "../export-formats";
import type { OperationItem } from "../../shared/zhidao";
import type { ZhidaoPublishingRights } from "../../shared/zhidao-publishing";

export function bulkData(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError(
      "ZHIDAO_RESPONSE",
      "百度答主工作台返回格式已变化，请打开官方页面核对。",
    );
  if ("code" in value) {
    if (![0, 200, "0", "200"].includes(value.code))
      throw new AppError(
        "ZHIDAO_REJECTED",
        String(
          value.msg ||
            value.message ||
            `百度答主工作台返回错误（${value.code}）。`,
        ).slice(0, 300),
      );
    return value.data;
  }
  return value;
}

export const quotaNumber = (value: unknown): number | null => {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^\d+$/.test(value))
  )
    return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};
const flag = (value: unknown) => value === true || value === 1 || value === "1";

export function publishingRights(
  value: unknown,
): ZhidaoPublishingRights & { uid?: string } {
  const data = bulkData(value);
  if (!data || ![true, false, 0, 1, "0", "1"].includes(data.hasPermission))
    throw new AppError(
      "ZHIDAO_PERMISSION",
      "无法读取批量上传权限，请检查登录后刷新资格与额度。",
    );
  const quota = quotaNumber(data.quota),
    usedQuota = quotaNumber(data.usedQuota);
  return {
    hasPermission: flag(data.hasPermission),
    isBanned: flag(data.isBanned),
    quota,
    usedQuota,
    remainingQuota:
      quota !== null && usedQuota !== null
        ? Math.max(0, quota - usedQuota)
        : null,
    ...(data.uid != null ? { uid: String(data.uid) } : {}),
  };
}

export function assertPublishingRights(
  rights: ZhidaoPublishingRights,
  count: number,
) {
  if (rights.isBanned)
    throw new AppError(
      "PUBLISH_BANNED",
      "此账号的批量上传权益受限，请在答主工作台核对账号状态。",
    );
  if (!rights.hasPermission)
    throw new AppError(
      "NO_BULK_PERMISSION",
      "此账号暂无批量上传权限，请登录答主工作台确认资格。",
    );
  if (rights.remainingQuota !== null && count > rights.remainingQuota)
    throw new AppError(
      "PUBLISH_QUOTA",
      `当前剩余额度${rights.remainingQuota}条，待上传${count}条；请减少所选问答或等待额度恢复。`,
    );
}

/** Official upload template: an empty qid creates a new question and answer. */
export function publicationWorkbook(
  items: Pick<OperationItem, "question" | "answer">[],
) {
  return xlsx(
    [
      ["qid", "问题标题", "回答内容"],
      ...items.map((item) => ["", item.question, item.answer]),
    ],
    "问答结果",
  );
}

export function uploadReceipt(value: unknown): {
  taskId: string;
  rejected: boolean;
  message: string;
} {
  let data: any;
  try {
    data = bulkData(value);
  } catch (error) {
    if (error instanceof AppError && error.code === "ZHIDAO_REJECTED")
      return { taskId: "", rejected: true, message: error.message };
    return { taskId: "", rejected: false, message: "平台响应无法识别" };
  }
  const raw = data?.taskId ?? data?.id;
  const taskId =
    typeof raw === "string"
      ? raw.trim()
      : Number.isSafeInteger(raw) && raw > 0
        ? String(raw)
        : "";
  return {
    taskId: taskId.length <= 100 ? taskId : "",
    rejected: false,
    message: "",
  };
}

export function publicationFingerprint(question: string, answer: string) {
  return JSON.stringify(
    [question, answer].map((text) =>
      text.normalize("NFKC").replace(/\s+/g, " ").trim(),
    ),
  );
}

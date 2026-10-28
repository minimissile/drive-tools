import { AppError } from "../errors";
import type { AppPorts } from "../ports";
import {
  collectionWebSpecs,
  type CollectionWebSource,
} from "../../shared/resource-collection";

export async function collectionWebSearch(
  session: AppPorts["collectionWebSession"],
  source: CollectionWebSource,
  keyword: string,
  page: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const name = collectionWebSpecs[source].name;
  if (!session)
    throw new AppError(
      "COLLECTION_WEB_UNAVAILABLE",
      "当前环境缺少网页采集会话，请使用源码桌面窗口。",
    );
  let response: { status: number; body: string };
  try {
    response = await session.search(source, keyword, page, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof AppError) throw error;
    throw new AppError(
      "COLLECTION_WEB_FAILED",
      `${name}网页请求未完成，请打开原站检查网络、登录或验证后继续任务。`,
    );
  }
  signal.throwIfAborted();
  if ([401, 403, 429].includes(response.status))
    throw new AppError(
      "COLLECTION_WEB_ACTION",
      `${name}${response.status === 429 ? "请求过于频繁，请稍后重试" : "需要登录或安全验证，请打开原站完成后继续任务"}。`,
    );
  if (response.status >= 400)
    throw new AppError(
      "COLLECTION_WEB_HTTP",
      `${name}网页返回 HTTP ${response.status}，请稍后继续任务。`,
    );
  try {
    const value: unknown = JSON.parse(response.body);
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {}
  throw new AppError(
    "COLLECTION_WEB_RESPONSE",
    `${name}网页未返回可识别结果，请打开原站检查后继续任务。`,
  );
}

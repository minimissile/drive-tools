import type { AppPorts } from "../ports";
import { AppError } from "../errors";
import { readLimited } from "../http";
import { assertSourcePage } from "./parsers";
import { bulkData, publishingRights, quotaNumber } from "./publishing";
import type { ZhidaoUploadTask } from "../../shared/zhidao-publishing";

export type SourceFetch = (
  url: string,
  signal?: AbortSignal,
) => Promise<string>;
export const zhidaoQuestionPageSize = 8;
export interface ZhidaoQuestion {
  qid: string | number;
  question: string;
  answered?: boolean;
  sourceBase?: number;
}
export interface ZhidaoQuestionPage {
  items: ZhidaoQuestion[];
  nextBase: number;
  hasMore: boolean;
  total?: number;
}
export function parseZhidaoJson(body: string) {
  // Question IDs exceed Number.MAX_SAFE_INTEGER; keep their original digits.
  return JSON.parse(
    body.replace(
      /(?<!\\)("(?:id|qid|aid|taskId|userId|uid)"\s*:\s*)(\d{16,})(?=\s*[,}])/g,
      '$1"$2"',
    ),
  );
}
export const sourceFetch: SourceFetch = async (url, signal) => {
  const response = await fetch(url, {
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
      : AbortSignal.timeout(25000),
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
  });
  if (!response.ok)
    throw new AppError(
      "SOURCE_HTTP",
      `来源返回 HTTP ${response.status}，请稍后重试。`,
    );
  const body = await readLimited(response, 4_000_000);
  assertSourcePage(body);
  return body;
};
export class ZhidaoClient {
  constructor(private session: AppPorts["zhidaoSession"]) {}
  private async request(
    accountId: string,
    path: string,
    init: RequestInit = {},
  ) {
    if (!this.session)
      throw new AppError(
        "SESSION_UNAVAILABLE",
        "当前桌面环境不支持百度知道会话。",
      );
    const url = new URL(path, "https://zhidao.baidu.com");
    if (url.origin !== "https://zhidao.baidu.com")
      throw new AppError("INVALID_URL", "知道请求目标不正确。");
    const result = await this.session.request(accountId, url.href, init);
    if (result.status >= 400)
      throw new AppError(
        "ZHIDAO_HTTP",
        `百度知道返回 HTTP ${result.status}，请检查账号和网络。`,
      );
    return result.body;
  }
  async json(
    accountId: string,
    path: string,
    init?: RequestInit,
  ): Promise<any> {
    const body = await this.request(accountId, path, init);
    assertSourcePage(body);
    try {
      return parseZhidaoJson(body);
    } catch {
      throw new AppError(
        "ZHIDAO_RESPONSE",
        "百度知道返回格式已变化，请检查登录或稍后重试。",
      );
    }
  }
  text(accountId: string, path: string, signal?: AbortSignal) {
    return this.request(accountId, path, { signal });
  }
  async identity(accountId: string) {
    const value = await this.json(accountId, "/api/logininfo");
    const uid = String(value.userId ?? value.uid ?? value.userName ?? "");
    if (![true, 1, "1"].includes(value.isLogin) || !value.stoken || !uid)
      throw new AppError(
        "AUTH_EXPIRED",
        "百度知道登录已失效，请登录后重新检查。",
      );
    return {
      uid,
      nickname: String(value.userName ?? "百度知道用户"),
      stoken: String(value.stoken),
    };
  }
  async permission(accountId: string) {
    const rights = await this.publishingRights(accountId);
    return rights.hasPermission && !rights.isBanned;
  }
  async publishingRights(accountId: string) {
    return publishingRights(
      await this.json(accountId, "/qa/api/bulkqa/userinfo", {
        cache: "no-store",
      }),
    );
  }
  async uploadTasks(accountId: string, page: number, taskName?: string) {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: "50",
      ...(taskName ? { taskName } : {}),
    });
    const data = bulkData(
      await this.json(accountId, `/qa/api/bulkqa/tasks?${params}`, {
        cache: "no-store",
      }),
    );
    if (!data || !Array.isArray(data.list) || quotaNumber(data.total) === null)
      throw new AppError(
        "ZHIDAO_RESPONSE",
        "无法读取平台上传记录，请在答主工作台核对。",
      );
    const list: ZhidaoUploadTask[] = data.list.map((item: any) => {
      if (
        !item ||
        item.id == null ||
        !["string", "number"].includes(typeof item.id)
      )
        throw new AppError(
          "ZHIDAO_RESPONSE",
          "平台上传记录缺少任务ID，请在答主工作台核对。",
        );
      return {
        id: String(item.id),
        taskName: String(item.taskName ?? ""),
        status:
          ({ "0": "pending", "1": "running", "2": "finished" } as const)[
            String(item.status) as "0" | "1" | "2"
          ] ?? "unknown",
        successCount: quotaNumber(item.successCount),
        failCount: quotaNumber(item.failCount),
        usedQuota: quotaNumber(item.usedTotal),
      };
    });
    return { list, total: quotaNumber(data.total)! };
  }
  async questions(
    accountId: string,
    category: string,
    base: number,
  ): Promise<ZhidaoQuestionPage> {
    const value = await this.json(
      accountId,
      `/qa/api/query/result/category?${new URLSearchParams({ category, rn: String(zhidaoQuestionPageSize), base: String(base) })}`,
      { cache: "no-store" },
    );
    if (value.code !== 200 || !Array.isArray(value.data?.list))
      throw new AppError(
        "QUESTION_RESPONSE",
        "题库读取失败或结构已变化，已保留现有回答。",
      );
    return {
      items: value.data.list as ZhidaoQuestion[],
      ...(Number.isSafeInteger(value.data.total) && value.data.total >= 0
        ? { total: value.data.total as number }
        : {}),
      nextBase: Number(value.data.base ?? base + value.data.list.length),
      hasMore:
        value.data.hasMore == null
          ? base + value.data.list.length < Number(value.data.total ?? 0)
          : [true, 1, "1"].includes(value.data.hasMore),
    };
  }
  async answer(
    accountId: string,
    qid: string,
    content: string,
    stoken: string,
  ) {
    return this.json(accountId, "/msubmit/answer", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-ik-token": stoken,
        Referer: `https://zhidao.baidu.com/question/hx/${qid}?activity=21th&qpi=21th_activity`,
      },
      body: new URLSearchParams({
        qid,
        content,
        stoken,
        from_source: "hx",
        anonymous: "0",
        rich: "0",
        feedback: "0",
        feedback_rid: "0",
        activity: "21th",
        qpi: "21th_activity",
      }).toString(),
    });
  }
  async upload(accountId: string, taskName: string, bytes: Buffer) {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(bytes)], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      "问答模板.xlsx",
    );
    form.append("taskName", taskName);
    return this.json(accountId, "/qa/api/bulkqa/upload", {
      method: "POST",
      body: form,
    });
  }
}

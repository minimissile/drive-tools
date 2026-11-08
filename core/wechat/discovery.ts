import { id, now, type Database } from "../database";
import { AppError } from "../errors";
import { readLimited } from "../http";
import type { AppPorts } from "../ports";
import type { SecretStore } from "../secrets";
import { budgetDayStart, micros } from "../traffic";
import { decodeHtml, plainHtml } from "../zhidao/parsers";
import { wechatArticleUrl } from "../../shared/smzdm";
import {
  wechatDiscoveryRequestUsd,
  type WechatDiscoveryArticle,
  type WechatDiscoverySearchResult,
  type WechatDiscoveryStatsResult,
  type wechatDiscoverySearch,
  type wechatDiscoveryStatsInput,
} from "../../shared/wechat-discovery";
import type { z } from "zod";

export const wechatDiscoveryPaths = {
  search: "/api/v1/wechat_search/v2/fetch_search",
  stats: "/api/v1/wechat_mp/v2/fetch_article_stats",
} as const;

const credential = "pipix:tikhub";
const ledger = "tikhub:wechat";
const dailyLimit = 50;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown, limit: number) =>
  typeof value === "string" ? plainHtml(value).slice(0, limit) : "";
const count = (value: unknown): number | null => {
  const number =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number >= 0
    ? number
    : null;
};
const disabled = (value: unknown) =>
  value === false || value === 0 || value === "0";
const enabled = (value: unknown) =>
  value === true || value === 1 || value === "1";

function articleLink(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(decodeHtml(value), "https://mp.weixin.qq.com");
    if (url.protocol === "http:") url.protocol = "https:";
    if (!wechatArticleUrl.safeParse(url.href).success) return null;
    url.hash = "";
    if (url.pathname !== "/s") {
      url.search = "";
      return url.href;
    }
    const fields = new URLSearchParams();
    for (const field of ["__biz", "mid", "idx", "sn", "chksm"]) {
      const item = url.searchParams.get(field);
      if (item) fields.set(field, item);
    }
    if (
      !fields.has("__biz") ||
      !fields.has("mid") ||
      !fields.has("idx") ||
      !fields.has("sn")
    )
      return null;
    url.search = fields.toString();
    return url.href;
  } catch {
    return null;
  }
}

function articleDate(value: unknown) {
  const numeric = count(value);
  const time =
    numeric !== null && numeric > 0
      ? numeric * (numeric < 10_000_000_000 ? 1_000 : 1)
      : typeof value === "string" &&
          /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?/.test(value)
        ? Date.parse(
            /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
              ? value
              : `${value.replace(" ", "T")}${value.length === 10 ? "T00:00:00" : ""}+08:00`,
          )
        : NaN;
  return time >= Date.UTC(2010, 0, 1) && time <= Date.now() + 86400_000
    ? new Date(time).toISOString()
    : null;
}

function searchResult(
  data: Record<string, unknown>,
  cursor?: string,
): WechatDiscoverySearchResult {
  if (!Array.isArray(data.items)) {
    if (typeof data.no_more === "string" && data.no_more.trim())
      return { items: [], nextCursor: null, total: null };
    throw new AppError(
      "WECHAT_DISCOVERY_RESPONSE",
      "TikHub 返回的搜索结果格式异常，请稍后重试。",
    );
  }
  const items = new Map<string, WechatDiscoveryArticle>();
  for (const value of data.items) {
    const row = record(value);
    if (!row) continue;
    const source = record(row.source);
    const jump = record(row.jumpInfo);
    const url = [
      row.doc_url,
      row.url,
      row.link,
      row.article_url,
      row.jumpUrl,
      jump?.jumpUrl,
      jump?.url,
    ]
      .map(articleLink)
      .find((link) => link !== null);
    const title = text(row.title, 240);
    if (!url || !title || items.has(url)) continue;
    items.set(url, {
      url,
      title,
      accountName: text(
        source?.title ?? row.nickname ?? row.accountName ?? jump?.nickName,
        100,
      ),
      summary: text(row.desc ?? row.summary, 360),
      publishedAt:
        [
          row.timestamp,
          row.date,
          row.create_time,
          row.createTime,
          row.publish_time,
          row.publishTime,
          source?.dateTime,
        ]
          .map(articleDate)
          .find((date) => date !== null) ?? null,
    });
  }
  if (data.items.length && !items.size)
    throw new AppError(
      "WECHAT_DISCOVERY_RESPONSE",
      "TikHub 返回了搜索结果，但未识别到有效的公众号文章链接。",
    );
  const next = data.cursor;
  return {
    items: [...items.values()],
    nextCursor:
      enabled(data.continue_flag) &&
      typeof next === "string" &&
      next.length > 0 &&
      next.length <= 20_000 &&
      next !== cursor
        ? next
        : null,
    total: count(data.total),
  };
}

class DiscoveryError extends AppError {
  constructor(
    message: string,
    readonly stopBatch: boolean,
  ) {
    super("WECHAT_DISCOVERY_REQUEST", message);
  }
}

function responseError(status: number) {
  if (status === 401 || status === 403)
    return new DiscoveryError(
      "TikHub 凭据无效或无权访问此接口，请检查数据源设置。",
      true,
    );
  if (status === 402)
    return new DiscoveryError("TikHub 余额不足，请检查账户余额。", true);
  if (status === 429)
    return new DiscoveryError("TikHub 请求频繁，请稍后手动重试。", true);
  return new DiscoveryError(
    `TikHub 请求未成功（HTTP ${status}），请稍后手动重试。`,
    status >= 500,
  );
}

export class WechatDiscovery {
  private active = false;
  private abort = new AbortController();

  constructor(
    private dependencies: {
      db: Database;
      secrets: Pick<SecretStore, "has" | "get">;
      request?: AppPorts["wechatDiscoveryFetch"];
    },
  ) {}

  get isBusy() {
    return this.active;
  }

  close() {
    this.abort.abort();
  }

  config() {
    return { configured: this.dependencies.secrets.has(credential) };
  }

  discover(input: z.output<typeof wechatDiscoverySearch>) {
    return this.withKey(async (key) => {
      const data = await this.request("search", key, {
        keyword: input.keyword,
        business_type: "article",
        sort: input.sort ?? "default",
        publish_time: input.publishTime ?? "all",
        cursor: input.cursor,
        raw: false,
      });
      return searchResult(data, input.cursor);
    });
  }

  stats(
    input: z.output<typeof wechatDiscoveryStatsInput>,
  ): Promise<WechatDiscoveryStatsResult> {
    return this.withKey(async (key) => {
      const result: WechatDiscoveryStatsResult = { items: [], failures: [] };
      let stopped = false;
      for (const url of new Set(input.urls)) {
        if (stopped) {
          result.failures.push({
            url,
            message: "本批后续查询已暂停，请检查前一条提示。",
          });
          continue;
        }
        try {
          const data = await this.request("stats", key, { url, raw: true });
          if (disabled(data.get_data_succ))
            throw new DiscoveryError("微信未返回该文章的互动数据。", false);
          result.items.push({
            url,
            readCount: disabled(data.show_read) ? null : count(data.read_num),
            likeCount: disabled(data.show_like) ? null : count(data.like_count),
            commentCount: disabled(data.comment_enabled)
              ? null
              : count(data.comment_count),
            shareCount: disabled(data.show_share)
              ? null
              : count(data.share_count),
            collectCount: disabled(data.show_collect)
              ? null
              : count(data.collect_count),
            checkedAt: now(),
          });
        } catch (error) {
          if (!(error instanceof DiscoveryError)) throw error;
          result.failures.push({ url, message: error.message });
          stopped = error.stopBatch;
        }
      }
      return result;
    });
  }

  private async withKey<T>(run: (key: string) => Promise<T>) {
    if (this.active || this.abort.signal.aborted)
      throw new AppError(
        "WECHAT_DISCOVERY_BUSY",
        "正在查询公众号文章，请等待当前查询完成。",
      );
    this.active = true;
    try {
      const key = await this.dependencies.secrets.get(credential);
      if (!key)
        throw new AppError(
          "WECHAT_DISCOVERY_KEY",
          "请先在数据源设置中保存 TikHub API Key。",
        );
      if (this.abort.signal.aborted)
        throw new AppError("WECHAT_CLOSED", "当前工作空间已关闭。");
      return await run(key);
    } finally {
      this.active = false;
    }
  }

  private async request(
    kind: keyof typeof wechatDiscoveryPaths,
    key: string,
    body: Record<string, unknown>,
  ) {
    const { db, request = fetch } = this.dependencies;
    const requestId = id("api");
    if (this.abort.signal.aborted)
      throw new DiscoveryError("当前工作空间已关闭。", true);
    db.transaction(() => {
      const used =
        db.get<{ count: number }>(
          "SELECT COUNT(*) count FROM api_calls WHERE endpoint=? AND created_at>=?",
          ledger,
          budgetDayStart(),
        )?.count ?? 0;
      if (used >= dailyLimit)
        throw new DiscoveryError(
          `已到公众号发现每日 ${dailyLimit} 次 TikHub 查询上限。`,
          true,
        );
      db.run(
        "INSERT INTO api_calls(id,endpoint,phase,units,estimated_micros,status,created_at) VALUES(?,?,?,1,?,'reserved',?)",
        requestId,
        ledger,
        kind,
        micros(wechatDiscoveryRequestUsd),
        now(),
      );
    });
    let status: number | undefined;
    try {
      const response = await request(
        `https://api.tikhub.io${wechatDiscoveryPaths[kind]}`,
        {
          method: "POST",
          signal: AbortSignal.any([
            this.abort.signal,
            AbortSignal.timeout(45000),
          ]),
          redirect: "error",
          credentials: "omit",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      status = response.status;
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw responseError(status);
      }
      const payload = record(
        JSON.parse(await readLimited(response, 4_000_000)),
      );
      const code = count(payload?.code);
      if (code !== null && code !== 200) throw responseError(code);
      const data = record(payload?.data);
      if (!data)
        throw new DiscoveryError(
          "TikHub 未返回可用数据，请稍后手动重试。",
          false,
        );
      if (this.abort.signal.aborted)
        throw new DiscoveryError("当前工作空间已关闭。", true);
      db.run(
        "UPDATE api_calls SET status='success',message=? WHERE id=?",
        `HTTP ${status}，金额以 TikHub 结算为准`,
        requestId,
      );
      return data;
    } catch (error) {
      const failure =
        error instanceof DiscoveryError
          ? error
          : new DiscoveryError(
              status === undefined
                ? "TikHub 请求未完成，请检查网络。服务端可能已处理并计费。"
                : "TikHub 响应未能读取，请稍后手动重试。",
              true,
            );
      if (!this.abort.signal.aborted)
        db.run(
          "UPDATE api_calls SET status=?,message=? WHERE id=?",
          status === undefined ? "uncertain" : "error",
          failure.message,
          requestId,
        );
      throw failure;
    }
  }
}

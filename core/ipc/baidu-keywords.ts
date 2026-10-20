import { z } from "zod";
import {
  baiduKeywordInputSchema,
  baiduKeywordColumns,
  baiduKeywordResultSchema,
  type BaiduKeywordResult,
} from "../../shared/baidu-keywords";
import { websiteAccountIdSchema } from "../../shared/website-accounts";
import { parseBaiduKeywordResponse } from "../baidu-keywords";
import { AppError } from "../errors";
import { csv } from "../csv";
import type { HandlerMap, HandlerServices } from "./types";
export function createBaiduKeywordHandlers(
  services: Pick<
    HandlerServices,
    "db" | "ports" | "websiteAccounts" | "traffic"
  >,
) {
  const archive = (result: BaiduKeywordResult) => {
    try {
      result.knowledge = services.traffic.knowledge.ingestBaidu(result);
      delete result.knowledgeWarning;
    } catch {
      delete result.knowledge;
      result.knowledgeWarning =
        "本次查询已成功，但本地词库入库失败。可重试本地入库，无需重新查询百度。";
    }
    return result;
  };
  const cacheKey = (accountId: string) => `baidu-keywords:latest:${accountId}`;
  return {
    "baiduKeywords.export": async (object) => {
      const v = z
        .object({
          accountId: websiteAccountIdSchema,
          resultId: z.string().max(100),
        })
        .parse(object);
      const account = await services.websiteAccounts.check(v.accountId);
      const row = services.db.get<{ value: string }>(
        "SELECT value FROM api_cache WHERE key=?",
        cacheKey(v.accountId),
      );
      const result = row
        ? baiduKeywordResultSchema.parse(JSON.parse(row.value))
        : null;
      if (
        !result ||
        result.id !== v.resultId ||
        result.accountUid !== account.uid ||
        result.input.accountId !== account.id
      )
        throw new AppError(
          "BAIDU_RESULT_MISSING",
          "未找到当前账号的本地查询记录，请先保存需要的词池。",
        );
      return services.ports.saveFile(
        `百度关键词-${result.fetchedAt.slice(0, 10)}.csv`,
        Buffer.from(
          csv([
            [
              "关键词",
              ...baiduKeywordColumns.map(([, label]) => label),
              "采集时间",
            ],
            ...result.keywords.map((k) => [
              k.word,
              ...baiduKeywordColumns.map(([field]) => k.metrics[field] ?? null),
              k.fetchedAt,
            ]),
          ]),
        ),
      );
    },
    "baiduKeywords.latest": async (object) => {
      const { accountId } = z
        .object({ accountId: websiteAccountIdSchema })
        .parse(object);
      const account = await services.websiteAccounts.check(accountId);
      if (account.provider !== "baidu-marketing")
        throw new AppError("WEBSITE_PROVIDER_MISMATCH", "请选择百度营销账号。");
      const row = services.db.get<{ value: string }>(
        "SELECT value FROM api_cache WHERE key=? AND expires_at>?",
        cacheKey(accountId),
        new Date().toISOString(),
      );
      if (!row) return null;
      try {
        const result = baiduKeywordResultSchema.parse(JSON.parse(row.value));
        return result.input.accountId === accountId &&
          result.accountUid === account.uid
          ? archive(result)
          : null;
      } catch {
        throw new AppError(
          "BAIDU_CACHE_INVALID",
          "本地百度查询记录无法读取，请重试读取或重新查询。",
        );
      }
    },
    "baiduKeywords.query": async (object) => {
      const input = baiduKeywordInputSchema.parse(object);
      return services.websiteAccounts.use(
        input.accountId,
        "baidu-marketing",
        async (account) => {
          if (!services.ports.baiduKeywords)
            throw new AppError(
              "BAIDU_SESSION_UNAVAILABLE",
              "当前环境不支持百度检索，请使用桌面开发窗口。",
            );
          let result: BaiduKeywordResult;
          try {
            result = parseBaiduKeywordResponse(
              input,
              await services.ports.baiduKeywords.query(account, input),
            );
          } catch (error) {
            if (
              error instanceof AppError &&
              error.code === "BAIDU_LOGIN_REQUIRED"
            )
              await services.websiteAccounts.expire(account.id);
            throw error;
          }
          archive(result);
          try {
            services.db.run(
              "INSERT INTO api_cache(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at",
              cacheKey(account.id),
              JSON.stringify(result),
              new Date(Date.now() + 30 * 86400_000).toISOString(),
            );
          } catch {
            result.warning =
              "查询已成功，但本地记录写入失败。请保存需要的词池后再离开，无需重复查询。";
          }
          return result;
        },
      );
    },
  } satisfies HandlerMap;
}

import { z } from "zod";
import {
  baiduResearchInputSchema,
  baiduResearchResultSchema,
  baiduToolSchema,
  type BaiduResearchResult,
} from "../../shared/baidu-research";
import { baiduKeywordInputSchema } from "../../shared/baidu-keywords";
import { websiteAccountIdSchema } from "../../shared/website-accounts";
import {
  parseBaiduData,
  parseBaiduResearchResponse,
  validateBaiduResearchData,
} from "../baidu-research";
import { AppError } from "../errors";
import { csv } from "../csv";
import { readXlsx } from "../table-files";
import { baiduTaskKeywordChunks } from "../baidu-result-table";
import type { HandlerMap, HandlerServices } from "./types";

export function createBaiduResearchHandlers(
  s: Pick<HandlerServices, "db" | "ports" | "websiteAccounts" | "traffic">,
) {
  const notAvailable = () =>
    new AppError(
      "BAIDU_SESSION_UNAVAILABLE",
      "当前环境不支持百度工具，请使用源码桌面开发窗口。",
    );
  const cache = (key: string, value: unknown) =>
    s.db.run(
      "INSERT INTO api_cache(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at",
      key,
      JSON.stringify(value),
      new Date(Date.now() + 30 * 86400_000).toISOString(),
    );
  const get = (key: string): BaiduResearchResult | null => {
    const row = s.db.get<{ value: string }>(
      "SELECT value FROM api_cache WHERE key=? AND expires_at>?",
      key,
      new Date().toISOString(),
    );
    if (!row) return null;
    try {
      const result = baiduResearchResultSchema.parse(JSON.parse(row.value));
      validateBaiduResearchData(result.input.operation, result.data);
      return result;
    } catch {
      throw new AppError(
        "BAIDU_CACHE_INVALID",
        "本地百度工具记录读取失败，请重试读取。",
      );
    }
  };
  const archive = (r: BaiduResearchResult) => {
    if (!r.keywords.some((k) => k.metrics.averageMonthPv !== undefined)) return;
    try {
      r.knowledge = s.traffic.knowledge.ingestBaidu({
        ...r,
        input: baiduKeywordInputSchema.parse({
          accountId: r.input.accountId,
          seeds: r.input.words.slice(0, 10).length
            ? r.input.words.slice(0, 10)
            : ["流量查询"],
        }),
      });
    } catch {
      r.warning =
        "查询已成功，本地词库入库失败；可重试本地读取，无需重新查询百度。";
    }
  };
  const resultFor = async (accountId: string, resultId: string) => {
    const account = await s.websiteAccounts.check(accountId),
      r = get(`baidu-research:result:${accountId}:${resultId}`);
    if (
      account.provider !== "baidu-marketing" ||
      !r ||
      r.input.accountId !== account.id ||
      r.accountUid !== account.uid
    )
      throw new AppError(
        "BAIDU_RESULT_MISSING",
        "未找到当前账号的本地结果，请重新读取对应记录。",
      );
    return { account, r };
  };
  return {
    "baiduResearch.run": async (raw) => {
      const input = baiduResearchInputSchema.parse(raw);
      return s.websiteAccounts.use(
        input.accountId,
        "baidu-marketing",
        async (account) => {
          if (!s.ports.baiduKeywords?.run) throw notAvailable();
          let r: BaiduResearchResult;
          try {
            r = parseBaiduResearchResponse(
              input,
              await s.ports.baiduKeywords.run(account, input),
            );
          } catch (e) {
            if (
              e instanceof AppError &&
              e.code === "BAIDU_LOGIN_REQUIRED" &&
              !input.operation.startsWith("industry")
            )
              await s.websiteAccounts.expire(account.id);
            throw e;
          }
          archive(r);
          try {
            cache(`baidu-research:result:${account.id}:${r.id}`, r);
            cache(`baidu-research:latest:${account.id}:${input.operation}`, r);
          } catch {
            r.warning =
              "操作已成功，但本地记录写入失败。请先保存结果；提交任务后请读取任务列表，避免重复提交。";
          }
          return r;
        },
      );
    },
    "baiduResearch.latest": async (raw) => {
      const v = z
        .object({
          accountId: websiteAccountIdSchema,
          operation: baiduResearchInputSchema.shape.operation,
        })
        .parse(raw);
      const account = await s.websiteAccounts.check(v.accountId),
        r = get(`baidu-research:latest:${account.id}:${v.operation}`);
      if (
        !r ||
        r.accountUid !== account.uid ||
        r.input.accountId !== account.id
      )
        return null;
      archive(r);
      return r;
    },
    "baiduResearch.open": async (raw) => {
      const v = z
        .object({ accountId: websiteAccountIdSchema, tool: baiduToolSchema })
        .parse(raw);
      return s.websiteAccounts.use(
        v.accountId,
        "baidu-marketing",
        async (a) => {
          if (!s.ports.baiduKeywords?.open) throw notAvailable();
          await s.ports.baiduKeywords.open(a, v.tool);
        },
      );
    },
    "baiduResearch.upload": async (raw) => {
      const v = z
        .object({
          accountId: websiteAccountIdSchema,
          name: z
            .string()
            .max(200)
            .regex(/\.xlsx$/i),
          base64: z
            .string()
            .min(1)
            .max(10_666_672)
            .regex(/^[A-Za-z0-9+/]*={0,2}$/),
        })
        .parse(raw);
      const bytes = Buffer.from(v.base64, "base64");
      const rows = readXlsx(bytes, 100000);
      if (!rows.length || rows.some((r) => !r[0]?.trim() || r[0].length > 100))
        throw new AppError(
          "BAIDU_GROUP_FILE_INVALID",
          "请将待分组关键词放在第一列，每词最多100字，最多10万词。",
        );
      return s.websiteAccounts.use(
        v.accountId,
        "baidu-marketing",
        async (a) => {
          if (!s.ports.baiduKeywords?.upload) throw notAvailable();
          return z
            .object({ bosKey: z.string().min(1), fileName: z.string().min(1) })
            .parse(
              parseBaiduData(
                await s.ports.baiduKeywords.upload(a, v.name, bytes),
              ),
            );
        },
      );
    },
    "baiduResearch.export": async (raw) => {
      const v = z
          .object({
            accountId: websiteAccountIdSchema,
            resultId: z.string().max(100),
          })
          .parse(raw),
        { r } = await resultFor(v.accountId, v.resultId);
      const fields = [...new Set(r.rows.flatMap((r) => Object.keys(r)))].filter(
        (k) => !/url|token|cookie/i.test(k),
      );
      return s.ports.saveFile(
        `百度${r.input.operation}-${r.fetchedAt.slice(0, 10)}.csv`,
        Buffer.from(
          csv([
            fields,
            ...r.rows.map((row) =>
              fields.map((k) =>
                typeof row[k] === "boolean" ? String(row[k]) : (row[k] ?? null),
              ),
            ),
          ]),
        ),
      );
    },
    "baiduResearch.download": async (raw) => {
      const v = z
          .object({
            accountId: websiteAccountIdSchema,
            resultId: z.string().max(100),
            row: z.number().int().min(0).max(100000),
          })
          .parse(raw),
        { account, r } = await resultFor(v.accountId, v.resultId);
      const row = r.rows[v.row],
        url = row?.downloadUrl ?? row?.resultUrl ?? row?.result;
      if (typeof url !== "string" || Number(row.status) !== 1)
        throw new AppError(
          "BAIDU_DOWNLOAD_MISSING",
          "任务尚未返回下载地址，请读取最新任务状态。",
        );
      if (!s.ports.baiduKeywords?.download) throw notAvailable();
      const bytes = await s.ports.baiduKeywords.download(account, url);
      const extension =
        new URL(url).pathname.match(/\.(xlsx|csv|zip|txt)$/i)?.[1] ?? "xlsx";
      return s.ports.saveFile(
        `百度任务-${String(row.taskId ?? r.id).replace(/[^a-z0-9_-]/gi, "")}.${extension}`,
        bytes,
      );
    },
    "baiduResearch.collectTask": async (raw) => {
      const v = z
          .object({
            accountId: websiteAccountIdSchema,
            resultId: z.string().max(100),
            row: z.number().int().min(0).max(100000),
          })
          .parse(raw),
        { account, r } = await resultFor(v.accountId, v.resultId);
      const row = r.rows[v.row],
        url = row?.downloadUrl ?? row?.resultUrl ?? row?.result;
      if (
        typeof url !== "string" ||
        Number(row.status) !== 1 ||
        !["massList", "groupList"].includes(r.input.operation)
      )
        throw new AppError(
          "BAIDU_TASK_NOT_READY",
          "请先读取已完成的百度任务。",
        );
      if (!s.ports.baiduKeywords?.download) throw notAvailable();
      const bytes = await s.ports.baiduKeywords.download(account, url);
      const extension =
        new URL(url).pathname.match(/\.(xlsx|csv|txt)$/i)?.[1] ?? "xlsx";
      const { received, chunks } = baiduTaskKeywordChunks(
        account.id,
        r.accountUid,
        String(row.taskId ?? r.id),
        `任务.${extension}`,
        bytes,
      );
      let indexed = 0,
        refreshedBelowThreshold = 0;
      for (const chunk of chunks) {
        const stats = s.traffic.knowledge.ingestBaidu(chunk);
        indexed += stats.indexed;
        refreshedBelowThreshold += stats.refreshedBelowThreshold;
      }
      return { received, indexed, refreshedBelowThreshold };
    },
  } satisfies HandlerMap;
}

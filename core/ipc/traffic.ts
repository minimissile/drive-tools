import { z } from "zod";
import { id, now } from "../database";
import { knowledgeFilter } from "../../shared/traffic-knowledge";
import { AppError } from "../errors";
import { csv } from "../csv";
import {
  endpointSchema,
  keywordSchema,
  querySchema,
} from "../../shared/schemas";

import type { HandlerServices, HandlerMap } from "./types";

export function createTrafficHandlers(
  services: Pick<
    HandlerServices,
    "changed" | "db" | "invoke" | "ports" | "repo" | "traffic"
  >,
) {
  return {
    "api.plan": async (object) => {
      const input = z
        .object({
          endpoint: endpointSchema,
          unitPriceMicros: z
            .number()
            .int()
            .nonnegative()
            .max(1_000_000_000)
            .nullable(),
          dailyUnits: z.number().int().min(1).max(1_000_000),
          dailyBudgetMicros: z.number().int().nonnegative().nullable(),
          enabled: z.boolean(),
        })
        .parse(object);
      if (input.dailyBudgetMicros != null && input.unitPriceMicros == null)
        throw new AppError(
          "API_PRICE_REQUIRED",
          "设置金额预算需录入实际套餐单价。",
        );
      services.db.run(
        "UPDATE api_plans SET unit_price_micros=?,daily_units=?,daily_budget_micros=?,enabled=? WHERE endpoint=?",
        input.unitPriceMicros,
        input.dailyUnits,
        input.dailyBudgetMicros,
        Number(input.enabled),
        input.endpoint,
      );
      services.changed();
      return true;
    },
    "api.export": async () => {
      const calls = services.db.all<Record<string, any>>(
        "SELECT * FROM api_calls ORDER BY created_at",
      );
      return services.ports.saveFile(
        "盘序-调用费用台账.csv",
        Buffer.from(
          csv([
            [
              "时间UTC",
              "接口",
              "阶段",
              "外部请求数",
              "预留计费单位",
              "币种",
              "套餐摊销估算",
              "预算预留",
              "API返回实际金额",
              "状态",
              "说明",
            ],
            ...calls.map((c) => [
              c.created_at,
              c.endpoint,
              c.phase,
              c.request_count,
              c.units,
              c.endpoint === "openrouter" ? "USD" : "CNY",
              c.estimated_micros == null ? null : c.estimated_micros / 1e6,
              c.reserved_micros == null ? null : c.reserved_micros / 1e6,
              c.confirmed_micros == null ? null : c.confirmed_micros / 1e6,
              c.status,
              c.message,
            ]),
          ]),
        ),
      );
    },
    "traffic.releaseSubmission": async (object) => {
      const { taskId } = z.object({ taskId: z.string() }).parse(object);
      const task = services.db.get<{ status: string }>(
        "SELECT status FROM async_queries WHERE task_id=?",
        taskId,
      );
      if (!task || task.status !== "uncertain")
        throw new AppError(
          "INVALID_TASK_STATE",
          "只可解除已人工核对的待核提交记录。",
        );
      services.db.run(
        "UPDATE async_queries SET status='released' WHERE task_id=?",
        taskId,
      );
      services.changed();
      return true;
    },
    "traffic.knowledge.list": async (object) => {
      return services.traffic.knowledge.list(object);
    },
    "traffic.knowledge.detail": async (object) => {
      return services.traffic.knowledge.detail(
        z.object({ id: z.string().max(100) }).parse(object).id,
      );
    },
    "traffic.knowledge.export": async (object) => {
      return services.ports.saveFile(
        "盘序-流量知识库.csv",
        Buffer.from(
          services.traffic.knowledge.export(knowledgeFilter.parse(object)),
          "utf8",
        ),
      );
    },
    "traffic.knowledge.exportQuery": async (object) => {
      const detail = services.traffic.knowledge.detail(
        z.object({ id: z.string().max(100) }).parse(object).id,
      );
      return services.ports.saveFile(
        `盘序-查询档案-${detail.query.id}.json`,
        Buffer.from(JSON.stringify(detail, null, 2), "utf8"),
      );
    },
    "traffic.query": async (object) => {
      return services.traffic.query(querySchema.parse(object));
    },
    "traffic.suggestionResult": async (object) => {
      const { id } = z.object({ id: z.string() }).parse(object);
      return services.traffic.suggestionResult(id);
    },
    "traffic.resumeSuggestion": async (object) => {
      const { id } = z
        .object({ id: z.string(), chargeAcknowledged: z.literal(true) })
        .parse(object);
      return services.traffic.resumeSuggestion(id);
    },
    "pool.save": async (object) => {
      const input = z
        .object({
          name: z.string().trim().min(1).max(100),
          resourceId: z.string().nullable(),
          keywords: z.array(keywordSchema).min(1).max(1000),
        })
        .parse(object);
      if (input.resourceId) services.repo.getResource(input.resourceId);
      const poolId = id("pool");
      services.db.run(
        "INSERT INTO pools(id,name,resource_id,keywords,created_at) VALUES(?,?,?,?,?)",
        poolId,
        input.name,
        input.resourceId,
        JSON.stringify(input.keywords),
        now(),
      );
      services.changed();
      return services.repo.pools().find((p) => p.id === poolId);
    },
    "pool.manual": async (object) => {
      const input = z
        .object({
          name: z.string().trim().min(1).max(100),
          resourceId: z.string().nullable(),
          words: z.string().max(100000),
        })
        .parse(object);
      const words = [
        ...new Set(
          input.words
            .split(/[,，\n]/)
            .map((w) => w.trim())
            .filter(Boolean),
        ),
      ];
      if (
        !words.length ||
        words.length > 1000 ||
        words.some((w) => w.length > 200)
      )
        throw new AppError(
          "INVALID_KEYWORDS",
          "请录入1至1000个词，每词不超过200字。",
        );
      return services.invoke("pool.save", {
        name: input.name,
        resourceId: input.resourceId,
        keywords: words.map((word) => ({
          id: id("manual"),
          word,
          source: "手工录入",
          platform: null,
          metrics: {},
          sourceUpdatedAt: null,
          fetchedAt: now(),
        })),
      });
    },
  } satisfies HandlerMap;
}

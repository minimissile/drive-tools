import { z } from "zod";
import { AppError, safeMessage } from "../errors";
import { csv } from "../csv";

import type { HandlerServices, HandlerMap } from "./types";

export function createSearchHandlers(
  services: Pick<
    HandlerServices,
    "ai" | "changed" | "checkShare" | "db" | "invoke" | "ports" | "search"
  >,
) {
  return {
    "search.list": async (object) => {
      return services.search.list(object);
    },
    "search.get": async (object) => {
      return services.search.get(z.object({ id: z.string() }).parse(object).id);
    },
    "search.create": async (object) => {
      return services.search.create(object);
    },
    "search.importPool": async (object) => {
      return services.search.importPool(object);
    },
    "search.bind": async (object) => {
      return services.search.bind(object);
    },
    "search.facts": async (object) => {
      return services.search.facts(object);
    },
    "search.targets": async (object) => {
      return services.search.targets(object);
    },
    "search.write": async (object) => {
      return services.search.write(
        z.object({ id: z.string() }).parse(object).id,
      );
    },
    "search.effect": async (object) => {
      return services.search.recordEffect(object);
    },
    "search.generate": async (object) => {
      const { id: topicId } = z.object({ id: z.string() }).parse(object);
      const context = services.search.context(topicId);
      const draft = await services.ai.draft(
        context.copy.id,
        context.topic.platform,
        context.topic.poolId,
        context,
      );
      services.changed();
      return draft;
    },
    "search.check": async (object) => {
      const { id: topicId } = z.object({ id: z.string() }).parse(object),
        topic = services.search.get(topicId).topic;
      if (!topic.copyId)
        throw new AppError("TARGET_REQUIRED", "请先关联配套本人资料。");
      if (topic.splitItemId) {
        try {
          return await services.invoke("split.link", {
            itemId: topic.splitItemId,
            includeCode: false,
          });
        } catch (error) {
          if (
            error instanceof AppError &&
            [
              "TARGET_CHANGED",
              "PARTIAL_SUCCESS",
              "ACCOUNT_UID_MISMATCH",
            ].includes(error.code)
          ) {
            services.db.run(
              "UPDATE split_items SET status='needs_review',verified_at=NULL,error=? WHERE id=?",
              safeMessage(error),
              topic.splitItemId,
            );
            services.changed();
          }
          throw error;
        }
      }
      return services.checkShare(topic.copyId);
    },
    "search.effectsExport": async (object) => {
      const { id: topicId } = z.object({ id: z.string() }).parse(object),
        detail = services.search.get(topicId);
      return services.ports.saveFile(
        "盘序-搜索运营效果.csv",
        Buffer.from(
          csv([
            [
              "关键词",
              "归因范围",
              "发布记录ID",
              "统计开始",
              "统计结束",
              "阅读量",
              "转存量",
              "有效拉新",
              "已结算人民币",
              "数据来源",
              "录入时间UTC",
            ],
            ...detail.effects.map((e) => [
              detail.topic.keyword,
              e.scope === "article" ? "单篇文章" : "账号汇总",
              e.publicationId,
              e.periodStart,
              e.periodEnd,
              e.views,
              e.saves,
              e.newUsers,
              e.revenueCents == null ? null : e.revenueCents / 100,
              e.source,
              e.createdAt,
            ]),
          ]),
        ),
      );
    },
  } satisfies HandlerMap;
}

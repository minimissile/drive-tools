import { intakeOptions, addIntakeOption } from "../intake-options";
import { z } from "zod";
import {
  localResourceDraftSchema,
  providerSchema,
  resourceInputSchema,
} from "../../shared/schemas";
import { readResourceCover } from "../cover-assets";
import {
  keywordLookupSchema,
  keywordBatchSchema,
  type KeywordBatch,
} from "../../shared/resource-keywords";
import { websiteAccountIdSchema } from "../../shared/website-accounts";
import { AppError } from "../errors";
import { baiduKeywordInputSchema } from "../../shared/baidu-keywords";
import { readBaiduKeywords } from "../baidu-keywords";
import {
  lookupResourceKeywords,
  lookupResourceKeywordBatch,
  checkKeywordSources,
} from "../resource-keywords";
import { similarResources } from "../resource-duplicates";

import type { HandlerServices, HandlerMap } from "./types";

export function createResourcesHandlers(
  services: Pick<
    HandlerServices,
    | "dataPath"
    | "db"
    | "importer"
    | "ports"
    | "repo"
    | "saveResource"
    | "websiteAccounts"
    | "changed"
    | "setKeywordLookupBusy"
  >,
) {
  let keywordLookupRunning = false;
  let activeBatch = "";
  const batchKey = (id: string) => `resource-keyword-batch:${id}`;
  const marketing = (accountId?: string) =>
    accountId
      ? async (words: string[]) => {
          const input = baiduKeywordInputSchema.parse({
            accountId,
            seeds: words,
          });
          const result = await services.websiteAccounts.use(
            accountId,
            "baidu-marketing",
            (account) => readBaiduKeywords(account, input, services),
          );
          return result.keywords.map(({ word }) => word);
        }
      : undefined;
  return {
    "resource.keywordCheckSources": async (object) => {
      const { baiduAccountId } = z
        .object({
          baiduAccountId: websiteAccountIdSchema.optional(),
        })
        .parse(object);
      if (keywordLookupRunning)
        throw new AppError(
          "KEYWORD_BUSY",
          "正在检索流量词，请完成后再检查来源。",
        );
      keywordLookupRunning = true;
      services.setKeywordLookupBusy(true);
      try {
        return await checkKeywordSources(
          services.ports,
          baiduAccountId
            ? () =>
                services.websiteAccounts.use(
                  baiduAccountId,
                  "baidu-marketing",
                  async () => {},
                )
            : undefined,
        );
      } finally {
        keywordLookupRunning = false;
        services.setKeywordLookupBusy(false);
      }
    },
    "resource.keywordOpen5118": () => {
      if (!services.ports.keywordWebBrowser)
        throw new AppError(
          "KEYWORD_SOURCE",
          "当前客户端无法打开5118，请应用更新后重试。",
        );
      return services.ports.keywordWebBrowser.open();
    },
    "resource.keywordBatchStatus": (object) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(object);
      const batch = services.db.setting<KeywordBatch | null>(
        batchKey(id),
        null,
      );
      return batch?.status === "running" && activeBatch !== id
        ? { ...batch, status: "interrupted" as const }
        : batch;
    },
    "resource.keywordBatch": async (object) => {
      const input = keywordBatchSchema.parse(object);
      const previous = services.db.setting<KeywordBatch | null>(
        batchKey(input.id),
        null,
      );
      if (previous) return previous;
      if (keywordLookupRunning)
        throw new Error("已有流量词检索正在运行，请稍后再试。");
      const batch: KeywordBatch = {
        id: input.id,
        status: "running",
        items: input.items.map((item) => ({ ...item, status: "pending" })),
      };
      keywordLookupRunning = true;
      activeBatch = batch.id;
      services.setKeywordLookupBusy(true);
      const changed = () => {
        services.db.setSetting(batchKey(batch.id), batch);
        services.changed();
      };
      try {
        changed();
        return await lookupResourceKeywordBatch(
          batch,
          services.ports,
          marketing(input.baiduAccountId),
          changed,
        );
      } finally {
        keywordLookupRunning = false;
        activeBatch = "";
        services.setKeywordLookupBusy(false);
      }
    },
    "resource.keywordLookup": async (object) => {
      const { seeds, baiduAccountId } = keywordLookupSchema.parse(object);
      if (keywordLookupRunning)
        throw new Error("已有流量词检索正在运行，请稍后再试。");
      keywordLookupRunning = true;
      services.setKeywordLookupBusy(true);
      try {
        return await lookupResourceKeywords(
          seeds,
          services.ports,
          marketing(baiduAccountId),
        );
      } finally {
        keywordLookupRunning = false;
        services.setKeywordLookupBusy(false);
      }
    },
    "resource.intakeOptions": (object) =>
      intakeOptions(
        services.db,
        services.repo,
        z.object({ accountId: z.string().default("") }).parse(object).accountId,
      ),
    "resource.addIntakeOption": (object) =>
      addIntakeOption(services.db, services.repo, object),
    "resource.search": async (object) => {
      return services.repo.resources(
        z.object({ query: z.string().max(200) }).parse(object).query,
      );
    },
    "resource.similar": (object) => {
      const { title, excludeId } = z
        .object({
          title: z.string().trim().max(200),
          excludeId: z.string().max(100).optional(),
        })
        .parse(object);
      return similarResources(services.db, title, excludeId);
    },
    "resource.get": async (object) => {
      const { id } = z.object({ id: z.string() }).parse(object);
      return services.repo.getResource(id);
    },
    "resource.page": async (object) => {
      return services.repo.resourcePage(
        z
          .object({
            query: z.string().max(200).default(""),
            category: z.string().max(60).default("all"),
            provider: providerSchema.or(z.literal("all")).default("all"),
            accountId: z.string().max(100).default("all"),
            page: z.number().int().min(1).max(100000).default(1),
            pageSize: z.number().int().min(1).max(100).default(25),
          })
          .parse(object),
      );
    },
    "resource.importPreview": async (object) => {
      const { text, targets } = z
        .object({
          text: z.string().max(2_000_000),
          targets: z
            .object({
              quark: z.string().optional(),
              baidu: z.string().optional(),
              uc: z.string().optional(),
              xunlei: z.string().optional(),
              guangya: z.string().optional(),
              pikpak: z.string().optional(),
            })
            .default({}),
        })
        .parse(object);
      return services.importer.preview(text, targets);
    },
    "resource.importCommit": async (object) => {
      const { token, rows } = z
        .object({
          token: z.string(),
          rows: z.array(z.number().int().min(2).max(501)).max(500),
        })
        .parse(object);
      return services.importer.commit(token, rows);
    },
    "resource.importFile": async () => {
      return services.ports.readText("csv");
    },
    "resource.summaryFile": async () => {
      return services.ports.readText("summary");
    },
    "resource.save": async (object) => {
      return services.saveResource(resourceInputSchema.parse(object));
    },
    "resource.saveLocalDraft": async (object) => {
      const { resourceId, copyId } = await services.saveResource(
        localResourceDraftSchema.parse(object),
        "local-draft",
      );
      return { resourceId, copyId, jobId: null };
    },
    "cover.export": async (object) => {
      const { id: coverId } = z
        .object({ id: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(object);
      const cover = await readResourceCover(services.dataPath, coverId);
      return services.ports.saveFile(
        `资源封面.${cover.extension}`,
        cover.bytes,
      );
    },
    "cover.get": async (object) => {
      const { id: coverId } = z
        .object({ id: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(object);
      const cover = await readResourceCover(services.dataPath, coverId);
      return `data:${cover.mime};base64,${cover.bytes.toString("base64")}`;
    },
  } satisfies HandlerMap;
}

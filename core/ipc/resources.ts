import { intakeOptions, addIntakeOption } from "../intake-options";
import { z } from "zod";
import { resourceInputSchema } from "../../shared/schemas";
import { readResourceCover } from "../cover-assets";
import { similarResources } from "../resource-duplicates";

import type { HandlerServices, HandlerMap } from "./types";

export function createResourcesHandlers(
  services: Pick<
    HandlerServices,
    "dataPath" | "db" | "importer" | "ports" | "repo" | "saveResource"
  >,
) {
  return {
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

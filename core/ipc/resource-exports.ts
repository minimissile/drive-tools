import { z } from "zod";
import {
  exportArticle,
  exportInput,
  exportSelection,
} from "../../shared/resource-export";

import type { HandlerServices, HandlerMap } from "./types";

export function createResourceExportsHandlers(
  services: Pick<HandlerServices, "invoke" | "ports" | "resourceExports">,
) {
  return {
    "resourceExport.plan": async (object) => {
      return services.resourceExports.plan(exportInput.parse(object));
    },
    "resourceExport.history": async () => {
      return services.resourceExports.history();
    },
    "resourceExport.get": async (object) => {
      return services.resourceExports.get(
        z.object({ runId: z.string().max(100) }).parse(object).runId,
      );
    },
    "resourceExport.updatePlan": async (object) => {
      const input = z
        .object({ runId: z.string().max(100), plan: z.unknown() })
        .parse(object);
      return services.resourceExports.updatePlan(input.runId, input.plan);
    },
    "resourceExport.step": async (object) => {
      return services.resourceExports.step(
        z.object({ runId: z.string().max(100) }).parse(object).runId,
      );
    },
    "resourceExport.article": async (object) => {
      const input = exportSelection.parse(object);
      return services.resourceExports.article(input.runId, input.ids);
    },
    "resourceExport.file": async (object) => {
      const input = exportSelection
        .extend({
          columns: z.unknown(),
          format: z.enum(["xlsx", "csv", "md", "json", "txt"]),
        })
        .parse(object);
      const file = await services.resourceExports.file(
        input.runId,
        input.ids,
        input.columns,
        input.format,
        async (copyId) => {
          const result = (await services.invoke("copy.link", { copyId })) as {
            text: string;
          };
          const [url, codeLine] = result.text.split("\n");
          return { url, code: codeLine?.replace(/^提取码：/, "") || null };
        },
      );
      return services.ports.saveFile(file.name, file.bytes);
    },
    "resourceExport.articleFile": async (object) => {
      const input = z
        .object({
          runId: z.string().max(100),
          article: exportArticle,
          format: z.enum(["md", "txt"]),
        })
        .parse(object);
      const file = services.resourceExports.articleFile(
        input.runId,
        input.article,
        input.format,
      );
      return services.ports.saveFile(file.name, file.bytes);
    },
    "resourceExport.articleSave": async (object) => {
      const input = z
        .object({ runId: z.string().max(100), article: exportArticle })
        .parse(object);
      return services.resourceExports.saveArticle(input.runId, input.article);
    },
  } satisfies HandlerMap;
}

import { z } from "zod";
import {
  aiModelSelection,
  aiPurposes,
  aiPurposeDetails,
  modelsForPurpose,
} from "../../shared/ai-models";
import { now } from "../database";
import { AppError } from "../errors";
import { validateLoopback } from "../links";

import type { HandlerServices, HandlerMap } from "./types";

export function createSettingsHandlers(
  services: Pick<
    HandlerServices,
    "changed" | "db" | "notes" | "ports" | "repo" | "secrets"
  >,
) {
  return {
    "notes.export": async (object) => {
      const { copyId } = z.object({ copyId: z.string() }).parse(object);
      services.notes.enqueue(copyId);
      await services.notes.flush();
      services.changed();
      return services.repo.getCopy(copyId);
    },
    "notes.open": async (object) => {
      const { copyId } = z.object({ copyId: z.string() }).parse(object);
      const row = services.db.get<{ path: string }>(
        "SELECT path FROM note_exports WHERE copy_id=?",
        copyId,
      );
      if (!row)
        throw new AppError("NOTE_NOT_EXPORTED", "此副本尚未导出知识笔记。");
      await services.ports.openPath(row.path);
      return true;
    },
    "settings.vault": async () => {
      const path = await services.ports.chooseDirectory("vault");
      if (path) {
        services.db.setSetting("vaultPath", path);
        for (const c of services.db.all<{ id: string }>(
          "SELECT id FROM copies WHERE status='ready'",
        ))
          services.notes.enqueue(c.id);
        void services.notes.flush().finally(() => services.changed());
        services.changed();
      }
      return path;
    },
    "settings.save": async (object) => {
      const input = z
        .object({
          model: z.string().max(200),
          aiModels: aiModelSelection.optional(),
          exportCodes: z.boolean(),
          bitUrl: z.string().max(300),
          dailyAiBudgetMicros: z.number().int().nonnegative().nullable(),
        })
        .partial()
        .refine(
          (value) => Object.keys(value).length > 0,
          "请至少修改一项设置。",
        )
        .parse(object);
      if (input.bitUrl) validateLoopback(input.bitUrl);
      if (input.aiModels) {
        const catalog = {
          text: services.db.setting<import("../ai").AiModel[]>(
            "modelCatalog",
            [],
          ),
          media: services.db.setting<
            import("../../shared/studio").MediaModel[]
          >("studio:modelCatalog", []),
        };
        for (const purpose of aiPurposes) {
          const chosen = input.aiModels[purpose];
          if (
            chosen &&
            !modelsForPurpose(purpose, catalog).some((m) => m.id === chosen)
          )
            throw new AppError(
              "MODEL_CAPABILITY_MISMATCH",
              `${aiPurposeDetails[purpose].label}所选模型不在当前可用目录中，或能力不匹配。请刷新模型目录后重新选择。`,
            );
        }
      }
      services.db.transaction(() => {
        for (const [key, value] of Object.entries(input))
          services.db.setSetting(key, value);
      });
      services.changed();
      return true;
    },
    "secret.save": async (object) => {
      const input = z
        .object({
          kind: z.enum([
            "openrouter",
            "bit",
            "5118:longtail",
            "5118:suggest",
            "5118:metrics",
            "5118:radar",
          ]),
          value: z.string().max(20000),
        })
        .parse(object);
      await services.secrets.set(input.kind, input.value);
      services.db.setSetting(
        `keyRevision:${input.kind.replace("5118:", "")}`,
        now(),
      );
      services.changed();
      return true;
    },
  } satisfies HandlerMap;
}

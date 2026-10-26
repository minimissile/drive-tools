import { z } from "zod";
import { readFile } from "node:fs/promises";
import { AppError } from "../errors";
import type { HandlerServices, HandlerMap } from "./types";
export function createResourceAnswerHandlers(
  s: Pick<HandlerServices, "resourceAnswers" | "studio" | "ports">,
) {
  const service = s.resourceAnswers;
  return {
    "resourceAnswers.list": () => service.list(),
    "resourceAnswers.generate": (raw) => service.generate(raw),
    "resourceAnswers.copy": (raw) => {
      const v = z
        .object({ id: z.string().uuid(), format: z.enum(["text", "rich"]) })
        .parse(raw);
      return service.copy(v.id, v.format);
    },
    "studio.assetCopy": async (raw) => {
      const { name } = z
        .object({ name: z.string().regex(/^[a-f0-9]{64}\.png$/) })
        .parse(raw);
      if (!s.ports.copyImage)
        throw new AppError(
          "CLIPBOARD_UNAVAILABLE",
          "当前环境不支持复制图片，请导出图片文件。",
        );
      await s.ports.copyImage(await readFile(await s.studio.assetPath(name)));
      return true;
    },
  } satisfies HandlerMap;
}

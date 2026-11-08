import { z } from "zod";
import type { HandlerMap, HandlerServices } from "./types";

export function createMusicHandlers(services: Pick<HandlerServices, "music">) {
  return {
    "music.library": async () => services.music.library(),
    "music.configure": async (raw) =>
      services.music.configure(
        z.object({ enabled: z.boolean() }).strict().parse(raw),
      ),
    "music.update": async (raw) =>
      services.music.update(
        z.object({ retry: z.boolean().optional() }).strict().parse(raw),
      ),
    "music.audio": async (raw) =>
      services.music.audio(
        z
          .object({
            id: z.string().regex(/^\d{1,30}$/, "音乐编号无效。"),
            retry: z.boolean().optional(),
          })
          .strict()
          .parse(raw),
      ),
  } satisfies HandlerMap;
}

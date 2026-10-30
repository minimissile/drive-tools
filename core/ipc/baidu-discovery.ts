import { z } from "zod";
import { discoveryInputSchema } from "../../shared/baidu-discovery";
import type { HandlerServices, HandlerMap } from "./types";
const runId = z.object({ id: z.string().min(1).max(100) });
const selectedWords = z.array(z.string().min(1).max(100)).min(1).max(10000);
export function createBaiduDiscoveryHandlers({
  baiduDiscovery: service,
  ports,
}: Pick<HandlerServices, "baiduDiscovery" | "ports">) {
  return {
    "baiduDiscovery.list": () => service.list(),
    "baiduDiscovery.get": (raw) => service.get(runId.parse(raw).id),
    "baiduDiscovery.start": (raw) =>
      service.start(discoveryInputSchema.parse(raw)),
    "baiduDiscovery.pause": (raw) => service.pause(runId.parse(raw).id),
    "baiduDiscovery.resume": (raw) => service.resume(runId.parse(raw).id),
    "baiduDiscovery.skip": (raw) => service.skip(runId.parse(raw).id),
    "baiduDiscovery.expand": (raw) => {
      const v = runId.extend({ words: selectedWords }).parse(raw);
      return service.expand(v.id, v.words);
    },
    "baiduDiscovery.open": (raw) =>
      service.open(
        z.object({ id: z.string().max(100).optional() }).parse(raw).id,
      ),
    "baiduDiscovery.closeBrowser": () => service.closeBrowser(),
    "baiduDiscovery.export": (raw) => {
      const v = runId
        .extend({
          words: selectedWords.optional(),
          format: z.enum(["csv", "txt"]),
        })
        .parse(raw);
      return ports.saveFile(
        `百度扩词-${new Date().toLocaleDateString("sv-SE")}.${v.format}`,
        service.exportBytes(v.id, v.format, v.words),
      );
    },
  } satisfies HandlerMap;
}

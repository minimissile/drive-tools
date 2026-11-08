import { z } from "zod";
import { bilibiliDraftId, bilibiliDraftInput } from "../../shared/bilibili";
import type { HandlerMap, HandlerServices } from "./types";
const identifier = z.object({ id: bilibiliDraftId });
export function createBilibiliHandlers({
  bilibili,
  ports,
}: Pick<HandlerServices, "bilibili" | "ports">) {
  return {
    "bilibili.list": async () => bilibili.list(),
    "bilibili.get": async (raw) => bilibili.get(identifier.parse(raw).id),
    "bilibili.save": async (raw) =>
      bilibili.save(bilibiliDraftInput.parse(raw)),
    "bilibili.preview": async (raw) =>
      bilibili.preview(identifier.parse(raw).id),
    "bilibili.prepare": async (raw) =>
      bilibili.prepare(identifier.parse(raw).id),
    "bilibili.export": async (raw) => {
      const output = await bilibili.package(identifier.parse(raw).id);
      return ports.saveFile(output.name, output.bytes);
    },
    "bilibili.recordReceipt": async (raw) => {
      const value = identifier
        .extend({ url: z.string().trim().min(1).max(2000) })
        .parse(raw);
      return bilibili.recordReceipt(value.id, value.url);
    },
  } satisfies HandlerMap;
}

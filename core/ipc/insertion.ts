import { z } from "zod";
import {
  insertionMaterialInput,
  insertionTargetInput,
} from "../../shared/insertion";
import { csv } from "../csv";
import type { HandlerMap, HandlerServices } from "./types";
export function createInsertionHandlers(
  s: Pick<HandlerServices, "insertion" | "ports">,
) {
  const runId = z.object({ id: z.string().min(1) });
  return {
    "insertion.materials": () => s.insertion.materials(),
    "insertion.materialDetail": (object) =>
      s.insertion.materialDetail(runId.parse(object).id),
    "insertion.addMaterial": async (object) => {
      const input = insertionMaterialInput.parse(object);
      if (input.kind === "image")
        await s.ports.normalizeCover(Buffer.from(input.base64, "base64"));
      return s.insertion.addMaterial(input);
    },
    "insertion.removeMaterial": (object) =>
      s.insertion.removeMaterial(runId.parse(object).id),
    "insertion.candidates": (object) =>
      s.insertion.candidates(
        z.object({ query: z.string().max(200).default("") }).parse(object)
          .query,
      ),
    "insertion.list": () => s.insertion.list(),
    "insertion.get": (object) => s.insertion.get(runId.parse(object).id),
    "insertion.preview": (object) => {
      const i = z
        .object({
          targets: z.array(insertionTargetInput).min(1).max(100),
          materialIds: z.array(z.string()).min(1).max(10),
        })
        .parse(object);
      return s.insertion.preview(i.targets, i.materialIds);
    },
    "insertion.start": (object) => {
      const i = z
        .object({ id: z.string(), confirmed: z.literal(true) })
        .parse(object);
      return s.insertion.start(i.id);
    },
    "insertion.cancel": (object) => s.insertion.cancel(runId.parse(object).id),
    "insertion.recheck": (object) =>
      s.insertion.recheck(runId.parse(object).id),
    "insertion.export": (object) => {
      const run = s.insertion.get(runId.parse(object).id);
      return s.ports.saveFile(
        "批量插入结果.csv",
        Buffer.from(
          csv([
            ["账号", "目标目录", "素材", "类型", "状态", "说明", "远端ID"],
            ...run.items.map((i) => [
              i.account,
              i.target.path,
              i.material.name,
              i.material.kind,
              i.state,
              i.message,
              i.remoteId ?? "",
            ]),
          ]),
          "utf8",
        ),
      );
    },
  } satisfies HandlerMap;
}

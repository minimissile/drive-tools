import { z } from "zod";
import {
  supplyActionInput,
  supplyCandidateInput,
  supplyDeliverInput,
  supplySaveInput,
  supplyStartInput,
} from "../../shared/content-supply";
import { runtimeLogQuery } from "../../shared/runtime-logs";
import type { HandlerMap, HandlerServices } from "./types";
import { supplyAcquireInput } from "../../shared/pipix-acquisition";

export function createContentSupplyHandlers({
  contentSupply,
}: Pick<HandlerServices, "contentSupply">) {
  return {
    "contentSupply.acquisition": () => contentSupply.acquisition.snapshot(),
    "contentSupply.acquire": (raw) =>
      contentSupply.acquisition.start(supplyAcquireInput.parse(raw)),
    "contentSupply.acquirePause": () => contentSupply.acquisition.pause(),
    "contentSupply.acquireResume": (raw) =>
      contentSupply.acquisition.resume(
        z
          .object({ id: z.string().max(150), confirmed: z.literal(true) })
          .parse(raw).id,
      ),
    "contentSupply.attachComments": (raw) => {
      const v = z
        .object({
          id: z.string().max(150),
          version: z.number().int().positive(),
          commentIds: z.string().max(100).array().min(1).max(50),
        })
        .parse(raw);
      return contentSupply.attachComments(v.id, v.version, v.commentIds);
    },
    "contentSupply.image": (raw) => {
      const v = z
        .object({
          id: z.string().max(150),
          imageId: z.string().max(100),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .parse(raw);
      return contentSupply.image(v.id, v.imageId, v.sha256);
    },
    "contentSupply.snapshot": () => contentSupply.snapshot(),
    "contentSupply.candidates": (raw) =>
      contentSupply.candidates(supplyCandidateInput.parse(raw)),
    "contentSupply.start": (raw) =>
      contentSupply.start(supplyStartInput.parse(raw)),
    "contentSupply.pause": () => contentSupply.pause(),
    "contentSupply.resume": (raw) =>
      contentSupply.resume(
        z.object({ ids: z.string().max(150).array().min(1).max(20) }).parse(raw)
          .ids,
      ),
    "contentSupply.save": (raw) =>
      contentSupply.save(supplySaveInput.parse(raw)),
    "contentSupply.hold": (raw) => {
      const v = supplyActionInput
        .extend({ reason: z.string().trim().min(1).max(2000) })
        .parse(raw);
      return contentSupply.hold(v.id, v.version, v.reason);
    },
    "contentSupply.reopen": (raw) => {
      const v = supplyActionInput.parse(raw);
      return contentSupply.reopen(v.id, v.version);
    },
    "contentSupply.refreshSource": (raw) => {
      const v = supplyActionInput.parse(raw);
      return contentSupply.refreshSource(v.id, v.version);
    },
    "contentSupply.generate": (raw) =>
      contentSupply.generate(
        supplyActionInput.extend({ confirmed: z.literal(true) }).parse(raw),
      ),
    "contentSupply.deliver": (raw) =>
      contentSupply.deliver(supplyDeliverInput.parse(raw)),
    "contentSupply.linkPlan": (raw) => {
      const v = supplyActionInput
        .extend({ channel: z.enum(["zhihu", "weibo"]) })
        .parse(raw);
      return contentSupply.linkPlan(v.id, v.version, v.channel);
    },
    "contentSupply.logs": (raw) =>
      contentSupply.logs.read(runtimeLogQuery.parse(raw)),
  } satisfies HandlerMap;
}

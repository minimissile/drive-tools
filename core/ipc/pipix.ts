import { z } from "zod";
import {
  pipixCollectInput,
  pipixExportInput,
  pipixDiscoverInput,
  pipixDiscoveryKeyInput,
  pipixKnowledgeInput,
} from "../../shared/pipix";
import type { HandlerMap, HandlerServices } from "./types";

export function createPipixHandlers({ pipix }: Pick<HandlerServices, "pipix">) {
  return {
    "pipix.probeCapacity": (raw) =>
      pipix.probeCapacity(
        z.object({ keyword: z.string().trim().min(1).max(100) }).parse(raw)
          .keyword,
      ),
    "pipix.knowledge": (raw) => pipix.knowledge(pipixKnowledgeInput.parse(raw)),
    "pipix.reindex": () => pipix.reindex(),
    "pipix.discoveryConfig": () => pipix.discoveryConfig(),
    "pipix.saveDiscoveryKey": (raw) =>
      pipix.saveDiscoveryKey(pipixDiscoveryKeyInput.parse(raw)),
    "pipix.discover": (raw) => pipix.discover(pipixDiscoverInput.parse(raw)),
    "pipix.list": () => pipix.list(),
    "pipix.collect": (raw) => pipix.collect(pipixCollectInput.parse(raw).text),
    "pipix.export": (raw) => pipix.export(pipixExportInput.parse(raw)),
    "pipix.image": (raw) => {
      const v = z
        .object({
          id: z.string().regex(/^\d{8,30}$/),
          imageId: z.string().max(100),
        })
        .parse(raw);
      return pipix.image(v.id, v.imageId);
    },
  } satisfies HandlerMap;
}

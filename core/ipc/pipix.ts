import { z } from "zod";
import {
  pipixCollectInput,
  pipixExportInput,
  pipixDiscoverInput,
  pipixDiscoveryKeyInput,
  pipixKnowledgeInput,
} from "../../shared/pipix";
import type { HandlerMap, HandlerServices } from "./types";
import {
  pipixCommentsFetch,
  pipixCommentsRead,
  pipixRequestPolicy,
} from "../../shared/pipix-acquisition";

export function createPipixHandlers({ pipix }: Pick<HandlerServices, "pipix">) {
  return {
    "pipix.checkConnection": () => pipix.checkConnection(),
    "pipix.requestPolicy": () => pipix.requestPolicy(),
    "pipix.saveRequestPolicy": (raw) =>
      pipix.saveRequestPolicy(pipixRequestPolicy.parse(raw)),
    "pipix.comments": (raw) =>
      pipix.comments.read(pipixCommentsRead.parse(raw)),
    "pipix.fetchComments": async (raw) => {
      const input = pipixCommentsFetch.parse(raw);
      await pipix.fetchComments(input);
      return pipix.comments.read({ sourceId: input.sourceId });
    },
    "pipix.reindexComments": (raw) =>
      pipix.comments.reindex(
        z.object({ sourceId: z.string().regex(/^\d{8,30}$/) }).parse(raw)
          .sourceId,
      ),
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

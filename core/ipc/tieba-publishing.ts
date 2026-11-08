import {
  tiebaPublishingQuerySchema,
  tiebaPublishingWordsSchema,
  tiebaPublishingSaveSchema,
  tiebaPublishingSubmitSchema,
  tiebaPublishingReconcileSchema,
} from "../../shared/tieba-publishing";
import type { TiebaPublishing } from "../tieba-publishing/service";
import type { HandlerMap } from "./types";
export function createTiebaPublishingHandlers({
  tiebaPublishing,
}: {
  tiebaPublishing: TiebaPublishing;
}) {
  return {
    "tieba.publishing.snapshot": () => tiebaPublishing.snapshot(),
    "tieba.publishing.words": (raw) =>
      tiebaPublishing.words(tiebaPublishingWordsSchema.parse(raw)),
    "tieba.publishing.resources": (raw) =>
      tiebaPublishing.resources(tiebaPublishingQuerySchema.parse(raw)),
    "tieba.publishing.save": (raw) =>
      tiebaPublishing.save(tiebaPublishingSaveSchema.parse(raw)),
    "tieba.publishing.submit": (raw) =>
      tiebaPublishing.submit(tiebaPublishingSubmitSchema.parse(raw)),
    "tieba.publishing.reconcile": (raw) =>
      tiebaPublishing.reconcile(tiebaPublishingReconcileSchema.parse(raw)),
  } satisfies HandlerMap;
}

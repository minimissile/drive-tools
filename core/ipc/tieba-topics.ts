import {
  tiebaTopicSaveSchema,
  tiebaTopicRuleSchema,
  tiebaTopicGenerateSchema,
  tiebaTopicSubmitSchema,
  tiebaTopicReconcileSchema,
  tiebaTopicImagePickSchema,
  tiebaTopicImageRemoveSchema,
  tiebaTopicImageSchema,
} from "../../shared/tieba-topics";
import type { TiebaTopics } from "../tieba-topics/service";
import type { HandlerMap } from "./types";
export function createTiebaTopicsHandlers({
  tiebaTopics,
}: {
  tiebaTopics: TiebaTopics;
}) {
  return {
    "tieba.topics.snapshot": () => tiebaTopics.snapshot(),
    "tieba.topics.save": (raw) =>
      tiebaTopics.save(tiebaTopicSaveSchema.parse(raw)),
    "tieba.topics.rule": (raw) =>
      tiebaTopics.saveRule(tiebaTopicRuleSchema.parse(raw)),
    "tieba.topics.generate": (raw) =>
      tiebaTopics.generate(tiebaTopicGenerateSchema.parse(raw)),
    "tieba.topics.submit": (raw) =>
      tiebaTopics.submit(tiebaTopicSubmitSchema.parse(raw)),
    "tieba.topics.reconcile": (raw) =>
      tiebaTopics.reconcile(tiebaTopicReconcileSchema.parse(raw)),
    "tieba.topics.pickImages": (raw) =>
      tiebaTopics.pickImages(tiebaTopicImagePickSchema.parse(raw)),
    "tieba.topics.removeImage": (raw) =>
      tiebaTopics.removeImage(tiebaTopicImageRemoveSchema.parse(raw)),
    "tieba.topics.image": (raw) =>
      tiebaTopics.image(tiebaTopicImageSchema.parse(raw)),
  } satisfies HandlerMap;
}

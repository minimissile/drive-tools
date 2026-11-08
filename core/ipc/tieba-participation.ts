import {
  tiebaDiscoverSchema,
  tiebaReadThreadSchema,
  tiebaGenerateReplySchema,
  tiebaSaveReplySchema,
  tiebaSubmitReplySchema,
  tiebaReconcileReplySchema,
} from "../../shared/tieba-participation";
import type { HandlerMap, HandlerServices } from "./types";

export function createTiebaParticipationHandlers({
  tiebaParticipation,
}: Pick<HandlerServices, "tiebaParticipation">) {
  return {
    "tieba.participation.snapshot": () => tiebaParticipation.snapshot(),
    "tieba.participation.discover": (raw) =>
      tiebaParticipation.discover(tiebaDiscoverSchema.parse(raw)),
    "tieba.participation.read": (raw) =>
      tiebaParticipation.read(tiebaReadThreadSchema.parse(raw)),
    "tieba.participation.generate": (raw) =>
      tiebaParticipation.generate(tiebaGenerateReplySchema.parse(raw)),
    "tieba.participation.save": (raw) =>
      tiebaParticipation.saveDraft(tiebaSaveReplySchema.parse(raw)),
    "tieba.participation.submit": (raw) =>
      tiebaParticipation.submit(tiebaSubmitReplySchema.parse(raw)),
    "tieba.participation.reconcile": (raw) =>
      tiebaParticipation.reconcile(tiebaReconcileReplySchema.parse(raw)),
  } satisfies HandlerMap;
}

import {
  tiebaAutocareSaveSchema,
  tiebaAutocareSyncSchema,
  tiebaAutocareObserveSchema,
  tiebaAutocareFollowSchema,
  tiebaAutocareAddSchema,
  tiebaAutocareToggleSchema,
  tiebaAutocarePauseSchema,
  tiebaAutocareReconcileSchema,
} from "../../shared/tieba-autocare";
import { tiebaFindForumsSchema } from "../../shared/tieba-forum-discovery";
import type { HandlerMap, HandlerServices } from "./types";

export function createTiebaAutocareHandlers({
  tiebaAutocare,
}: Pick<HandlerServices, "tiebaAutocare">) {
  return {
    "tieba.autocare.snapshot": () => tiebaAutocare.snapshot(),
    "tieba.autocare.save": (raw) =>
      tiebaAutocare.save(tiebaAutocareSaveSchema.parse(raw)),
    "tieba.autocare.sync": (raw) =>
      tiebaAutocare.syncForums(tiebaAutocareSyncSchema.parse(raw)),
    "tieba.autocare.observe": (raw) =>
      tiebaAutocare.observe(tiebaAutocareObserveSchema.parse(raw)),
    "tieba.autocare.follow": (raw) =>
      tiebaAutocare.follow(tiebaAutocareFollowSchema.parse(raw)),
    "tieba.autocare.add": (raw) =>
      tiebaAutocare.add(tiebaAutocareAddSchema.parse(raw)),
    "tieba.autocare.findForums": (raw) =>
      tiebaAutocare.findForums(tiebaFindForumsSchema.parse(raw)),
    "tieba.autocare.toggle": (raw) =>
      tiebaAutocare.toggle(tiebaAutocareToggleSchema.parse(raw)),
    "tieba.autocare.pause": (raw) =>
      tiebaAutocare.pauseTarget(tiebaAutocarePauseSchema.parse(raw)),
    "tieba.autocare.reconcile": (raw) =>
      tiebaAutocare.reconcile(tiebaAutocareReconcileSchema.parse(raw)),
  } satisfies HandlerMap;
}

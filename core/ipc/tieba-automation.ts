import {
  tiebaAutomationSaveSchema,
  tiebaAutomationToggleSchema,
  tiebaAutomationReconcileSchema,
} from "../../shared/tieba-automation";
import type { TiebaAutomation } from "../tieba-automation/service";

export function createTiebaAutomationHandlers({
  tiebaAutomation,
}: {
  tiebaAutomation: TiebaAutomation;
}) {
  return {
    "tieba.automation.snapshot": () => tiebaAutomation.snapshot(),
    "tieba.automation.save": (raw: unknown) =>
      tiebaAutomation.save(tiebaAutomationSaveSchema.parse(raw)),
    "tieba.automation.toggle": (raw: unknown) =>
      tiebaAutomation.toggle(tiebaAutomationToggleSchema.parse(raw)),
    "tieba.automation.reconcile": (raw: unknown) =>
      tiebaAutomation.reconcile(tiebaAutomationReconcileSchema.parse(raw)),
  };
}

import type { SupplyDraft } from "../../shared/content-supply";
export type SupplyEditorAction = (
  label: string,
  action: () => Promise<SupplyDraft>,
  message: string,
) => Promise<void>;

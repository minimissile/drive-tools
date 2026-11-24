import { z } from "zod";
import { writeDraft } from "../storage/local-draft";
import { windowStorage } from "../storage/window-storage";

export const tiebaDraftSelectionKey = (workspace: string) =>
  `panxu-tieba-publishing-selection-v1:${workspace}`;

export const tiebaDraftSelectionSchema = z.object({
  id: z.string(),
  tab: z.enum(["compose", "statistics"]),
  newKey: z.string().default("initial"),
});

export const tiebaDraftSelectionDefaults = tiebaDraftSelectionSchema.parse({
  id: "",
  tab: "compose",
});

export function selectSavedTiebaDraft(workspace: string, id: string) {
  return writeDraft(windowStorage, tiebaDraftSelectionKey(workspace), {
    ...tiebaDraftSelectionDefaults,
    id,
  });
}

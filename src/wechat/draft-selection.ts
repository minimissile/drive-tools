import { z } from "zod";
import { readDraft, writeDraft } from "../storage/local-draft";
import { windowStorage } from "../storage/window-storage";

export const wechatHistoryPageSize = 50;

export const wechatSelectionSchema = z.object({
  url: z.string().max(4000),
  selected: z.string().max(100),
  handoff: z.string().max(100).optional(),
  query: z.string().max(200),
  visibleCount: z
    .number()
    .int()
    .min(wechatHistoryPageSize)
    .default(wechatHistoryPageSize),
  lastEditions: z.record(z.string().max(100), z.string().max(100)).default({}),
});

export const wechatSelectionDefaults = wechatSelectionSchema.parse({
  url: "",
  selected: "",
  query: "",
});

export const wechatSelectionKey = (workspace: string) =>
  `panxu:wechat:${workspace}:selection`;

export function selectSavedWechatDraft(workspace: string, id: string) {
  const key = wechatSelectionKey(workspace);
  const previous = readDraft(windowStorage, key, wechatSelectionSchema.parse);
  return writeDraft(windowStorage, key, {
    ...(previous ?? wechatSelectionDefaults),
    selected: id,
    handoff: id,
    query: "",
  });
}

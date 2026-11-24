import { z } from "zod";
import type { Provider } from "./types";

export const keyboardSkinsCategory = "键盘皮肤";
export const keyboardSkinsDefaultCount = 12;
export const keyboardSkinsMaxCount = 30;

export const keyboardSkinSampleInput = z.object({
  count: z.number().int().min(1).max(keyboardSkinsMaxCount),
});
export const keyboardSkinDraftInput = z.object({
  requestId: z.uuid(),
  resourceIds: z
    .array(z.string().min(1).max(100))
    .min(1)
    .max(keyboardSkinsMaxCount)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "同一资源不能重复入稿。",
    ),
  title: z
    .string()
    .trim()
    .min(1, "请填写文章标题")
    .max(64, "标题最多 64 字")
    .optional(),
});
export type KeyboardSkinSampleInput = z.infer<typeof keyboardSkinSampleInput>;
export type KeyboardSkinDraftInput = z.infer<typeof keyboardSkinDraftInput>;

export interface KeyboardSkinOverview {
  total: number;
  available: number;
}

export interface KeyboardSkinItem {
  id: string;
  title: string;
  coverUrl: string;
  provider: Provider;
}

export interface KeyboardSkinSample {
  items: KeyboardSkinItem[];
  title: string;
}

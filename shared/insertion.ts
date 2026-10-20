import { z } from "zod";
export const insertionName = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine(
    (v) =>
      !/[\\/\x00-\x1f\x7f:*?"<>|]/.test(v) &&
      !/[. ]$/.test(v) &&
      ![".", ".."].includes(v),
    "名称不能包含路径、控制字符或不支持的字符",
  );
export const insertionMaterialInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("folder"), name: insertionName }),
  z.object({
    kind: z.literal("txt"),
    name: insertionName.refine(
      (v) => /\.txt$/i.test(v),
      "TXT 文件名应以 .txt 结尾",
    ),
    text: z
      .string()
      .min(1)
      .max(512 * 1024),
  }),
  z.object({
    kind: z.literal("image"),
    name: insertionName,
    mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
    base64: z.string().min(1).max(5_592_408),
  }),
]);
export type InsertionMaterialInput = z.infer<typeof insertionMaterialInput>;
export interface InsertionMaterial {
  id: string;
  kind: "folder" | "txt" | "image";
  name: string;
  mime: string;
  size: number;
}
export const insertionTargetInput = z.object({
  accountId: z.string().min(1),
  folderId: z.string().min(1).max(1000),
  path: z.string().min(1).max(500),
});
export type InsertionTarget = z.infer<typeof insertionTargetInput>;
export interface InsertionCandidate extends InsertionTarget {
  copyId: string;
  title: string;
  account: string;
}
export type InsertionState =
  | "pending"
  | "writing"
  | "success"
  | "skipped"
  | "uncertain"
  | "failed"
  | "cancelled";
export interface InsertionItem {
  id: string;
  target: InsertionTarget;
  account: string;
  ownerUid: string;
  material: InsertionMaterial;
  state: InsertionState;
  message: string;
  baseline: string[];
  remoteId?: string;
  acknowledged?: boolean;
}
export interface InsertionRun {
  id: string;
  createdAt: string;
  updatedAt: string;
  state: "preview" | "running" | "completed" | "cancelled" | "interrupted";
  items: InsertionItem[];
}
export interface InsertionHistory {
  id: string;
  createdAt: string;
  state: InsertionRun["state"];
  count: number;
}

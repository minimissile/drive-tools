import { z } from "zod";
import type { Provider } from "./types";

export const photoPlatforms = ["douyin", "kuaishou", "xiaohongshu"] as const;
export type PhotoPlatform = (typeof photoPlatforms)[number];
export const photoPlatformNames: Record<PhotoPlatform, string> = {
  douyin: "抖音",
  kuaishou: "快手",
  xiaohongshu: "小红书",
};
export const photoProviders = ["quark", "baidu", "uc", "xunlei"] as const;
export const photoArtworkVersion = 2;
export const photoFormSchema = z.object({
  artworkVersion: z.literal(photoArtworkVersion).optional(),
  title: z.string().trim().min(1, "请填写资源标题").max(60),
  emphasis: z.string().max(16).optional(),
  coverStyle: z.enum(["type", "poster"]).optional(),
  subtitle: z.string().max(120),
  details: z.string().max(1200),
  audience: z.string().max(120),
  passphrase: z
    .string()
    .max(80)
    .refine(
      (v) => !/[\u0000-\u001f\u007f]/.test(v),
      "口令不能包含换行或控制字符",
    ),
  retrieval: z.enum(["search", "share-copy"]),
  theme: z.enum(["blue", "warm"]),
  platforms: z
    .array(z.enum(photoPlatforms))
    .min(1)
    .max(3)
    .refine((v) => new Set(v).size === v.length),
});
export type PhotoForm = z.infer<typeof photoFormSchema>;
export const photoWorkingFormSchema = photoFormSchema.extend({
  title: z.string().max(60),
  platforms: z.array(z.enum(photoPlatforms)).max(3),
});
export interface PhotoPublication {
  platform: PhotoPlatform;
  version: number;
  status: "opened" | "submitted" | "published";
  url: string | null;
  updatedAt: string;
}
export interface PhotoPost {
  id: string;
  resourceId: string;
  copyId: string;
  provider: Provider;
  shareUrl: string | null;
  shareVersion: number;
  ownerUid: string | null;
  resourceRevision: number;
  version: number;
  form: PhotoForm;
  exportedVersion: number | null;
  publications: PhotoPublication[];
  createdAt: string;
  updatedAt: string;
}
export const photoSaveSchema = z.object({
  id: z
    .string()
    .regex(/^photo_[\w-]+$/)
    .optional(),
  expectedVersion: z.number().int().positive().optional(),
  copyId: z.string().min(1).max(100),
  form: photoFormSchema,
});
export const photoVersionSchema = z.object({
  id: z.string().regex(/^photo_[\w-]+$/),
  version: z.number().int().positive(),
});
export function photoRetrievalSteps(form: PhotoForm, drive: string): string[] {
  return form.retrieval === "search"
    ? [
        `打开${drive} App`,
        `在搜索框输入「${form.passphrase || "待填写中文口令"}」`,
        "确认资源名称，保存到自己的网盘",
      ]
    : [
        "点击本作品的分享按钮",
        "复制作品链接（包含领取口令）",
        `打开${drive} App，按识别结果领取`,
      ];
}
export function photoPublicationText(
  form: PhotoForm,
  drive: string,
  platform: PhotoPlatform,
) {
  return [
    form.title,
    `领取口令：${form.passphrase || "（待填写）"}`,
    platform === "xiaohongshu"
      ? "整理了一份资料，先看看是否适合你。"
      : "这份资料可以用于下面的场景。",
    form.subtitle,
    form.details,
    form.audience ? `适合：${form.audience}` : "",
    `获取方式：${photoRetrievalSteps(form, drive).join(" → ")}。`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
type Contract<A, V> = { args: A; value: V };
export interface PhotoPostContract {
  "photoPosts.list": Contract<{ copyId?: string } | undefined, PhotoPost[]>;
  "photoPosts.get": Contract<{ id: string; copyId: string }, PhotoPost>;
  "photoPosts.save": Contract<z.infer<typeof photoSaveSchema>, PhotoPost>;
  "photoPosts.remove": Contract<{ id: string; version: number }, boolean>;
  "photoPosts.export": Contract<
    { id: string; version: number; images: string[] },
    { folder: string; post: PhotoPost } | null
  >;
  "photoPosts.open": Contract<
    { id: string; version: number; platform: PhotoPlatform },
    PhotoPost
  >;
  "photoPosts.result": Contract<
    {
      id: string;
      version: number;
      platform: PhotoPlatform;
      status: "submitted" | "published";
      url: string;
    },
    PhotoPost
  >;
}

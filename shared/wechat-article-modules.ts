import { z } from "zod";

export const wechatArticleModuleNameLimit = 40;
export const wechatArticleModuleBodyLimit = 20_000;

export interface WechatArticleModule {
  id: string;
  name: string;
  body: string;
  revision: number;
}

export const wechatDeleteArticleModuleInput = z.object({
  id: z.string().min(1).max(100),
  revision: z.number().int().positive().optional(),
});

export const wechatSaveArticleModuleInput = wechatDeleteArticleModuleInput
  .partial({ id: true })
  .extend({
    name: z
      .string()
      .trim()
      .min(1, "请填写模块名称。")
      .max(wechatArticleModuleNameLimit, "模块名称最多 40 字。"),
    body: z
      .string()
      .max(wechatArticleModuleBodyLimit, "模块正文最多 20,000 字。")
      .refine((body) => !!body.trim(), "请填写模块正文。"),
  });

export type WechatSaveArticleModuleInput = z.infer<
  typeof wechatSaveArticleModuleInput
>;
export type WechatDeleteArticleModuleInput = z.infer<
  typeof wechatDeleteArticleModuleInput
>;

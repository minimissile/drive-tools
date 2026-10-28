import type { ContentImage, ContentProvenance } from "./content-sources";
import { contentImageSchema, contentProvenanceSchema } from "./content-sources";
import { z } from "zod";
import { websiteAccountIdSchema } from "./website-accounts";

export const weiboPostInput = z.object({
  id: z.string().max(100).optional(),
  accountId: websiteAccountIdSchema,
  text: z.string().trim().min(1, "请填写微博文案").max(2000),
  visibility: z.enum(["public", "self"]).default("self"),
});
export type WeiboPost = {
  environment?: import("./browser-environments").EnvironmentStamp;
  id: string;
  accountId: string;
  uid: string;
  text: string;
  visibility: "public" | "self";
  images: { name: string; sha256: string; asset?: ContentImage }[];
  source?: ContentProvenance;
  stage:
    | "editing"
    | "filling"
    | "filled"
    | "submitting"
    | "submitted"
    | "uncertain"
    | "attention";
  message: string;
  url: string | null;
  createdAt: string;
  updatedAt: string;
};
/** Only local content fields survive a workspace restore; session/environment state is stripped. */
export const sourceWeiboPostBackup = z.object({
  id: z.string().regex(/^wbpost_[\w-]+$/),
  accountId: websiteAccountIdSchema,
  uid: z.string().min(1).max(150),
  text: z.string().trim().min(1).max(2000),
  visibility: z.enum(["public", "self"]),
  images: z
    .array(
      z.object({
        name: z.string().max(300),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        asset: contentImageSchema,
      }),
    )
    .max(9),
  source: contentProvenanceSchema,
  stage: z.enum([
    "editing",
    "filling",
    "filled",
    "submitting",
    "submitted",
    "uncertain",
    "attention",
  ]),
  message: z.string().max(1000),
  url: z.string().max(2000).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
type Contract<A, V> = { args: A; value: V };
export interface WeiboPostsContract {
  "weiboPosts.open": Contract<{ id: string }, boolean>;
  "weiboPosts.list": Contract<{ accountId: string }, WeiboPost[]>;
  "weiboPosts.save": Contract<z.input<typeof weiboPostInput>, WeiboPost>;
  "weiboPosts.images": Contract<{ id: string }, WeiboPost>;
  "weiboPosts.fill": Contract<{ id: string; confirmed: true }, WeiboPost>;
  "weiboPosts.submit": Contract<{ id: string; confirmed: true }, WeiboPost>;
  "weiboPosts.resolve": Contract<
    { id: string; url: string; confirmed: true },
    WeiboPost
  >;
}

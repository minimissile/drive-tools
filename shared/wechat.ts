import { z } from "zod";
import type {
  SmzdmSource,
  SmzdmResourceLink,
  SmzdmDetail,
  SmzdmIssue,
} from "./smzdm";
import type { WebsiteAccount } from "./website-accounts";
import { isWechatImageUrl } from "./wechat-markup";
import { wechatImageStyleSchema } from "./wechat-image-styles";
import { wechatTemplateSchema } from "./wechat-templates";
import {
  wechatReadMoreSchema,
  type WechatReadMoreEntry,
} from "./wechat-read-more";
import type {
  WechatTrafficWords,
  WechatTrafficWordPlan,
} from "./wechat-traffic-words";
import type { WechatRewriteStyleId } from "./wechat-rewrite";
import type {
  WechatDiscoverySearchResult,
  WechatDiscoveryStatsResult,
  wechatDiscoverySearch,
  wechatDiscoveryStatsInput,
} from "./wechat-discovery";

export { wechatArticleUrl } from "./smzdm";
export const wechatTextInput = z.object({
  title: z.string().trim().min(1, "请填写文章标题").max(64, "标题最多 64 字"),
  body: z
    .string()
    .min(1, "请填写正文")
    .max(200000)
    .refine((value) => !!value.trim(), "请填写正文"),
  author: z.string().trim().max(16),
  digest: z.string().trim().max(120),
  coverUrl: z
    .string()
    .trim()
    .max(4000)
    .refine((value) => {
      if (!value) return true;
      try {
        const url = new URL(value);
        return isWechatImageUrl(url);
      } catch {
        return false;
      }
    }, "请选择本地图片或填写 HTTPS 图片地址"),
  readMore: wechatReadMoreSchema.optional(),
  templateId: wechatTemplateSchema.optional(),
});
export type WechatText = z.infer<typeof wechatTextInput>;
export type WechatStage = "editing" | "sending" | "synced" | "uncertain";
export interface WechatRemote {
  accountId: string;
  uid: string;
  draftId: string;
  url: string;
  revision: number;
  sentAt: string;
}
export interface WechatEdition {
  rootId: string;
  parentId: string;
  number: number;
  requestId: string;
}
export interface WechatDeliveryRecord extends WechatRemote {
  title: string;
  accountName: string;
  action: "created" | "updated" | "verified" | "saved";
  rewriteStyleId?: WechatRewriteStyleId;
  publicationMarkedAt?: string;
}
export interface WechatEditionSummary {
  id: string;
  number: number;
  title: string;
  stage: WechatStage;
  rewriteStyleId?: WechatRewriteStyleId;
  deliveries: WechatDeliveryRecord[];
}
export interface WechatArticle extends WechatText {
  id: string;
  source: SmzdmSource;
  links: SmzdmResourceLink[];
  revision: number;
  aiAssisted: boolean;
  /** Last explicitly formatted or delivered template, separate from body edits. */
  typesettingVersion?: number;
  /** Last successful article rewrite, separate from the editor's next selected style. */
  rewriteStyleId?: WechatRewriteStyleId;
  /** Editorial input only; never included in the remote draft payload. */
  trafficWords?: WechatTrafficWords;
  edition?: WechatEdition;
  deliveryHistory?: WechatDeliveryRecord[];
  stage: WechatStage;
  message: string;
  remote: WechatRemote | null;
  /** Account intended for a write whose result still needs to be resolved. */
  pendingAccount: { id: string; uid: string } | null;
  /** Persisted immediately after WeChat returns an ID, before readback. No tokens. */
  pendingDraft?: WechatDraftVerification | null;
  createdAt: string;
  updatedAt: string;
}
export interface WechatDetail {
  article: WechatArticle;
  templateSupport?: true;
  readMoreEntries?: WechatReadMoreEntry[];
  automaticVerification?: boolean;
  trafficWordPlan?: WechatTrafficWordPlan;
  editions?: WechatEditionSummary[];
  issues: SmzdmIssue[];
  resources: SmzdmDetail["resources"];
}
export type WechatSummary = Pick<
  WechatArticle,
  | "id"
  | "title"
  | "stage"
  | "updatedAt"
  | "revision"
  | "rewriteStyleId"
  | "edition"
> & {
  sentRevision: number | null;
  sourceTitle?: string;
  materialId?: string;
  editionNumber?: number;
};
export interface WechatDraftPayload extends WechatText {
  key: string;
  uid: string;
  html: string;
  aiAssisted: boolean;
  draftId?: string;
  /** Native “阅读原文” entry; a body anchor is subject to account permissions. */
  sourceUrl?: string;
}
export interface WechatDraftReceipt {
  draftId: string;
  url: string;
}
export interface WechatDraftVerification extends WechatDraftReceipt {
  title: string;
  html: string;
  coverUrl: string;
  /** Undefined preserves compatibility with previously saved proofs. */
  sourceUrl?: string;
}
export function wechatTargetReceipt(
  article: WechatArticle,
  accountId: string,
): WechatRemote | undefined {
  const value =
    article.remote?.accountId === accountId ? article.remote : undefined;
  if (!value) return undefined;
  const { draftId, url, uid, revision, sentAt } = value;
  return { accountId, draftId, url, uid, revision, sentAt };
}
export interface WechatPort {
  readArticle(url: string): Promise<SmzdmSource>;
  saveDraft(
    account: WebsiteAccount,
    payload: WechatDraftPayload,
    beforeSubmit: () => Promise<void>,
    onReceipt?: (proof: WechatDraftVerification) => Promise<void>,
  ): Promise<WechatDraftReceipt>;
  verifyDraft?(
    account: WebsiteAccount,
    proof: WechatDraftVerification,
  ): Promise<void>;
  open(account: WebsiteAccount, url?: string): Promise<void>;
}
export const wechatImageBatchLimit = 20;
export type WechatImageGenerationMode = "reference" | "theme";
export const wechatRegenerateImagesInput = z.object({
  id: z.string().min(1).max(100),
  revision: z.number().int().positive(),
  targets: z
    .array(
      z.object({
        position: z.union([z.literal("cover"), z.number().int().nonnegative()]),
        url: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(wechatImageBatchLimit),
  confirmed: z.literal(true),
  style: wechatImageStyleSchema.optional(),
});
export const wechatThemeImagesInput = wechatRegenerateImagesInput
  .omit({ style: true })
  .extend({ description: z.string().trim().max(300).optional() });
export type WechatRegenerateImagesInput = z.infer<
  typeof wechatRegenerateImagesInput
>;
export interface WechatRegenerateImagesResult {
  detail: WechatDetail;
  replaced: number;
  failed: {
    position: WechatRegenerateImagesInput["targets"][number]["position"];
    message: string;
    code?: string;
  }[];
}
type Contract<A, V> = { args: A; value: V };
export interface WechatContract {
  "wechat.list": Contract<undefined, WechatSummary[]>;
  "wechat.get": Contract<{ id: string }, WechatDetail>;
  "wechat.newEdition": Contract<
    { id: string; revision: number; requestId: string; text?: WechatText },
    WechatDetail
  >;
  "wechat.markPublished": Contract<
    {
      id: string;
      sentRevision: number;
      published: boolean;
      accountId?: string;
    },
    WechatDetail
  >;
  "wechat.discoveryConfig": Contract<undefined, { configured: boolean }>;
  "wechat.discover": Contract<
    z.input<typeof wechatDiscoverySearch>,
    WechatDiscoverySearchResult
  >;
  "wechat.discoveryStats": Contract<
    z.input<typeof wechatDiscoveryStatsInput>,
    WechatDiscoveryStatsResult
  >;
  "wechat.import": Contract<{ url: string }, WechatDetail>;
  "wechat.save": Contract<
    WechatText & { id: string; revision: number },
    WechatDetail
  >;
  "wechat.resource": Contract<
    { id: string; linkId: string; accountId: string },
    { resourceId: string; copyId: string }
  >;
  "wechat.bindResource": Contract<
    { id: string; linkId: string; copyId: string },
    WechatDetail
  >;
  "wechat.syncLinks": Contract<{ id: string }, WechatDetail>;
  "wechat.format": Contract<{ id: string }, WechatDetail>;
  "wechat.rewrite": Contract<
    { id: string; instruction?: string; styleId?: WechatRewriteStyleId },
    WechatDetail
  >;
  "wechat.saveTrafficWords": Contract<
    { id: string; wordsRevision: number; words: string[] },
    WechatDetail
  >;
  "wechat.generateTitles": Contract<
    { id: string; revision: number; text?: WechatText },
    string[]
  >;
  "wechat.pickImage": Contract<
    { id: string },
    { url: string; name: string } | null
  >;
  "wechat.regenerateImages": Contract<
    WechatRegenerateImagesInput,
    WechatRegenerateImagesResult
  >;
  "wechat.generateThemeImages": Contract<
    z.infer<typeof wechatThemeImagesInput>,
    WechatRegenerateImagesResult
  >;
  "wechat.send": Contract<
    { id: string; revision: number; accountId: string; confirmed: true },
    WechatDetail
  >;
  "wechat.recheck": Contract<{ id: string }, WechatDetail>;
  "wechat.resolve": Contract<
    {
      id: string;
      result: "saved" | "not_saved";
      draftId?: string;
      url?: string;
      confirmed: true;
    },
    WechatDetail
  >;
  "wechat.open": Contract<{ accountId: string; id?: string }, boolean>;
}

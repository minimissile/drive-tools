import { z } from "zod";
import {
  wechatArticleUrl,
  wechatRegenerateImagesInput,
  wechatThemeImagesInput,
  wechatTextInput,
} from "../../shared/wechat";
import {
  defaultWechatRewriteStyle,
  wechatRewriteStyleSchema,
} from "../../shared/wechat-rewrite";
import type { HandlerMap, HandlerServices } from "./types";
import {
  wechatDiscoverySearch,
  wechatDiscoveryStatsInput,
} from "../../shared/wechat-discovery";
import { wechatTrafficWordsInput } from "../../shared/wechat-traffic-words";

const identifier = z.string().min(1).max(100);
const article = z.object({ id: identifier });
const version = article.extend({ revision: z.number().int().positive() });
export function createWechatHandlers({
  wechat,
}: Pick<HandlerServices, "wechat">) {
  return {
    "wechat.list": () => wechat.list(),
    "wechat.get": (raw) => wechat.get(article.parse(raw).id),
    "wechat.newEdition": (raw) => {
      const input = version
        .extend({ requestId: z.uuid(), text: wechatTextInput.optional() })
        .parse(raw);
      return wechat.newEdition(
        input.id,
        input.revision,
        input.requestId,
        input.text,
      );
    },
    "wechat.markPublished": (raw) => {
      const input = article
        .extend({
          sentRevision: z.number().int().positive(),
          published: z.boolean(),
        })
        .parse(raw);
      return wechat.markPublished(
        input.id,
        input.sentRevision,
        input.published,
      );
    },
    "wechat.discoveryConfig": () => wechat.discovery.config(),
    "wechat.discover": (raw) =>
      wechat.discovery.discover(wechatDiscoverySearch.parse(raw)),
    "wechat.discoveryStats": (raw) =>
      wechat.discovery.stats(wechatDiscoveryStatsInput.parse(raw)),
    "wechat.import": (raw) =>
      wechat.importArticle(z.object({ url: wechatArticleUrl }).parse(raw).url),
    "wechat.save": (raw) => {
      const i = version.extend(wechatTextInput.shape).parse(raw);
      return wechat.save(i.id, i.revision, i);
    },
    "wechat.resource": (raw) => {
      const i = article
        .extend({ linkId: identifier, accountId: identifier })
        .parse(raw);
      return wechat.resource(i.id, i.linkId, i.accountId);
    },
    "wechat.bindResource": (raw) => {
      const i = article
        .extend({ linkId: identifier, copyId: identifier })
        .parse(raw);
      return wechat.bindResource(i.id, i.linkId, i.copyId);
    },
    "wechat.syncLinks": (raw) => wechat.syncLinks(article.parse(raw).id),
    "wechat.format": (raw) => wechat.format(article.parse(raw).id),
    "wechat.saveTrafficWords": (raw) => {
      const input = article
        .extend({
          wordsRevision: z.number().int().nonnegative(),
          words: wechatTrafficWordsInput,
        })
        .parse(raw);
      return wechat.saveTrafficWords(
        input.id,
        input.wordsRevision,
        input.words,
      );
    },
    "wechat.rewrite": (raw) => {
      const i = article
        .extend({
          instruction: z.string().trim().max(1000).optional(),
          styleId: wechatRewriteStyleSchema.default(defaultWechatRewriteStyle),
        })
        .parse(raw);
      return wechat.rewrite(i.id, i.instruction, i.styleId);
    },
    "wechat.pickImage": (raw) => wechat.pickImage(article.parse(raw).id),
    "wechat.regenerateImages": (raw) =>
      wechat.regenerateImages(wechatRegenerateImagesInput.parse(raw)),
    "wechat.generateThemeImages": (raw) =>
      wechat.regenerateImages({
        ...wechatThemeImagesInput.parse(raw),
        mode: "theme",
      }),
    "wechat.send": (raw) => {
      const i = version
        .extend({ accountId: identifier, confirmed: z.literal(true) })
        .parse(raw);
      return wechat.send(i.id, i.revision, i.accountId);
    },
    "wechat.resolve": (raw) => {
      const i = article
        .extend({
          result: z.enum(["saved", "not_saved"]),
          draftId: z.string().max(100).optional(),
          url: z.string().max(4000).optional(),
          confirmed: z.literal(true),
        })
        .parse(raw);
      return wechat.resolve(i.id, i.result, i.draftId, i.url);
    },
    "wechat.open": (raw) => {
      const i = z
        .object({ accountId: identifier, id: identifier.optional() })
        .parse(raw);
      return wechat.open(i.accountId, i.id);
    },
  } satisfies HandlerMap;
}

import { z } from "zod";
import { smzdmTextInput, wechatArticleUrl } from "../../shared/smzdm";
import type { HandlerMap, HandlerServices } from "./types";
const identifier = z.string().min(1).max(100);
const article = z.object({ id: identifier });
const version = article.extend({ revision: z.number().int().positive() });
export function createSmzdmHandlers({ smzdm }: Pick<HandlerServices, "smzdm">) {
  return {
    "smzdm.openEditor": () => smzdm.openEditor(),
    "smzdm.list": () => smzdm.list(),
    "smzdm.get": (raw) => smzdm.get(article.parse(raw).id),
    "smzdm.import": (raw) =>
      smzdm.importArticle(z.object({ url: wechatArticleUrl }).parse(raw).url),
    "smzdm.save": (raw) => {
      const i = version.extend(smzdmTextInput.shape).parse(raw);
      return smzdm.save(i.id, i.revision, i);
    },
    "smzdm.resource": (raw) => {
      const i = article
        .extend({ linkId: identifier, accountId: identifier })
        .parse(raw);
      return smzdm.resource(i.id, i.linkId, i.accountId);
    },
    "smzdm.bindResource": (raw) => {
      const i = article
        .extend({ linkId: identifier, copyId: identifier })
        .parse(raw);
      return smzdm.bindResource(i.id, i.linkId, i.copyId);
    },
    "smzdm.syncLinks": (raw) => smzdm.syncLinks(article.parse(raw).id),
    "smzdm.format": (raw) => smzdm.format(article.parse(raw).id),
    "smzdm.polish": (raw) => smzdm.polish(article.parse(raw).id),
    "smzdm.review": (raw) => {
      const i = version.extend({ confirmed: z.literal(true) }).parse(raw);
      return smzdm.review(i.id, i.revision);
    },
    "smzdm.prepare": (raw) => smzdm.prepare(article.parse(raw).id),
    "smzdm.checkResult": (raw) => smzdm.checkResult(article.parse(raw).id),
    "smzdm.publish": (raw) => {
      const i = version.extend({ confirmed: z.literal(true) }).parse(raw);
      return smzdm.publish(i.id, i.revision);
    },
    "smzdm.resolve": (raw) => {
      const i = article
        .extend({
          result: z.enum(["not_submitted", "submitted", "published"]),
          url: z.string().max(2000).optional(),
          confirmed: z.literal(true),
        })
        .parse(raw);
      return smzdm.resolve(i.id, i.result, i.url);
    },
  } satisfies HandlerMap;
}

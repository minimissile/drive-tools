import { z } from "zod";
import {
  weiboDeliveryOptions,
  weiboMarketingInput,
} from "../../shared/weibo-marketing";
import type { HandlerMap, HandlerServices } from "./types";

const identifier = z.object({ id: z.string().min(1).max(100) });
export function createWeiboHandlers({ weibo }: Pick<HandlerServices, "weibo">) {
  return {
    "weibo.words": async (raw) =>
      weibo.words(z.object({ query: z.string().max(100) }).parse(raw)),
    "weibo.matches": async (raw) =>
      weibo.matches(z.object({ keyword: z.string().max(100) }).parse(raw)),
    "weibo.history": async () => weibo.history(),
    "weibo.get": async (raw) => weibo.get(identifier.parse(raw).id),
    "weibo.create": async (raw) => weibo.create(weiboMarketingInput.parse(raw)),
    "weibo.generate": async (raw) => {
      const input = identifier
        .extend({ artwork: z.enum(["cover", "creative"]) })
        .parse(raw);
      return weibo.generate(input.id, input.artwork);
    },
    "weibo.attachDraft": async (raw) => {
      const input = identifier
        .extend({ draftId: z.string().min(1).max(100) })
        .parse(raw);
      return weibo.attachDraft(input.id, input.draftId);
    },
    "weibo.configure": async (raw) => {
      const input = identifier
        .extend({ options: weiboDeliveryOptions })
        .parse(raw);
      return weibo.configure(input.id, input.options);
    },
    "weibo.prepare": async (raw) => weibo.prepare(identifier.parse(raw).id),
    "weibo.handoff": async (raw) => weibo.handoff(identifier.parse(raw).id),
    "weibo.fill": async (raw) => weibo.fill(identifier.parse(raw).id),
    "weibo.submit": async (raw) =>
      weibo.submit(
        identifier.extend({ confirmed: z.literal(true) }).parse(raw).id,
      ),
    "weibo.openFolder": async (raw) =>
      weibo.openFolder(identifier.parse(raw).id),
    "weibo.openReceipt": async (raw) =>
      weibo.openReceipt(identifier.parse(raw).id),
    "weibo.resolve": async (raw) => {
      const input = identifier
        .extend({
          result: z.enum(["submitted", "published", "not_submitted"]),
          url: z.string().max(2000),
          confirmed: z.literal(true),
        })
        .parse(raw);
      return weibo.resolve(input.id, input.result, input.url);
    },
  } satisfies HandlerMap;
}

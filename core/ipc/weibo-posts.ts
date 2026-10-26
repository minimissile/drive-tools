import { z } from "zod";
import { weiboPostInput } from "../../shared/weibo-posts";
import { websiteAccountIdSchema } from "../../shared/website-accounts";
import type { HandlerMap, HandlerServices } from "./types";
const identifier = z.object({ id: z.string().regex(/^wbpost_[\w-]+$/) });
const confirmed = identifier.extend({ confirmed: z.literal(true) });
export function createWeiboPostHandlers({
  weiboPosts,
}: Pick<HandlerServices, "weiboPosts">) {
  return {
    "weiboPosts.open": async (raw) => weiboPosts.open(identifier.parse(raw).id),
    "weiboPosts.list": async (raw) =>
      weiboPosts.list(
        z.object({ accountId: websiteAccountIdSchema }).parse(raw).accountId,
      ),
    "weiboPosts.save": async (raw) =>
      weiboPosts.save(weiboPostInput.parse(raw)),
    "weiboPosts.images": async (raw) =>
      weiboPosts.images(identifier.parse(raw).id),
    "weiboPosts.fill": async (raw) => weiboPosts.fill(confirmed.parse(raw).id),
    "weiboPosts.submit": async (raw) =>
      weiboPosts.submit(confirmed.parse(raw).id),
    "weiboPosts.resolve": async (raw) => {
      const input = confirmed.extend({ url: z.string().max(2000) }).parse(raw);
      return weiboPosts.resolve(input.id, input.url);
    },
  } satisfies HandlerMap;
}

import { z } from "zod";
import { environmentIdSchema } from "../../shared/browser-environments";
import {
  websiteAccountIdSchema,
  websiteProviderSchema,
  weiboPublishingSchema,
} from "../../shared/website-accounts";
import type { HandlerServices, HandlerMap } from "./types";
export function createWebsiteAccountHandlers(
  services: Pick<HandlerServices, "websiteAccounts">,
) {
  const id = z.object({ id: websiteAccountIdSchema });
  const alias = z.string().trim().min(1).max(60);
  return {
    "websiteAccounts.list": () => services.websiteAccounts.list(),
    "websiteAccounts.add": (object) => {
      const value = z
        .object({
          provider: websiteProviderSchema,
          alias: alias.optional(),
          environmentId: environmentIdSchema.optional(),
        })
        .parse(object);
      return services.websiteAccounts.add(
        value.provider,
        value.alias,
        value.environmentId,
      );
    },
    "websiteAccounts.rename": (object) => {
      const value = id.extend({ alias }).parse(object);
      return services.websiteAccounts.rename(value.id, value.alias);
    },
    "websiteAccounts.login": async (object) => {
      await services.websiteAccounts.login(id.parse(object).id);
      return true;
    },
    "websiteAccounts.check": (object) =>
      services.websiteAccounts.verify(id.parse(object).id),
    "websiteAccounts.openDocument": (object) => {
      const value = id
        .extend({ url: z.string().trim().min(1).max(2048) })
        .parse(object);
      return services.websiteAccounts.openDocument(value.id, value.url);
    },
    "websiteAccounts.weiboPublishing": (object) =>
      services.websiteAccounts.weiboPublishing(
        weiboPublishingSchema.parse(object),
      ),
    "websiteAccounts.remove": async (object) => {
      const value = id.extend({ confirmed: z.literal(true) }).parse(object);
      await services.websiteAccounts.remove(value.id);
      return true;
    },
  } satisfies HandlerMap;
}

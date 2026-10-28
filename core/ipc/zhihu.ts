import { z } from "zod";
import type { HandlerServices } from "./types";
import { zhihuContentInput, zhihuPolicyInput } from "../../shared/zhihu";
import { websiteAccountIdSchema } from "../../shared/website-accounts";
const identifier = z.object({ id: z.string().min(1).max(150) });
const account = z.object({ accountId: websiteAccountIdSchema });
export function createZhihuHandlers({ zhihu }: Pick<HandlerServices, "zhihu">) {
  return {
    "zhihu.snapshot": () => zhihu.snapshot(),
    "zhihu.content.save": (raw: unknown) =>
      zhihu.saveContent(zhihuContentInput.parse(raw)),
    "zhihu.content.review": (raw: unknown) => {
      const v = identifier
        .extend({
          version: z.number().int().positive(),
          confirmed: z.literal(true),
        })
        .parse(raw);
      return zhihu.review(v.id, v.version);
    },
    "zhihu.content.images": (raw: unknown) =>
      zhihu.images(identifier.parse(raw).id),
    "zhihu.content.import": (raw: unknown) =>
      zhihu.importDraft(
        z.object({ draftId: z.string().min(1).max(150) }).parse(raw).draftId,
      ),
    "zhihu.plan.save": (raw: unknown) =>
      zhihu.configure(zhihuPolicyInput.parse(raw)),
    "zhihu.plan.active": (raw: unknown) => {
      const v = account.extend({ active: z.boolean() }).parse(raw);
      return zhihu.activate(v.accountId, v.active);
    },
    "zhihu.progress.check": (raw: unknown) =>
      zhihu.checkProgress(account.parse(raw).accountId),
    "zhihu.progress.record": (raw: unknown) => {
      const v = account
        .extend({
          creator: z.boolean(),
          level: z.number().int().min(0).max(10),
          note: z.string().trim().min(5).max(500),
        })
        .parse(raw);
      return zhihu.record(v.accountId, v.creator, v.level, v.note);
    },
    "zhihu.enqueue": (raw: unknown) => {
      const v = account
        .extend({
          contentId: z.string().min(1).max(150),
          scheduledAt: z.iso.datetime({ offset: true }),
          confirmed: z.literal(true),
        })
        .parse(raw);
      return zhihu.enqueue(v.accountId, v.contentId, v.scheduledAt);
    },
    "zhihu.scheduler": (raw: unknown) =>
      zhihu.scheduler(
        z
          .object({ running: z.boolean(), confirmed: z.literal(true) })
          .parse(raw).running,
      ),
    "zhihu.task.cancel": (raw: unknown) =>
      zhihu.cancel(identifier.parse(raw).id),
    "zhihu.task.resolve": (raw: unknown) => {
      const v = identifier
        .extend({
          outcome: z.enum(["published", "not_published"]),
          url: z.string().max(500).optional(),
          confirmed: z.literal(true),
        })
        .parse(raw);
      return zhihu.resolve(v.id, v.outcome, v.url);
    },
  };
}

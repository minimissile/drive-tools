import { z } from "zod";
import type { HandlerMap, HandlerServices } from "./types";
const identifier = z.object({ id: z.string().min(1).max(100) });
export function createCsdnHandlers({ csdn }: Pick<HandlerServices, "csdn">) {
  return {
    "csdn.words": async (raw) => csdn.words(raw),
    "csdn.matches": async (raw) => csdn.matches(raw),
    "csdn.history": async () => csdn.history(),
    "csdn.get": async (raw) => csdn.get(identifier.parse(raw).id),
    "csdn.create": async (raw) => csdn.create(raw),
    "csdn.generate": async (raw) => csdn.generate(identifier.parse(raw).id),
    "csdn.attachDraft": async (raw) => {
      const i = identifier
        .extend({ draftId: z.string().min(1).max(100) })
        .parse(raw);
      return csdn.attachDraft(i.id, i.draftId);
    },
    "csdn.configure": async (raw) => {
      const i = identifier.extend({ options: z.unknown() }).parse(raw);
      return csdn.configure(i.id, i.options);
    },
    "csdn.prepare": async (raw) => csdn.prepare(identifier.parse(raw).id),
    "csdn.inspect": async (raw) => csdn.inspect(identifier.parse(raw).id),
    "csdn.submit": async (raw) =>
      csdn.submit(
        identifier.extend({ confirmed: z.literal(true) }).parse(raw).id,
      ),
    "csdn.resolve": async (raw) => {
      const i = identifier
        .extend({
          result: z.enum(["submitted", "published", "not_submitted"]),
          url: z.string().max(2000),
          confirmed: z.literal(true),
        })
        .parse(raw);
      return csdn.resolve(i.id, i.result, i.url);
    },
  } satisfies HandlerMap;
}

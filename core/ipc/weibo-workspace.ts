import { z } from "zod";
import { weiboIdeaInput, weiboStyleInput } from "../../shared/weibo-workspace";
import type { HandlerMap, HandlerServices } from "./types";
const identifier = z.object({ id: z.string().regex(/^wbidea_[\w-]+$/) });
const account = z.object({ accountId: z.string().min(1).max(150) });
export function createWeiboWorkspaceHandlers({
  weiboWorkspace: w,
}: Pick<HandlerServices, "weiboWorkspace">) {
  return {
    "weiboWorkspace.list": async () => w.list(),
    "weiboWorkspace.get": async (raw) => w.get(identifier.parse(raw).id),
    "weiboWorkspace.save": async (raw) => w.save(weiboIdeaInput.parse(raw)),
    "weiboWorkspace.variant": async (raw) => {
      const v = z
        .object({
          id: z.string().min(1).max(150),
          kind: z.enum(["idea", "post", "marketing"]).default("idea"),
        })
        .merge(account)
        .parse(raw);
      return w.variant(v.id, v.accountId, v.kind);
    },
    "weiboWorkspace.generate": async (raw) =>
      w.generate(identifier.parse(raw).id),
    "weiboWorkspace.deliver": async (raw) =>
      w.deliver(identifier.parse(raw).id),
    "weiboWorkspace.style": async (raw) =>
      w.style(account.parse(raw).accountId),
    "weiboWorkspace.saveStyle": async (raw) =>
      w.saveStyle(weiboStyleInput.parse(raw)),
  } satisfies HandlerMap;
}

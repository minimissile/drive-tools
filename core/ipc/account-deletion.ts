import { z } from "zod";
import type { HandlerMap, HandlerServices } from "./types";

export function createAccountDeletionHandlers(
  s: Pick<HandlerServices, "accountDeletion">,
) {
  return {
    "account.deletePreview": (raw) =>
      s.accountDeletion.preview(
        z.object({ id: z.string().min(1).max(100) }).parse(raw).id,
      ),
    "account.remove": (raw) =>
      s.accountDeletion.remove(
        z.object({ token: z.string().uuid() }).parse(raw).token,
      ),
  } satisfies HandlerMap;
}

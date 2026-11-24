import { z } from "zod";
import { accountBatchInput } from "../../shared/account-batch";
import type { HandlerMap, HandlerServices } from "./types";
export function createAccountBatchHandlers(
  s: Pick<HandlerServices, "accountBatches">,
) {
  return {
    "accountBatch.start": (raw) =>
      s.accountBatches.start(accountBatchInput.parse(raw)),
    "accountBatch.current": () => s.accountBatches.current(),
    "accountBatch.stop": (raw) =>
      s.accountBatches.stop(
        z.object({ id: z.string().min(1).max(150) }).parse(raw).id,
      ),
  } satisfies HandlerMap;
}

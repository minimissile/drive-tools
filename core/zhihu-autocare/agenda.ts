import { randomInt } from "node:crypto";
import type { AutocareState } from "../../shared/zhihu-autocare";
import type { ZhihuSnapshot } from "../../shared/zhihu";
import { findOperationsSlot } from "../intelligent-operations/policy";
/** Local scheduling only: never opens a browser or calls a paid provider. */
export function nextAutocareCycle(
  state: AutocareState,
  snapshot: ZhihuSnapshot,
  accountId: string,
  after: number,
) {
  const reservations = snapshot.tasks
    .filter((t) => t.attemptedAt || t.status === "queued")
    .map((t) => ({
      at: t.attemptedAt ?? t.scheduledAt,
      accountId: t.accountId,
      network: "unknown",
      gapOnly: true,
    }));
  for (const [owner, cycle] of Object.entries(state.cycles))
    if (owner !== accountId)
      reservations.push({
        at: cycle.at,
        accountId: owner,
        network: "unknown",
        gapOnly: true,
      });
  const at = findOperationsSlot(
    after + randomInt(5, 21) * 60000,
    state.config,
    1000,
    Math.max(60, state.config.gapMinutes),
    reservations,
    accountId,
    "unknown",
    after + 8 * 86400000,
  );
  return at;
}

import { randomInt } from "node:crypto";
import type { AutocareState } from "../../shared/zhihu-autocare";
import type { ZhihuSnapshot } from "../../shared/zhihu";
import { findAutocareRunSlot } from "./run-window";
/** Local scheduling only: never opens a browser or calls a paid provider. */
export function nextAutocareCycle(
  state: AutocareState,
  snapshot: ZhihuSnapshot,
  accountId: string,
  after: number,
  interactions: { at: string; accountId: string }[] = [],
) {
  const reservations = snapshot.tasks
    .filter((t) => t.attemptedAt || t.status === "queued")
    .map((t) => ({
      at: t.attemptedAt ?? t.scheduledAt,
      accountId: t.accountId,
      network: "unknown",
      gapOnly: true,
    }));
  reservations.push(
    ...interactions.map((interaction) => ({
      at: interaction.at,
      accountId: interaction.accountId,
      network: "unknown",
      gapOnly: true,
    })),
  );
  for (const [owner, cycle] of Object.entries(state.cycles))
    if (owner !== accountId)
      reservations.push({
        at: cycle.at,
        accountId: owner,
        network: "unknown",
        gapOnly: true,
      });
  return findAutocareRunSlot(
    state,
    after + randomInt(15, 46) * 1000,
    reservations,
  );
}

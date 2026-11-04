import type { OperationsChannelPolicy } from "./types";
import type { OperationsTask } from "../../shared/intelligent-operations";

export const awaitingOperationsTask = (t: OperationsTask) =>
  ["planned", "review", "blocked", "handoff"].includes(t.status) &&
  !t.attemptedAt &&
  !t.linkedTaskId;

export const operationalDay = (at: number | string) =>
  new Date(new Date(at).getTime() + 8 * 3600000).toISOString().slice(0, 10);
/** Returns the earliest slot within a daytime execution window and the seven-day horizon. */
export function findOperationsSlot(
  start: number,
  policy: Pick<OperationsChannelPolicy, "windowStart" | "windowEnd">,
  dailyLimit: number,
  gapMinutes: number,
  existing: {
    at: string;
    accountId: string;
    network: string;
    gapOnly?: boolean;
  }[],
  accountId: string,
  network: string,
  horizon: number,
) {
  let at = start;
  const gap = gapMinutes * 60000;
  for (let i = 0; i < 400 && at < horizon; i++) {
    const day = operationalDay(at),
      begin = Date.parse(`${day}T${policy.windowStart}:00+08:00`),
      end = Date.parse(`${day}T${policy.windowEnd}:00+08:00`);
    if (at < begin) {
      at = begin;
      continue;
    }
    if (
      at >= end ||
      existing.filter(
        (e) =>
          !e.gapOnly &&
          e.accountId === accountId &&
          operationalDay(e.at) === day,
      ).length >= dailyLimit
    ) {
      at = Date.parse(`${day}T00:00:00+08:00`) + 86400000;
      continue;
    }
    const conflict = existing.filter(
      (e) =>
        (e.accountId === accountId ||
          !network ||
          !e.network ||
          e.network === network) &&
        Math.abs(Date.parse(e.at) - at) < gap,
    );
    if (conflict.length) {
      at = Math.max(...conflict.map((e) => Date.parse(e.at) + gap));
      continue;
    }
    return new Date(at).toISOString();
  }
  return null;
}
export const terminalOperationsTask = (t: OperationsTask) =>
  ["completed", "cancelled", "attention"].includes(t.status) ||
  !!t.attemptedAt ||
  !!t.linkedTaskId ||
  !!t.submittedAt;

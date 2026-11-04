import { randomInt } from "node:crypto";
import type { AutocareState } from "../../shared/zhihu-autocare";
import type { ZhihuSnapshot } from "../../shared/zhihu";
import { zhihuDay, zhihuWeek } from "../zhihu/policy";
import { findOperationsSlot } from "../intelligent-operations/policy";
export function autocareSlot(
  state: AutocareState,
  snapshot: ZhihuSnapshot,
  accountId: string,
  at: number,
  interactions: { at: string; accountId: string; networkKey: string }[],
) {
  const cfg = state.config,
    plan = snapshot.accounts.find((a) => a.id === accountId)!.plan;
  const daily = Math.min(cfg.dailyLimit, plan.dailyLimit),
    weekly = Math.min(cfg.weeklyLimit, plan.weeklyLimit);
  const existing = snapshot.tasks
    .filter((t) => t.attemptedAt || t.status === "queued")
    .map((t) => ({
      at: t.attemptedAt ?? t.scheduledAt,
      accountId: t.accountId,
      network: "unknown",
    }));
  const gaps = interactions.map((i) => ({
    at: i.at,
    accountId: i.accountId,
    network: "unknown",
    gapOnly: true,
  }));
  for (const [owner, cycle] of Object.entries(state.cycles))
    gaps.push({
      at: cycle.at,
      accountId: owner,
      network: "unknown",
      gapOnly: true,
    });
  let start = at + 30000;
  for (let d = 0; d < 8; d++) {
    const day = zhihuDay(start),
      week = zhihuWeek(start);
    if (
      existing.filter(
        (e) => e.accountId === accountId && zhihuWeek(e.at) === week,
      ).length >= weekly
    ) {
      start = Date.parse(`${day}T00:00:00+08:00`) + 86400000;
      continue;
    }
    const first = findOperationsSlot(
      start,
      cfg,
      daily,
      Math.max(cfg.gapMinutes, plan.gapMinutes),
      [...existing, ...gaps],
      accountId,
      "unknown",
      at + 7 * 86400000,
    );
    if (!first) return null;
    if (zhihuWeek(first) !== week) {
      start = Date.parse(first);
      continue;
    }
    const end = Date.parse(`${zhihuDay(first)}T${cfg.windowEnd}:00+08:00`);
    const count = existing.filter(
      (e) => e.accountId === accountId && zhihuDay(e.at) === zhihuDay(first),
    ).length;
    const room = Math.max(
      0,
      Math.floor(
        (end -
          Date.parse(first) -
          Math.max(0, daily - count - 1) * cfg.gapMinutes * 60000 -
          1000) /
          1000,
      ),
    );
    const selected =
      Date.parse(first) + (room > 0 ? randomInt(room + 1) * 1000 : 0);
    const final =
      findOperationsSlot(
        selected,
        cfg,
        daily,
        Math.max(cfg.gapMinutes, plan.gapMinutes),
        [...existing, ...gaps],
        accountId,
        "unknown",
        at + 7 * 86400000,
      ) ?? first;
    if (
      existing.filter(
        (e) =>
          e.accountId === accountId && zhihuWeek(e.at) === zhihuWeek(final),
      ).length >= weekly
    ) {
      start = Date.parse(final);
      continue;
    }
    return final;
  }
  return null;
}

import type { AutocareState } from "../../shared/zhihu-autocare";
import type { ZhihuSnapshot } from "../../shared/zhihu";
import { zhihuDay, zhihuWeek } from "../zhihu/policy";
import { autocareRunWindow, findAutocareRunSlot } from "./run-window";
/** Choose the earliest available submission in this exact two-hour batch. */
export function autocareSlot(
  state: AutocareState,
  snapshot: ZhihuSnapshot,
  accountId: string,
  at: number,
  interactions: { at: string; accountId: string; networkKey: string }[],
) {
  const window = autocareRunWindow(state);
  if (!window) return null;
  const existing = snapshot.tasks.filter(
    (task) => task.attemptedAt || task.status === "queued",
  );
  const own = existing.filter((task) => task.accountId === accountId);
  const stamp = (task: (typeof own)[number]) =>
    task.attemptedAt ?? task.scheduledAt;
  if (
    own.filter((task) => zhihuDay(stamp(task)) === zhihuDay(at)).length >=
      state.config.dailyLimit ||
    own.filter((task) => zhihuWeek(stamp(task)) === zhihuWeek(at)).length >=
      state.config.weeklyLimit ||
    own.filter(
      (task) =>
        Date.parse(stamp(task)) >= window.start &&
        Date.parse(stamp(task)) < window.end,
    ).length >= state.config.dailyLimit
  )
    return null;
  return findAutocareRunSlot(state, at + 15000, [
    ...existing.map((task) => ({ at: stamp(task), accountId: task.accountId })),
    ...interactions,
  ]);
}

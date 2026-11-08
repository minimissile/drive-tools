import type { AutocareState } from "../../shared/zhihu-autocare";

export const autocareRunDuration = 2 * 60 * 60 * 1000;
export const autocareRunGapMinutes = 5;
export function autocareRunWindow(state: AutocareState) {
  if (!state.run) return null;
  const start = Date.parse(state.run.startedAt),
    end = Date.parse(state.run.deadlineAt);
  return Number.isFinite(start) && Number.isFinite(end) && end > start
    ? { start, end }
    : null;
}
export function withinAutocareRun(state: AutocareState, at = Date.now()) {
  const window = autocareRunWindow(state);
  return (
    !!window &&
    state.run?.status === "running" &&
    at >= window.start &&
    at < window.end
  );
}
/** A precise batch horizon, including batches crossing midnight. Never advances to tomorrow. */
export function findAutocareRunSlot(
  state: AutocareState,
  after: number,
  reservations: { at: string; accountId: string }[],
) {
  const window = autocareRunWindow(state);
  if (!window || state.run?.status !== "running") return null;
  let at = Math.max(after, window.start);
  const gap = autocareRunGapMinutes * 60000;
  for (let i = 0; i < 1000 && at < window.end - 30000; i++) {
    const conflicts = reservations.filter(
      (entry) => Math.abs(Date.parse(entry.at) - at) < gap,
    );
    if (!conflicts.length) return new Date(at).toISOString();
    at = Math.max(...conflicts.map((entry) => Date.parse(entry.at) + gap));
  }
  return null;
}

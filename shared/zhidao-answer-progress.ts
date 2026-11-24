import type { OperationRun } from "./zhidao";

const dayMs = 24 * 60 * 60 * 1000;
const offsetMs = 8 * 60 * 60 * 1000;

/** Answer progress follows the Beijing calendar day, independent of host timezone. */
export function answerProgressDay(time = Date.now()) {
  const start = Math.floor((time + offsetMs) / dayMs) * dayMs - offsetMs;
  return {
    start: new Date(start).toISOString(),
    end: new Date(start + dayMs).toISOString(),
  };
}

export function isTodayAnswerRun(
  run: Pick<OperationRun, "createdAt">,
  time = Date.now(),
) {
  const day = answerProgressDay(time);
  const createdAt = Date.parse(run.createdAt);
  return createdAt >= Date.parse(day.start) && createdAt < Date.parse(day.end);
}

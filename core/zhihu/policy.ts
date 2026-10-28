import type { ZhihuPlan, ZhihuTask } from "../../shared/zhihu";

// Operational dates are consistently Asia/Shanghai, independent of the host clock zone.
export const zhihuDay = (date: string | number) =>
  new Date(new Date(date).getTime() + 8 * 3600000).toISOString().slice(0, 10);
export function zhihuWeek(date: string | number) {
  const d = new Date(`${zhihuDay(date)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
export function zhihuCounts(
  tasks: ZhihuTask[],
  accountId: string,
  time: number,
) {
  const attempts = tasks.filter(
    (t) => t.accountId === accountId && t.attemptedAt,
  );
  return {
    today: attempts.filter((t) => zhihuDay(t.attemptedAt!) === zhihuDay(time))
      .length,
    week: attempts.filter((t) => zhihuWeek(t.attemptedAt!) === zhihuWeek(time))
      .length,
  };
}
export function zhihuDue(
  tasks: ZhihuTask[],
  task: ZhihuTask,
  plan: ZhihuPlan,
  networkKey: string,
  time: number,
) {
  const counts = zhihuCounts(tasks, task.accountId, time);
  if (counts.today >= plan.dailyLimit || counts.week >= plan.weeklyLimit) {
    const next =
      new Date(`${zhihuDay(time)}T00:00:00+08:00`).getTime() + 33 * 3600000;
    return { at: next, reason: "已达本地日/周上限，等待下一可用日期" };
  }
  let next = new Date(task.scheduledAt).getTime();
  for (const other of tasks) {
    if (other.id === task.id || !other.attemptedAt) continue;
    if (
      other.accountId === task.accountId ||
      other.networkKey === networkKey ||
      networkKey === "unknown" ||
      other.networkKey === "unknown"
    )
      next = Math.max(
        next,
        new Date(other.attemptedAt).getTime() + plan.gapMinutes * 60000,
      );
  }
  return {
    at: next,
    reason: next > time ? "等待账号 / 同出口错峰间隔" : "到时可执行",
  };
}

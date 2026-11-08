import type {
  AutocareBlocker,
  AutocareState,
} from "../../shared/zhihu-autocare";
import {
  zhihuTaskNeedsReconciliation,
  type ZhihuSnapshot,
} from "../../shared/zhihu";
import type { ZhihuParticipationSnapshot } from "../../shared/zhihu-participation";

/** Current facts drive account stops. Individual proven unsubmitted failures remain visible. */
export function autocareBlockers(
  state: AutocareState,
  snapshot: ZhihuSnapshot,
  participation: ZhihuParticipationSnapshot,
  configurationIssues: string[] = [],
): AutocareBlocker[] {
  const result: AutocareBlocker[] = [];
  for (const accountId of state.config.accountIds) {
    const account = snapshot.accounts.find((a) => a.id === accountId);
    if (
      !account ||
      account.status !== "connected" ||
      account.uid !== state.identities[accountId]
    )
      result.push({
        accountId,
        kind: "account",
        message:
          !account || account.status !== "connected"
            ? "账号尚未恢复登录，请在账号管理检查原身份"
            : "当前登录身份与本轮绑定不一致，原任务不会换号执行",
        blocking: true,
        recoverable: true,
      });
    for (const message of configurationIssues)
      result.push({
        accountId,
        kind: "configuration",
        message,
        blocking: true,
      });
    if (state.researchStops[accountId]) {
      const detail = state.researchStopDetails[accountId];
      result.push({
        accountId,
        kind:
          detail?.kind === "authentication"
            ? "account"
            : detail?.kind === "interaction"
              ? "interaction"
              : "restriction",
        message: state.researchStops[accountId],
        blocking: true,
        activityId: detail?.activityId,
      });
    }
    const softMessage = state.accountMessages[accountId] || "";
    if (softMessage.startsWith("本项暂未完成，其他任务继续："))
      result.push({
        accountId,
        kind: "configuration",
        message: softMessage,
        blocking: false,
      });
    const ownJobs = state.jobs.filter((job) => job.accountId === accountId);
    for (const task of snapshot.tasks.filter(
      (t) => t.accountId === accountId && t.status === "attention",
    )) {
      const blocking = zhihuTaskNeedsReconciliation(task);
      result.push({
        accountId,
        kind: "publication",
        message: blocking
          ? task.message
          : `本项未提交，其他任务继续：${task.message}`,
        blocking,
        taskId: task.id,
        jobId: ownJobs.find((job) => job.taskId === task.id)?.id,
        recoverable: !blocking,
      });
    }
    for (const job of ownJobs.filter(
      (job) =>
        job.status === "attention" &&
        (!job.taskId || !snapshot.tasks.some((task) => task.id === job.taskId)),
    ))
      result.push({
        accountId,
        kind: "generation",
        message: job.message,
        blocking: true,
        jobId: job.id,
      });
    for (const activity of participation.activities.filter(
      (a) => a.accountId === accountId,
    )) {
      const attempt = activity.attempts?.findLast(
        (a) => a.status === "unknown" || a.status === "running",
      );
      if (attempt)
        result.push({
          accountId,
          kind: "interaction",
          message: attempt.error || "原互动进行中或结果未知，请只读核对原提交",
          blocking: true,
          activityId: activity.id,
        });
    }
  }
  return result.filter(
    (item, index, all) =>
      all.findIndex(
        (other) =>
          other.accountId === item.accountId &&
          other.kind === item.kind &&
          other.taskId === item.taskId &&
          other.activityId === item.activityId &&
          other.jobId === item.jobId &&
          other.message === item.message,
      ) === index,
  );
}

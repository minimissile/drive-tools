import { randomInt } from "node:crypto";
import type { OperationsBrainToolContext } from "./brain-types";
import type { OperationsTask } from "../../shared/intelligent-operations";
import { operationalDay } from "./policy";
import { zhihuRecommendedMinimumViews } from "../../shared/zhihu-participation";

export function isRecommendedAnswer(
  ctx: OperationsBrainToolContext,
  task: OperationsTask,
) {
  if (task.channel !== "zhihu" || !task.materialId?.startsWith("zhihu:"))
    return false;
  const snapshot = ctx.host.d.zhihuParticipation?.snapshot();
  const activity = snapshot?.activities.find(
    (a) =>
      a.planId === ctx.plan.id &&
      a.accountId === task.accountId &&
      a.kind === "answer" &&
      `zhihu:${a.contentId}` === task.materialId &&
      !a.resolution,
  );
  const candidate =
    activity &&
    snapshot?.candidates.find(
      (c) => c.id === activity.candidateId && c.accountId === task.accountId,
    );
  return (
    !!candidate?.recommendation &&
    candidate.recommendation.views > zhihuRecommendedMinimumViews
  );
}
/** Sample once inside the remainder of the earliest legal operating day. The caller persists it. */
export function randomRecommendedAnswerSlot(
  ctx: OperationsBrainToolContext,
  task: OperationsTask,
  earliest: string,
) {
  const policy = ctx.host.accountPolicy(ctx.plan, task.accountId);
  const at = Date.parse(earliest),
    end = Date.parse(`${operationalDay(at)}T${policy.windowEnd}:00+08:00`);
  const seconds = Math.floor((end - at - 1) / 1000);
  const sampled = at + (seconds > 0 ? randomInt(seconds + 1) * 1000 : 0);
  return ctx.host.publicationSlot(task, ctx.plan, sampled, true) ?? earliest;
}

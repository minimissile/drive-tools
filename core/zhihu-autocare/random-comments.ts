import {
  autocareRandomCommentScope,
  type AutocareCommentJob,
} from "../../shared/zhihu-autocare";
import type { ZhihuParticipationCandidate } from "../../shared/zhihu-participation";
import { id, now } from "../database";
import { AppError, safeMessage } from "../errors";
import {
  generateAutocareComment,
  checkAutocareComment,
} from "./comment-generation";
import type { AutocareParticipationHost } from "./participation";
import { autocareGenerationCount, fingerprint } from "./state";
import {
  randomInteractionGuard,
  randomInteractionWait,
  recordRandomInteractionResult,
  autocareInteractionRunContext,
} from "./random-interactions";
import { autocareRunGapMinutes } from "./run-window";

const normalized = (text: string) =>
  text.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "");

/** Reserve a target before generation; interrupted/failed paid work is never regenerated. */
export async function executeAutocareRandomComment(
  h: AutocareParticipationHost,
  candidate: ZhihuParticipationCandidate,
) {
  const accountId = candidate.accountId;
  const baseCheck = randomInteractionGuard(h, accountId, "comment");
  let ownActivityId: string | undefined;
  const check = () => {
    baseCheck();
    const participation = h.participation.snapshot();
    const accounts = h.zhihu.snapshot().accounts;
    if (
      participation.activities.some((activity) => {
        const sameActor =
          activity.accountId === accountId ||
          accounts.find((a) => a.id === activity.accountId)?.uid ===
            h.state.identities[accountId];
        return (
          activity.kind === "comment" &&
          activity.id !== ownActivityId &&
          sameActor &&
          participation.candidates.find((c) => c.id === activity.candidateId)
            ?.url === candidate.url
        );
      })
    )
      throw new AppError(
        "AUTOCARE_COMMENT_SKIP",
        "此账号对此目标已有评论记录或其他计划待办，未接管或重复评论",
      );
  };
  check();
  const wait = randomInteractionWait(h, accountId);
  if (wait) {
    h.log("random_comment.waiting", wait, accountId);
    h.status(accountId, wait);
    return;
  }
  if (autocareGenerationCount(h.state) >= h.state.config.generationsPerDay) {
    h.status(accountId, "已到今日AI生成次数上限，随机评论等待下一运营日");
    return;
  }
  const document = candidate.document;
  if (
    !document ||
    document.truncated ||
    !["answer", "article"].includes(document.kind)
  )
    throw new AppError(
      "AUTOCARE_COMMENT_BLOCKED",
      "随机评论需要准确回答或文章的完整正文",
    );
  if (
    h.state.commentJobs.some(
      (j) => j.uid === h.state.identities[accountId] && j.url === candidate.url,
    )
  )
    return;
  if (h.state.commentJobs.length >= 2000)
    throw new AppError(
      "AUTOCARE_COMMENT_BLOCKED",
      "评论生成历史已达2000条，请整理后继续",
    );
  h.ai.assertTextConfigured("copy");
  const job: AutocareCommentJob = {
    id: id("carecomment"),
    accountId,
    uid: h.state.identities[accountId],
    candidateId: candidate.id,
    candidateVersion: candidate.version,
    url: candidate.url,
    contextHash: fingerprint(document),
    revision: h.state.revision,
    model: h.state.model,
    status: "generating",
    message: `正在为《${candidate.title}》生成评论`,
    createdAt: now(),
    updatedAt: now(),
    body: "",
    quote: "",
    checks: [],
  };
  h.state.commentJobs.push(job);
  h.persist();
  h.status(accountId, job.message);
  h.log("random_comment.generating", `${job.message}；${job.id}`, accountId);
  try {
    const result = await generateAutocareComment(h.ai, job.id, document, () => {
      check();
      if (!job.generatedAt) {
        if (
          autocareGenerationCount(h.state) >= h.state.config.generationsPerDay
        )
          throw new AppError(
            "AUTOCARE_COMMENT_BLOCKED",
            "已到今日共享AI生成次数上限",
          );
        job.generatedAt = now();
        h.persist();
      }
    });
    if (h.closed()) return;
    // Retain paid output even when disabled in flight; submission still checks revision.
    job.body = result.body;
    job.updatedAt = now();
    h.persist();
    const checked = checkAutocareComment(result, document);
    const duplicate = normalized(result.body);
    if (
      h.state.commentJobs.some(
        (other) =>
          other.id !== job.id &&
          other.body &&
          normalized(other.body) === duplicate,
      ) ||
      h.participation
        .snapshot()
        .activities.some(
          (a) =>
            a.kind === "comment" &&
            a.draft &&
            normalized(a.draft) === duplicate,
        )
    )
      throw new AppError(
        "AUTOCARE_COMMENT_SKIP",
        "评论与已有正文重复，不跨目标或跨账号复制评论",
      );
    job.checks = checked.checks;
    job.quote = checked.quote;
    job.status = "ready";
    job.message = "针对性评论已生成，规则检查通过，尚未提交";
    h.persist();
    check();
    const blocked = randomInteractionWait(h, accountId);
    if (blocked)
      throw new AppError(
        "AUTOCARE_COMMENT_BLOCKED",
        `${blocked}；已保存本次评论，不自动补发`,
      );
    const activity = h.participation.planAutocareRule(
      {
        accountId,
        candidateId: candidate.id,
        version: candidate.version,
        kind: "comment",
        planId: autocareRandomCommentScope,
        draft: job.body,
        reason:
          "按随机评论规则选取准确目标，AI基于完整正文生成针对性评论，固定规则核对后执行；未使用自主运营工具循环或本人逐项确认",
      },
      check,
    );
    ownActivityId = activity.id;
    job.activityId = activity.id;
    h.persist();
    h.log(
      "random_comment.selected",
      `评论已保存，准备对《${candidate.title}》执行；${activity.id}；${job.id}`,
      accountId,
    );
    const executed = await h.participation.executeInteraction(
      {
        id: activity.id,
        version: activity.version,
        decision: {
          source: "rule",
          rule: "autocare_random_comment",
          relevance: null,
          basis:
            "用户已开启随机评论规则；程序随机选择准确目标，AI依据完整正文生成评论，已逐字核对原文依据并完成长度、推广、重复及套话检查；不是AI自主决定或本人逐项确认。",
          quote: job.quote,
        },
      },
      {
        planId: autocareRandomCommentScope,
        planRevision: job.revision,
        rulesAuthorized: true,
        autocareRun: autocareInteractionRunContext(h),
        dailyLimit: h.state.config.interactionDailyLimit,
        gapMinutes: autocareRunGapMinutes,
        excludedUids: [],
        guard: check,
      },
    );
    job.status =
      executed.status === "succeeded"
        ? "completed"
        : executed.status === "attention"
          ? "attention"
          : "skipped";
    job.message =
      executed.attempts?.at(-1)?.receipt?.summary ||
      executed.attempts?.at(-1)?.error ||
      "原评论执行记录已保留";
    recordRandomInteractionResult(h, executed);
  } catch (error) {
    if (h.closed()) return;
    const uncertain = !!h.db.get(
      "SELECT id FROM api_calls WHERE phase=? AND endpoint='openrouter' AND status IN ('reserved','uncertain') LIMIT 1",
      `zhihu_autocare:${job.id}`,
    );
    job.status = uncertain
      ? "attention"
      : job.checks.length
        ? "cancelled"
        : "skipped";
    job.message = `${safeMessage(error)}${job.body ? "；已保留生成正文，不自动重试" : ""}`;
    h.log(
      "random_comment.skipped",
      `${job.message}；${job.id}`,
      accountId,
      "warning",
    );
    h.status(accountId, job.message, uncertain);
  } finally {
    if (!h.closed()) {
      job.updatedAt = now();
      h.persist();
    }
  }
}

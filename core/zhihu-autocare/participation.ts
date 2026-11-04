import { randomInt } from "node:crypto";
import { id, now, type Database } from "../database";
import { AppError, safeMessage } from "../errors";
import type { ZhihuParticipation } from "../zhihu-participation/service";
import type { ZhihuOperations } from "../zhihu/service";
import type { AiService } from "../ai";
import { zhihuDay } from "../zhihu/policy";
import {
  autocareParticipationScope,
  type AutocareJob,
  type AutocareState,
} from "../../shared/zhihu-autocare";
import type { ZhihuParticipationCandidate } from "../../shared/zhihu-participation";
import { contentFingerprint, fingerprint } from "./state";
import { generateAutocareAnswer, checkAutocareAnswer } from "./generation";

export interface AutocareParticipationHost {
  db: Database;
  state: AutocareState;
  participation: ZhihuParticipation;
  zhihu: ZhihuOperations;
  ai: AiService;
  guard(): void;
  closed(): boolean;
  persist(): void;
  log(
    event: string,
    message: string,
    accountId: string,
    level?: "info" | "warning",
    job?: AutocareJob,
  ): void;
}
function fail(message: string): never {
  throw new AppError("AUTOCARE_RESEARCH_BLOCKED", message);
}
export const hasAutocareResearch = (s: AutocareState) =>
  s.config.readRecommended ||
  s.config.likeCandidates ||
  s.config.followCandidates;
export const enabledAutocareJob = (s: AutocareState, j: AutocareJob) =>
  j.kind === "answer" ? s.config.answerRecommended : s.config.publish;
const readsToday = (h: AutocareParticipationHost, accountId: string) =>
  h.state.research.filter(
    (r) => r.accountId === accountId && zhihuDay(r.at) === zhihuDay(Date.now()),
  );
function withinWindow(s: AutocareState) {
  const day = zhihuDay(Date.now());
  return (
    Date.now() >= Date.parse(`${day}T${s.config.windowStart}:00+08:00`) &&
    Date.now() < Date.parse(`${day}T${s.config.windowEnd}:00+08:00`)
  );
}
function recordResearchStop(
  h: AutocareParticipationHost,
  accountId: string,
  error: unknown,
) {
  const message = safeMessage(error);
  if (
    /验证码|安全验证|实名|协议|限制|频繁|身份|登录|captcha|rate.?limit/i.test(
      message,
    )
  ) {
    h.state.researchStops[accountId] = message;
    h.persist();
  }
}
async function inspect(
  h: AutocareParticipationHost,
  c: ZhihuParticipationCandidate,
) {
  h.guard();
  if (readsToday(h, c.accountId).length >= h.state.config.researchPerDay)
    fail("已到今日上下文读取上限，等待明日");
  if (h.state.research.length >= 2000)
    fail("上下文读取历史已达2000条，请整理历史后继续");
  const record: AutocareState["research"][number] = {
    id: id("care_read"),
    accountId: c.accountId,
    uid: h.state.identities[c.accountId],
    candidateId: c.id,
    at: now(),
    status: "reading",
    message: "正在读取官方完整上下文",
  };
  h.state.research.push(record);
  h.persist();
  try {
    const result = await h.participation.inspect(
      { accountId: c.accountId, candidateId: c.id, version: c.version },
      h.guard,
    );
    h.guard();
    if (!result.document || result.document.truncated)
      fail("正文未完整读取，未准备回答或互动");
    record.status = "saved";
    record.message = `已保存《${result.title}》的完整上下文；不计为本人阅读回执`;
    h.log("research.saved", record.message, c.accountId);
    h.persist();
    return result;
  } catch (error) {
    record.status = "failed";
    recordResearchStop(h, c.accountId, error);
    record.message = safeMessage(error);
    h.log("research.failed", record.message, c.accountId, "warning");
    h.persist();
    throw error;
  }
}
async function recommended(h: AutocareParticipationHost, accountId: string) {
  h.guard();
  const sameIdentity =
    h.state.recommendationUids[accountId] === h.state.identities[accountId];
  const next = h.state.nextRecommendationAt[accountId];
  if (
    next &&
    Date.parse(next) > Date.now() &&
    h.state.recommendationAttemptUids[accountId] ===
      h.state.identities[accountId]
  ) {
    if (!sameIdentity) fail("上次官方推荐读取未完成，等待冷却后重新检查");
    return h.participation
      .snapshot()
      .candidates.filter((c) => c.accountId === accountId && c.recommendation);
  }
  h.state.nextRecommendationAt[accountId] = new Date(
    Date.now() + 6 * 3600000,
  ).toISOString();
  h.state.recommendationAttemptUids[accountId] = h.state.identities[accountId];
  h.persist();
  const prior = h.participation
    .snapshot()
    .candidates.filter((c) => c.accountId === accountId && c.recommendation);
  let result: ZhihuParticipationCandidate[];
  try {
    result = await h.participation.discover(
      {
        accountId,
        kind: "question",
        source: "creator_recommend",
        query: "",
        refresh: !sameIdentity,
      },
      h.guard,
    );
  } catch (error) {
    if (h.closed()) throw error;
    h.state.nextRecommendationAt[accountId] = new Date(
      Date.now() + 20 * 60000,
    ).toISOString();
    recordResearchStop(h, accountId, error);
    h.persist();
    throw error;
  }
  h.guard();
  h.state.recommendationUids[accountId] = h.state.identities[accountId];
  h.persist();
  if (
    JSON.stringify(prior.map((c) => [c.id, c.recommendation?.observedAt])) !==
    JSON.stringify(result.map((c) => [c.id, c.recommendation?.observedAt]))
  )
    h.log(
      "research.recommended",
      `官方推荐保留${result.length}个浏览量大于1万的问题，未执行互动`,
      accountId,
    );
  return result;
}
/** Bounded reading for content research. Never opens self-owned articles to boost views. */
export async function readNextAutocareContext(
  h: AutocareParticipationHost,
  accountId: string,
) {
  if (
    !hasAutocareResearch(h.state) ||
    !withinWindow(h.state) ||
    readsToday(h, accountId).length >= h.state.config.researchPerDay
  )
    return false;
  const next = h.state.nextResearchAt[accountId];
  if (next && Date.parse(next) > Date.now()) return false;
  h.state.nextResearchAt[accountId] = new Date(
    Date.now() + randomInt(20, 61) * 60000,
  ).toISOString();
  h.persist();
  const before = h.participation.snapshot();
  const seen = new Set(readsToday(h, accountId).map((r) => r.candidateId));
  const available = () =>
    h.participation
      .snapshot()
      .candidates.filter((c) => c.accountId === accountId && !seen.has(c.id));
  const choose = () => {
    const all = available();
    const follow = h.state.config.followCandidates
      ? all.find(
          (c) =>
            c.kind === "author" &&
            !before.activities.some(
              (a) =>
                a.accountId === accountId &&
                a.candidateId === c.id &&
                a.kind === "follow",
            ),
        )
      : undefined;
    const hasLike = before.activities.some(
      (a) =>
        a.accountId === accountId &&
        a.planId === autocareParticipationScope &&
        a.kind === "like",
    );
    if (
      follow &&
      hasLike &&
      !before.activities.some(
        (a) =>
          a.accountId === accountId &&
          a.planId === autocareParticipationScope &&
          a.kind === "follow" &&
          !a.resolution,
      )
    )
      return follow;
    return (
      (h.state.config.likeCandidates
        ? all.find(
            (c) =>
              ["answer", "article"].includes(c.kind) &&
              !before.activities.some(
                (a) =>
                  a.accountId === accountId &&
                  a.candidateId === c.id &&
                  a.kind === "like",
              ),
          )
        : undefined) ??
      (h.state.config.followCandidates
        ? all.find(
            (c) =>
              c.kind === "author" &&
              !before.activities.some(
                (a) =>
                  a.accountId === accountId &&
                  a.candidateId === c.id &&
                  a.kind === "follow",
              ),
          )
        : undefined) ??
      all.find(
        (c) =>
          c.kind === "question" &&
          c.recommendation &&
          c.recommendation.views > 10000,
      )
    );
  };
  let candidate = choose();
  if (!candidate) {
    await recommended(h, accountId);
    candidate = choose();
  }
  if (!candidate) {
    h.log("research.empty", "暂无新的推荐上下文，等待下次发现", accountId);
    return false;
  }
  const current = await inspect(h, candidate);
  const text = current.document!.text;
  if (/互关|互粉|互赞|关注必回|有粉必回|回关/.test(text)) {
    h.log(
      "research.skipped",
      "该内容包含交换关注或回赞条件，未准备互动",
      accountId,
      "warning",
    );
    return true;
  }
  if (current.kind === "author" && /未展示公开简介/.test(text)) {
    h.log(
      "research.skipped",
      "作者缺少可判断的公开介绍，未准备关注待办",
      accountId,
    );
    return true;
  }
  const kind =
    ["answer", "article"].includes(current.kind) &&
    h.state.config.likeCandidates
      ? "like"
      : current.kind === "author" && h.state.config.followCandidates
        ? "follow"
        : null;
  if (
    kind &&
    text.length >= 8 &&
    !h.participation
      .snapshot()
      .activities.some(
        (a) =>
          a.accountId === accountId &&
          a.candidateId === current.id &&
          a.kind === kind,
      )
  ) {
    const activity = h.participation.plan(
      {
        accountId,
        candidateId: current.id,
        version: current.version,
        kind,
        planId: autocareParticipationScope,
        reason: "已取得具体目标和完整上下文，留待本人选择是否赞同或关注",
      },
      h.guard,
    );
    h.log(
      "interaction.prepared",
      `已准备${kind === "like" ? "点赞" : "关注"}待办《${current.title}》，等待本人确认；${activity.id}`,
      accountId,
    );
  }
  return true;
}
export async function prepareAutocareAnswer(
  h: AutocareParticipationHost,
  accountId: string,
): Promise<AutocareJob | null> {
  if (!withinWindow(h.state)) {
    h.log("answer.waiting", "回答准备等待运营时段", accountId);
    return null;
  }
  const used = (c: ZhihuParticipationCandidate) =>
    h.state.jobs.some((j) => j.questionUrl === c.url) ||
    h.zhihu
      .snapshot()
      .contents.some(
        (a) =>
          a.kind === "answer" &&
          a.questionUrl === c.url &&
          a.accountId === accountId,
      );
  const choose = () =>
    h.participation
      .snapshot()
      .candidates.find(
        (c) =>
          c.accountId === accountId &&
          c.kind === "question" &&
          c.recommendation &&
          c.recommendation.views > 10000 &&
          Date.parse(c.recommendation.observedAt) >= Date.now() - 86400000 &&
          !used(c),
      );
  let candidate =
    h.state.recommendationUids[accountId] === h.state.identities[accountId]
      ? choose()
      : undefined;
  if (!candidate) {
    await recommended(h, accountId);
    candidate = choose();
  }
  if (!candidate) {
    h.log("answer.empty", "没有未回答且浏览量大于1万的推荐问题", accountId);
    return null;
  }
  if (h.state.jobs.length >= 5000) fail("运行历史已到5000项，请整理后继续");
  const alreadyRead = h.state.research.find(
    (r) =>
      r.accountId === accountId &&
      r.candidateId === candidate!.id &&
      r.status === "saved" &&
      zhihuDay(r.at) === zhihuDay(Date.now()),
  );
  if (
    (!alreadyRead || !candidate.document || candidate.document.truncated) &&
    readsToday(h, accountId).length >= h.state.config.researchPerDay
  )
    return null;
  // An unsuitable question must not be read repeatedly every minute.
  const job: AutocareJob = {
    id: id("autocare"),
    accountId,
    uid: h.state.identities[accountId],
    kind: "answer",
    candidateId: candidate.id,
    questionUrl: candidate.url,
    sourceId: `question:${candidate.url}`,
    sourceHash: "",
    status: "collecting",
    message: "读取推荐问题上下文",
    createdAt: now(),
    updatedAt: now(),
    model: h.state.model,
    templateVersion: 1,
    checks: [],
  };
  h.state.jobs.push(job);
  h.persist();
  try {
    const read = h.state.research.find(
      (r) =>
        r.accountId === accountId &&
        r.candidateId === candidate!.id &&
        r.status === "saved" &&
        zhihuDay(r.at) === zhihuDay(Date.now()),
    );
    if (!read || !candidate.document || candidate.document.truncated)
      candidate = await inspect(h, candidate);
    h.guard();
    if (
      !candidate.document ||
      candidate.document.truncated ||
      candidate.document.kind !== "question"
    )
      fail("问题上下文不完整，已跳过");
    const document = candidate.document;
    job.sourceHash = fingerprint(document);
    const activity = h.participation.plan(
      {
        accountId,
        candidateId: candidate.id,
        version: candidate.version,
        kind: "answer",
        planId: autocareParticipationScope,
        reason:
          "根据官方推荐问题的完整上下文准备针对性回答，文章和回答共享发布额度",
      },
      h.guard,
    );
    h.ai.assertTextConfigured("copy");
    h.guard();
    job.status = "generating";
    job.generatedAt = now();
    job.message = "正在生成推荐问题回答";
    h.persist();
    h.log("answer.generating", job.message, accountId, "info", job);
    const result = await generateAutocareAnswer(
      h.ai,
      job.id,
      document,
      h.guard,
    );
    if (h.closed()) return null;
    const checks = checkAutocareAnswer(result, document);
    if (
      h.zhihu
        .snapshot()
        .contents.some(
          (c) => c.body.replace(/\s/g, "") === result.body.replace(/\s/g, ""),
        )
    )
      fail("回答正文与已有稿件重复");
    // Preserve a received paid result when the switch changes in flight. The
    // local draft write checks identity; publication still requires a fresh guard.
    h.participation.answer(
      {
        id: activity.id,
        version: activity.version,
        title: result.title,
        body: result.body,
        basis: `依据问题原文：${result.evidence.join("\n")}`,
        confirmed: true,
      },
      () => {
        if (
          h.closed() ||
          h.zhihu.snapshot().accounts.find((a) => a.id === accountId)?.uid !==
            job.uid
        )
          fail("原账号身份已变化，未改派已生成回答");
      },
      (content) => {
        job.contentId = content.id;
        job.fingerprint = contentFingerprint(content);
        job.checks = checks;
        job.status = "ready";
        job.message = "推荐问题回答检查通过，等待随机排期";
        job.updatedAt = now();
        h.persist();
      },
    );
    h.log("answer.ready", job.message, accountId, "info", job);
    return job;
  } catch (error) {
    if (h.closed()) return null;
    const uncertain = !!h.db.get(
      "SELECT id FROM api_calls WHERE phase=? AND endpoint='openrouter' AND status IN ('reserved','uncertain') LIMIT 1",
      `zhihu_autocare:${job.id}`,
    );
    job.status = uncertain ? "attention" : "skipped";
    job.message = safeMessage(error);
    job.updatedAt = now();
    h.persist();
    h.log("answer.skipped", job.message, accountId, "warning", job);
    h.guard();
    if (h.state.researchStops[accountId]) throw error;
    return null;
  }
}

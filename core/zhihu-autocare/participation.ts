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
import {
  autocareGenerationCount,
  contentFingerprint,
  fingerprint,
} from "./state";
import { generateAutocareAnswer, checkAutocareAnswer } from "./generation";
import {
  autocareAccountDomain,
  autocareDomainQuery,
  matchesAutocareDomain,
} from "./domain";
import { executeAutocareRandomLike } from "./random-likes";
import { executeAutocareRandomComment } from "./random-comments";
import { executeAutocareRandomFollow } from "./random-follows";
import { autocareRunWindow, withinAutocareRun } from "./run-window";
import {
  randomInteractionGuard,
  randomInteractionAvailability,
  nextRandomInteractionAt,
} from "./random-interactions";
import {
  autocareRandomInteractionOptions,
  hasCompleteAutocareRandomContext,
  hasAutocareExchangeRequest,
  type AutocareRandomInteractionOption,
} from "./random-candidates";

export interface AutocareParticipationHost {
  db: Database;
  state: AutocareState;
  participation: ZhihuParticipation;
  zhihu: ZhihuOperations;
  ai: AiService;
  guard(): void;
  closed(): boolean;
  persist(): void;
  status(accountId: string, message: string, blocked?: boolean): void;
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
export const hasAutocareRandomInteractions = (s: AutocareState) =>
  s.config.randomLikes ||
  s.config.likeCandidates ||
  s.config.randomComments ||
  s.config.followCandidates;
export const hasAutocareResearch = (s: AutocareState) =>
  hasAutocareRandomInteractions(s) ||
  s.config.readRecommended ||
  s.config.likeCandidates ||
  s.config.followCandidates;
export const enabledAutocareJob = (s: AutocareState, j: AutocareJob) =>
  j.kind === "answer" ? s.config.answerRecommended : s.config.publish;
const readsToday = (h: AutocareParticipationHost, accountId: string) =>
  h.state.research.filter(
    (r) => r.accountId === accountId && zhihuDay(r.at) === zhihuDay(Date.now()),
  );
const readsInRun = (h: AutocareParticipationHost, accountId: string) => {
  const window = autocareRunWindow(h.state);
  return window
    ? h.state.research.filter(
        (read) =>
          read.accountId === accountId &&
          Date.parse(read.at) >= window.start &&
          Date.parse(read.at) < window.end,
      )
    : [];
};
const readsForSelection = (h: AutocareParticipationHost, accountId: string) => [
  ...new Map(
    [...readsToday(h, accountId), ...readsInRun(h, accountId)].map((read) => [
      read.id,
      read,
    ]),
  ).values(),
];
const readUsage = (h: AutocareParticipationHost, accountId: string) =>
  Math.max(readsToday(h, accountId).length, readsInRun(h, accountId).length);
function runWindowMessage(s: AutocareState, action: string) {
  const window = autocareRunWindow(s);
  if (!window) return `尚未启动两小时批次，未执行${action}`;
  return Date.now() < window.start
    ? `本批次尚未开始，${action}等待批次开始时间`
    : `本批次两小时已结束，${action}未完成；不会排到下一日`;
}
function guardAutocareRun(h: AutocareParticipationHost) {
  h.guard();
  if (!withinAutocareRun(h.state)) fail(runWindowMessage(h.state, "后续操作"));
}
function nextResearchReadAt(h: AutocareParticipationHost) {
  const window = autocareRunWindow(h.state);
  return new Date(
    Math.min(Date.now() + randomInt(1, 4) * 60000, window?.end ?? Date.now()),
  ).toISOString();
}
/** Keep the existing read allowance useful for the selected actions. A saved
 * question is not a complete answer/author target for a real interaction. */
function interactionResearchNeeds(
  h: AutocareParticipationHost,
  accountId: string,
) {
  if (
    !hasAutocareRandomInteractions(h.state) ||
    randomInteractionAvailability(h, accountId)?.status === "exhausted"
  )
    return {
      reserve: 0,
      content: false,
      author: false,
      options: [] as AutocareRandomInteractionOption[],
    };
  const commentsAllowed =
    autocareGenerationCount(h.state) < h.state.config.generationsPerDay;
  const options = autocareRandomInteractionOptions(
    h.state,
    h.participation.snapshot(),
    h.zhihu.snapshot().accounts,
    accountId,
    commentsAllowed,
  );
  const content =
    !!(
      h.state.config.randomLikes ||
      h.state.config.likeCandidates ||
      (h.state.config.randomComments && commentsAllowed)
    ) &&
    !options.some(
      (option) =>
        option.kind !== "follow" &&
        hasCompleteAutocareRandomContext(option.candidate),
    );
  const author =
    h.state.config.followCandidates &&
    !options.some(
      (option) =>
        option.kind === "follow" &&
        hasCompleteAutocareRandomContext(option.candidate) &&
        !/未展示公开简介/.test(option.candidate.document!.text),
    );
  return {
    reserve: Number(content) + Number(author),
    content,
    author,
    options,
  };
}
function recordResearchStop(
  h: AutocareParticipationHost,
  accountId: string,
  error: unknown,
) {
  const message = safeMessage(error);
  const verification =
    /验证码|安全验证|实名|人机验证|captcha|verification|challenge/i.test(
      message,
    );
  const authentication =
    !verification &&
    /身份|登录|login|sign.?in|authentication|unauthorized|identity/i.test(
      message,
    );
  if (
    verification ||
    authentication ||
    /协议|限制|频繁|rate.?limit|forbidden/i.test(message)
  ) {
    h.state.researchStops[accountId] = message;
    (h.state.researchStopDetails ??= {})[accountId] = {
      kind: verification
        ? "verification"
        : authentication
          ? "authentication"
          : "other",
      uid: h.state.identities[accountId] ?? "",
      at: now(),
    };
    h.persist();
  }
}
async function inspect(
  h: AutocareParticipationHost,
  c: ZhihuParticipationCandidate,
) {
  guardAutocareRun(h);
  if (readUsage(h, c.accountId) >= h.state.config.researchPerDay)
    fail(
      "已用满今日或本批次正文读取上限，本批次不再新增读取；未完成内容不会排到下一日",
    );
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
      () => guardAutocareRun(h),
    );
    guardAutocareRun(h);
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
  guardAutocareRun(h);
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
    Math.min(Date.now() + 10 * 60000, autocareRunWindow(h.state)!.end),
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
      () => guardAutocareRun(h),
    );
  } catch (error) {
    if (h.closed()) throw error;
    h.state.nextRecommendationAt[accountId] = new Date(
      Math.min(
        Date.now() + 3 * 60000,
        autocareRunWindow(h.state)?.end ?? Date.now(),
      ),
    ).toISOString();
    recordResearchStop(h, accountId, error);
    h.persist();
    throw error;
  }
  guardAutocareRun(h);
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
  if (!h.state.config.readRecommended) return false;
  if (!withinAutocareRun(h.state)) {
    const message = runWindowMessage(h.state, "正文读取");
    h.log("research.waiting", message, accountId);
    h.status(accountId, message);
    return false;
  }
  if (readUsage(h, accountId) >= h.state.config.researchPerDay) {
    const message =
      "已用满今日或本批次正文读取上限，本批次不再新增读取；已保存的完整目标仍可用于自动互动";
    h.log("research.exhausted", message, accountId);
    h.status(accountId, message);
    return false;
  }
  guardAutocareRun(h);
  const seen = new Set(
    readsForSelection(h, accountId).map((r) => r.candidateId),
  );
  const needs = interactionResearchNeeds(h, accountId);
  const usefulRead =
    needs.options.find(
      (option) =>
        !seen.has(option.candidate.id) &&
        !hasCompleteAutocareRandomContext(option.candidate) &&
        needs.author &&
        option.kind === "follow",
    ) ??
    needs.options.find(
      (option) =>
        !seen.has(option.candidate.id) &&
        !hasCompleteAutocareRandomContext(option.candidate) &&
        needs.content &&
        option.kind !== "follow",
    );
  if (
    !usefulRead &&
    h.state.config.researchPerDay - readUsage(h, accountId) <= needs.reserve
  ) {
    const message = `剩余读取次数为自动互动保留：${[...(needs.content ? ["回答/文章正文"] : []), ...(needs.author ? ["作者公开资料"] : [])].join("、")}；普通推荐阅读暂让位，不增加读取上限`;
    h.log("research.reserved", message, accountId);
    h.status(accountId, message);
    return false;
  }
  const next = h.state.nextResearchAt[accountId];
  if (next && Date.parse(next) > Date.now()) {
    const deadline = autocareRunWindow(h.state)!.end;
    const message =
      Date.parse(next) >= deadline
        ? "本批次截止前没有新的正文读取时段，未完成读取不会排到下一日"
        : `等待本批次下次正文读取时间：${new Date(next).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`;
    h.log("research.waiting", message, accountId);
    h.status(accountId, message);
    return false;
  }
  h.state.nextResearchAt[accountId] = nextResearchReadAt(h);
  h.persist();
  const domain = autocareAccountDomain(h.state.config, accountId);
  const available = () =>
    h.participation
      .snapshot()
      .candidates.filter(
        (c) =>
          c.accountId === accountId &&
          !seen.has(c.id) &&
          matchesAutocareDomain(
            c.document && !c.document.truncated
              ? `${c.document.title}\n${c.document.text}`
              : `${c.title}\n${c.excerpt}`,
            domain,
          ),
      );
  const choose = () =>
    usefulRead?.candidate ??
    available().find(
      (c) =>
        c.kind === "question" &&
        c.recommendation &&
        c.recommendation.views > 10000,
    );
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
  if (!matchesAutocareDomain(`${current.document!.title}\n${text}`, domain)) {
    h.log(
      "research.skipped",
      "准确目标全文未匹配本账号领域，本次只保留研究记录",
      accountId,
    );
    return true;
  }
  if (hasAutocareExchangeRequest(text)) {
    h.log(
      "research.skipped",
      "该内容包含交换关注或回赞条件，本次只保留研究记录",
      accountId,
      "warning",
    );
    return true;
  }
  return true;
}

/** One independent interaction cycle. Cached full text does not spend a new
 * research read; the submission adapter still reloads and verifies that text. */
export type AutocareInteractionCycleResult =
  | { status: "completed" }
  | { status: "waiting"; message: string; nextAt: string }
  | { status: "blocked"; message: string };

export async function runNextAutocareRandomInteraction(
  h: AutocareParticipationHost,
  accountId: string,
  onStarting?: () => void,
): Promise<AutocareInteractionCycleResult> {
  h.guard();
  if (!hasAutocareRandomInteractions(h.state)) return { status: "completed" };
  const domain = autocareAccountDomain(h.state.config, accountId);
  const report = (
    message: string,
    event = "waiting",
    nextAt: string | null = null,
  ): AutocareInteractionCycleResult => {
    h.log(`random_interaction.${event}`, message, accountId);
    h.status(accountId, message, event === "waiting" && !nextAt);
    return event !== "waiting"
      ? { status: "completed" }
      : nextAt
        ? { status: "waiting", message, nextAt }
        : { status: "blocked", message };
  };
  const defer = (message: string, after: number | null) => {
    const window = autocareRunWindow(h.state);
    const nextAt =
      after === null || !window || after >= window.end
        ? null
        : nextRandomInteractionAt(h, accountId, Math.max(window.start, after));
    const withinDeadline =
      nextAt && window && Date.parse(nextAt) < window.end ? nextAt : null;
    return report(
      `${message}${after !== null && !withinDeadline ? "；本批次截止前没有可用时段，未完成内容不会排到下一日" : ""}`,
      "waiting",
      withinDeadline,
    );
  };
  if (!withinAutocareRun(h.state)) {
    const window = autocareRunWindow(h.state);
    return defer(
      runWindowMessage(h.state, "随机互动"),
      window && Date.now() < window.start ? window.start : null,
    );
  }
  const guard = randomInteractionGuard(
    h,
    accountId,
    h.state.config.randomLikes || h.state.config.likeCandidates
      ? "like"
      : h.state.config.randomComments
        ? "comment"
        : "follow",
  );
  guard();
  const wait = randomInteractionAvailability(h, accountId);
  if (wait) {
    if (wait.status === "exhausted")
      return report(
        `${wait.message}；本批次互动不再尝试，其他已开启任务继续`,
        "exhausted",
      );
    const window = autocareRunWindow(h.state);
    const nextAt =
      wait.nextAt && window && Date.parse(wait.nextAt) < window.end
        ? wait.nextAt
        : null;
    return report(
      `${wait.message}${wait.nextAt && !nextAt ? "；本批次截止前没有可用时段，不排到下一日" : ""}`,
      "waiting",
      nextAt,
    );
  }
  const commentsAllowed =
    autocareGenerationCount(h.state) < h.state.config.generationsPerDay;
  if (
    !h.state.config.randomLikes &&
    !h.state.config.likeCandidates &&
    !h.state.config.followCandidates &&
    !commentsAllowed
  )
    return report(
      "已用满今日共享AI生成次数上限，本批次不再生成随机评论；未完成内容不会排到下一日",
      "exhausted",
    );

  const seen = new Set(
      readsForSelection(h, accountId).map((read) => read.candidateId),
    ),
    nextReadAt = h.state.nextResearchAt[accountId];
  const readWait =
    readUsage(h, accountId) >= h.state.config.researchPerDay
      ? {
          message:
            "已用满今日或本批次正文读取上限，暂无可复用的完整互动目标；本批次未完成内容不会排到下一日",
          after: null,
          exhausted: true,
        }
      : h.state.research.length >= 2000
        ? {
            message:
              "正文读取历史已达2000条，请整理后继续；已有完整目标仍可执行",
            after: null,
          }
        : nextReadAt && Date.parse(nextReadAt) > Date.now()
          ? {
              message: `等待下次正文读取时间：${new Date(nextReadAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}；未额外读取`,
              after: Date.parse(nextReadAt),
            }
          : null;
  const snapshot = h.participation.snapshot(),
    options = autocareRandomInteractionOptions(
      h.state,
      snapshot,
      h.zhihu.snapshot().accounts,
      accountId,
      commentsAllowed,
    ).filter(
      ({ candidate, kind }) =>
        (hasCompleteAutocareRandomContext(candidate) ||
          (!readWait && !seen.has(candidate.id))) &&
        !(
          kind === "follow" &&
          hasCompleteAutocareRandomContext(candidate) &&
          /未展示公开简介/.test(candidate.document!.text)
        ),
    );
  const guardedHost: AutocareParticipationHost = { ...h, guard };
  let started = false;
  const start = () => {
    guard();
    if (started) return;
    onStarting?.();
    started = true;
  };
  const reserveRead = () => {
    start();
    h.state.nextResearchAt[accountId] = nextResearchReadAt(h);
    h.persist();
  };
  const followChecked = () => {
    const saved = h.state.interactionDiscovery?.[accountId];
    return saved?.runId === h.state.run!.id && saved.followChecked;
  };
  const markFollowChecked = () => {
    guard();
    if (followChecked()) return;
    (h.state.interactionDiscovery ??= {})[accountId] = {
      runId: h.state.run!.id,
      followChecked: true,
    };
    h.persist();
  };
  const runWindow = autocareRunWindow(h.state)!;
  const actorUid = h.state.identities[accountId];
  const hasFollowAttempt = snapshot.activities.some((activity) =>
    activity.attempts?.some((attempt) => {
      const at = Date.parse(attempt.submittedAt ?? attempt.startedAt);
      return (
        attempt.request.kind === "follow" &&
        (activity.accountId === accountId ||
          attempt.request.actorUid === actorUid) &&
        at >= runWindow.start &&
        at < runWindow.end
      );
    }),
  );
  const fullAuthorAvailable = options.some(
    (option) =>
      option.kind === "follow" &&
      hasCompleteAutocareRandomContext(option.candidate),
  );
  if (
    h.state.config.followCandidates &&
    !hasFollowAttempt &&
    !fullAuthorAvailable &&
    !followChecked() &&
    !readWait
  ) {
    const prepared = await discoverAuthorContext();
    if (prepared) return prepared;
  }
  if (options.length) {
    // Balance action kinds before randomizing targets. Ten answers must not
    // outweigh one author, and a context read is not a remote attempt.
    const window = autocareRunWindow(h.state)!;
    const uid = h.state.identities[accountId];
    const kinds = [...new Set(options.map((option) => option.kind))];
    const ranks = new Map(
      kinds.map((kind) => [kind, { attempts: 0, latest: 0 }]),
    );
    for (const activity of snapshot.activities) {
      for (const attempt of activity.attempts ?? []) {
        if (
          activity.accountId !== accountId &&
          attempt.request.actorUid !== uid
        )
          continue;
        const stamp = Date.parse(attempt.submittedAt ?? attempt.startedAt);
        if (stamp < window.start || stamp >= window.end) continue;
        const rank = ranks.get(attempt.request.kind);
        if (rank) {
          rank.attempts++;
          rank.latest = Math.max(rank.latest, stamp);
        }
      }
    }
    // A skipped paid generation is not a platform attempt. Use it only to break
    // ties so repeated unsuitable comments cannot starve another untried kind.
    const comments = ranks.get("comment");
    if (comments)
      for (const job of h.state.commentJobs) {
        const stamp = Date.parse(job.createdAt);
        if (job.uid === uid && stamp >= window.start && stamp < window.end)
          comments.latest = Math.max(comments.latest, stamp);
      }
    kinds.sort(
      (a, b) =>
        ranks.get(a)!.attempts - ranks.get(b)!.attempts ||
        ranks.get(a)!.latest - ranks.get(b)!.latest,
    );
    const kind = kinds[0];
    const kindOptions = options.filter((option) => option.kind === kind);
    const pendingOptions = kindOptions.filter((option) =>
      snapshot.activities.some(
        (activity) =>
          activity.planId === autocareParticipationScope &&
          activity.accountId === accountId &&
          activity.candidateId === option.candidate.id &&
          activity.kind === option.kind &&
          ["planned", "needs_review", "prepared"].includes(activity.status) &&
          !activity.attempts?.length &&
          !activity.resolution &&
          !activity.automation &&
          !activity.contentId,
      ),
    );
    const pool: AutocareRandomInteractionOption[] = pendingOptions.length
      ? pendingOptions
      : kindOptions;
    const selected = pool[randomInt(pool.length)];
    if (selected.kind === "follow") markFollowChecked();
    h.log(
      "random_interaction.kind_selected",
      `本批次优先${kind === "like" ? "点赞" : kind === "comment" ? "评论" : "关注"}：已有${ranks.get(kind)!.attempts}次真实尝试，在同类准确目标中选择`,
      accountId,
    );
    let candidate = selected.candidate;
    if (!hasCompleteAutocareRandomContext(candidate)) {
      reserveRead();
      candidate = await inspect(guardedHost, candidate);
    } else
      h.log(
        "random_interaction.cached",
        `复用《${candidate.title}》已保存的完整正文，不新增研究读取；提交前仍会核对官方原文`,
        accountId,
      );
    guard();
    if (!hasCompleteAutocareRandomContext(candidate))
      return report("目标正文不完整或过短，本周期未执行互动", "skipped");
    if (
      !matchesAutocareDomain(
        `${candidate.document!.title}\n${candidate.document!.text}`,
        domain,
      )
    )
      return report(
        "准确目标全文未匹配本账号领域，本周期跳过，不跨领域互动",
        "skipped",
      );
    if (hasAutocareExchangeRequest(candidate.document!.text))
      return report("目标含交换关注或回赞条件，本周期未执行互动", "skipped");
    start();
    if (selected.kind === "comment")
      await executeAutocareRandomComment(h, candidate);
    else if (selected.kind === "follow")
      await executeAutocareRandomFollow(h, candidate);
    else await executeAutocareRandomLike(h, candidate);
    return { status: "completed" };
  }

  if (readWait)
    return "exhausted" in readWait
      ? report(readWait.message, "exhausted")
      : defer(readWait.message, readWait.after);
  async function discoverAuthorContext(): Promise<AutocareInteractionCycleResult | null> {
    markFollowChecked();
    start();
    const accountUids = new Map(
      h.zhihu.snapshot().accounts.map((account) => [account.id, account.uid]),
    );
    const uid = h.state.identities[accountId];
    const candidateById = new Map(
      snapshot.candidates.map((candidate) => [candidate.id, candidate]),
    );
    const usedAuthorUrls = new Set(
      snapshot.activities
        .filter(
          (activity) =>
            activity.kind === "follow" &&
            (activity.accountId === accountId ||
              accountUids.get(activity.accountId) === uid ||
              activity.attempts?.some(
                (attempt) => attempt.request.actorUid === uid,
              )) &&
            !(
              activity.planId === autocareParticipationScope &&
              !activity.attempts?.length &&
              !activity.resolution &&
              !activity.automation &&
              !activity.contentId
            ),
        )
        .flatMap((activity) => [
          candidateById.get(activity.candidateId)?.url,
          ...(activity.attempts ?? []).map((attempt) => attempt.request.url),
        ])
        .filter((url): url is string => !!url),
    );
    const sources = snapshot.candidates.filter(
      (candidate) =>
        candidate.accountId === accountId &&
        matchesAutocareDomain(
          hasCompleteAutocareRandomContext(candidate)
            ? `${candidate.document!.title}\n${candidate.document!.text}`
            : `${candidate.title}\n${candidate.excerpt}`,
          domain,
        ),
    );
    const relatedAuthorUrls = new Set(
      sources.flatMap((candidate) =>
        candidate.document && !candidate.document.truncated
          ? candidate.document.related
              .filter((related) => related.kind === "author")
              .map((related) => related.url)
          : [],
      ),
    );
    const eligibleAuthor = (candidate: ZhihuParticipationCandidate) =>
      candidate.accountId === accountId &&
      candidate.kind === "author" &&
      !seen.has(candidate.id) &&
      !usedAuthorUrls.has(candidate.url);
    let author = snapshot.candidates.find(
      (candidate) =>
        eligibleAuthor(candidate) && relatedAuthorUrls.has(candidate.url),
    );
    const query = domain
      ? autocareDomainQuery(domain)
      : sources
          .find(
            (candidate) =>
              candidate.kind !== "author" && candidate.author?.trim(),
          )
          ?.author?.trim()
          .slice(0, 200);
    if (!author && query) {
      start();
      try {
        const discovered = await h.participation.discover(
          {
            accountId,
            kind: "author",
            source: "search",
            query,
            refresh: false,
          },
          guard,
        );
        guard();
        author = discovered.find(eligibleAuthor);
      } catch (error) {
        recordResearchStop(h, accountId, error);
        throw error;
      }
    }
    if (author) {
      reserveRead();
      const inspected = await inspect(guardedHost, author);
      guard();
      if (
        !hasCompleteAutocareRandomContext(inspected) ||
        !matchesAutocareDomain(
          `${inspected.document!.title}\n${inspected.document!.text}`,
          domain,
        ) ||
        hasAutocareExchangeRequest(inspected.document!.text) ||
        /未展示公开简介/.test(inspected.document!.text)
      )
        return report(
          "作者公开资料不足、未匹配账号领域或含交换关注条件，本次未关注，也未创建待确认任务",
          "skipped",
        );
      return report(
        `已读取明确作者《${inspected.title}》的公开资料；本批次下个互动时段核对后自动关注，本次未提交关注`,
        "author_discovered",
      );
    }
    const message = query
      ? "本批次已查询作者，未发现新的明确目标；保留未完成原因，继续其他已开启操作"
      : "本批次暂无已读内容中的明确作者链接、公开姓名或领域关键词；不虚构作者，继续其他已开启操作";
    h.log("random_follow.discovery_empty", message, accountId);
    h.status(accountId, message);
    return null;
  }
  if (h.state.config.followCandidates && !followChecked()) {
    const prepared = await discoverAuthorContext();
    if (prepared) return prepared;
  }
  if (
    h.state.config.followCandidates &&
    !h.state.config.randomLikes &&
    !h.state.config.likeCandidates &&
    !h.state.config.randomComments
  )
    return report(
      "本批次作者发现机会已执行，暂无可核对的新关注目标；保留未完成原因，不重复查询或关注历史目标",
      "empty",
    );
  // Questions only discover answer targets. They use the ordinary new-read
  // budget, while a full answer already saved above can run at that budget's cap.
  const questions = () =>
    h.participation
      .snapshot()
      .candidates.filter(
        (candidate) =>
          candidate.accountId === accountId &&
          candidate.kind === "question" &&
          candidate.recommendation &&
          candidate.recommendation.views > 10000 &&
          matchesAutocareDomain(
            [candidate.title, candidate.excerpt, candidate.document?.text].join(
              "\n",
            ),
            domain,
          ) &&
          !seen.has(candidate.id),
      );
  let available = questions();
  if (!available.length) {
    start();
    await recommended(guardedHost, accountId);
    guard();
    available = questions();
  }
  if (!available.length)
    return report(
      domain
        ? "当前领域关键词未匹配可用回答或官方推荐问题，等待后续候选，不跨领域补量"
        : "暂无未处理的回答或文章，官方推荐中也没有本日未读取的问题；等待下次发现",
      "empty",
    );
  reserveRead();
  const question = await inspect(
    guardedHost,
    available[randomInt(available.length)],
  );
  guard();
  const added = h.participation
    .snapshot()
    .candidates.filter(
      (candidate) =>
        candidate.accountId === accountId &&
        candidate.kind === "answer" &&
        !snapshot.candidates.some((previous) => previous.id === candidate.id),
    ).length;
  return report(
    `已读取推荐问题《${question.title}》，新增${added}个回答候选；本批次下个互动时段继续，本次未点赞、评论或关注`,
    "discovered",
  );
}

export async function prepareAutocareAnswer(
  h: AutocareParticipationHost,
  accountId: string,
): Promise<AutocareJob | null> {
  const domain = autocareAccountDomain(h.state.config, accountId);
  if (!withinAutocareRun(h.state)) {
    const message = runWindowMessage(h.state, "回答准备");
    h.log("answer.waiting", message, accountId);
    h.status(accountId, message);
    return null;
  }
  guardAutocareRun(h);
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
          matchesAutocareDomain(
            [c.title, c.excerpt, c.document?.text].join("\n"),
            domain,
          ) &&
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
    h.log(
      "answer.empty",
      domain
        ? `官方推荐中没有匹配领域关键词“${domain}”、未回答且浏览量大于1万的问题，等待后续推荐；不跨领域补量`
        : "没有未回答且浏览量大于1万的推荐问题",
      accountId,
    );
    return null;
  }
  if (h.state.jobs.length >= 5000) fail("运行历史已到5000项，请整理后继续");
  const alreadyRead = readsForSelection(h, accountId).find(
    (r) =>
      r.accountId === accountId &&
      r.candidateId === candidate!.id &&
      r.status === "saved",
  );
  const reusableContext =
    hasCompleteAutocareRandomContext(candidate) &&
    (!!alreadyRead ||
      Date.parse(candidate.document!.observedAt) >= Date.now() - 86400000);
  if (
    !reusableContext &&
    readUsage(h, accountId) >= h.state.config.researchPerDay
  ) {
    const message =
      "已用满今日或本批次正文读取上限，尚未读取的问题本批次不再生成回答；不会排到下一日";
    h.log("answer.exhausted", message, accountId);
    h.status(accountId, message);
    return null;
  }
  if (!reusableContext) {
    const needs = interactionResearchNeeds(h, accountId);
    if (
      h.state.config.researchPerDay - readUsage(h, accountId) <=
      needs.reserve
    ) {
      const message =
        "剩余正文读取次数为尚缺的自动互动内容与作者资料保留，本批次暂不新读回答问题；现成全文仍可复用";
      h.log("answer.reads_reserved", message, accountId);
      h.status(accountId, message);
      return null;
    }
  }
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
    if (!reusableContext) candidate = await inspect(h, candidate);
    else
      h.log(
        "answer.context_reused",
        `复用《${candidate.title}》已保存的完整问题上下文，不新增读取次数或本人阅读记录`,
        accountId,
      );
    guardAutocareRun(h);
    if (
      !candidate.document ||
      candidate.document.truncated ||
      candidate.document.kind !== "question"
    )
      fail("问题上下文不完整，已跳过");
    const document = candidate.document;
    if (!matchesAutocareDomain(`${document.title}\n${document.text}`, domain))
      fail(`完整问题未匹配账号领域关键词“${domain}”，未调用AI生成`);
    job.sourceHash = fingerprint(document);
    const activity = h.participation.plan(
      {
        accountId,
        candidateId: candidate.id,
        version: candidate.version,
        kind: "answer",
        planId: autocareParticipationScope,
        reason: `根据官方推荐问题的完整上下文准备针对性回答，文章和回答共享发布额度${domain ? `；按账号领域关键词“${domain}”选题` : ""}`,
      },
      () => guardAutocareRun(h),
    );
    h.ai.assertTextConfigured("copy");
    guardAutocareRun(h);
    job.status = "generating";
    job.generatedAt = now();
    job.message = "正在生成推荐问题回答";
    h.persist();
    h.log("answer.generating", job.message, accountId, "info", job);
    const result = await generateAutocareAnswer(
      h.ai,
      job.id,
      document,
      () => guardAutocareRun(h),
      domain,
    );
    if (h.closed()) return null;
    const checks = checkAutocareAnswer(result, document, domain);
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
        job.message = withinAutocareRun(h.state)
          ? "推荐问题回答检查通过，等待本批次排期"
          : "推荐问题回答已生成并归档，本批次已结束，未安排发布";
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
    guardAutocareRun(h);
    if (h.state.researchStops[accountId]) throw error;
    return null;
  }
}

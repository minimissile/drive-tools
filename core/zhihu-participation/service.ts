import { z } from "zod";
import { id, now, type Database } from "../database";
import { AppError, safeMessage } from "../errors";
import { cleanKnowledge } from "../knowledge-response";
import { RuntimeLog } from "../runtime-log";
import type { WebsiteAccounts } from "../website-accounts";
import type { AppPorts } from "../ports";
import type { ZhihuOperations } from "../zhihu/service";
import type { ZhihuContent } from "../../shared/zhihu";
import { zhihuWarmingHasPromotion } from "../../shared/zhihu";
import {
  autocareParticipationScope,
  autocareRandomLikeScope,
  autocareRandomCommentScope,
  autocareRandomFollowScope,
} from "../../shared/zhihu-autocare";
import { readAutocareState } from "../zhihu-autocare/state";
import { withinAutocareRun } from "../zhihu-autocare/run-window";
import {
  zhihuParticipationDiscoverInput,
  zhihuParticipationInspectInput,
  zhihuParticipationPlanInput,
  zhihuParticipationSaveInput,
  zhihuParticipationResolveInput,
  zhihuParticipationAnswerInput,
  zhihuResearchHitSchema,
  zhihuResearchDocumentSchema,
  type ZhihuParticipationActivity,
  type ZhihuParticipationCandidate,
  type ZhihuParticipationSnapshot,
} from "../../shared/zhihu-participation";
import {
  readParticipationState,
  zhihuParticipationStateKey,
  zhihuParticipationStateSchema,
} from "./state";
import {
  assertParticipationInteractionAvailable,
  executeParticipationInteraction,
  queueParticipationInteraction,
  continueParticipationInteraction,
  reconcileParticipationInteraction,
  recoverParticipationInteractions,
  type ParticipationInteractionHost,
  type ZhihuInteractionExecutionContext,
  type ZhihuInteractionRuleAuthorization,
} from "./interaction";
export type { ZhihuInteractionExecutionContext } from "./interaction";

const fail = (message: string): never => {
  throw new AppError("ZHIHU_PARTICIPATION_BLOCKED", message);
};
type Guard = (() => void) | undefined;
export interface ZhihuParticipationDependencies {
  db: Database;
  accounts: WebsiteAccounts;
  ports: AppPorts;
  zhihu: ZhihuOperations;
  dataPath: string;
  changed(): void;
}
/** Account-scoped research, local preparation and explicitly authorized single interactions. */
export class ZhihuParticipation {
  readonly logs: RuntimeLog;
  private active = new Set<string>();
  private closed = false;
  constructor(private d: ZhihuParticipationDependencies) {
    // Validate on domain reads/writes; unreadable local history must not prevent
    // the rest of the workspace from starting or silently overwrite that history.
    this.logs = new RuntimeLog(d.db, d.dataPath, "zhihu-participation");
    recoverParticipationInteractions(this.interactionHost());
  }
  get isBusy() {
    return this.active.size > 0;
  }
  close() {
    this.closed = true;
  }
  private interactionHost(): ParticipationInteractionHost {
    return {
      d: this.d,
      logs: this.logs,
      closed: () => this.closed,
      account: (accountId, uid) => this.account(accountId, uid),
      run: async (accountId, action) => {
        this.guard();
        if (this.active.has(accountId))
          fail("此账号已有查询或互动执行，等待原操作完成后再处理");
        this.active.add(accountId);
        this.d.changed();
        try {
          return await action();
        } finally {
          this.active.delete(accountId);
          if (!this.closed) this.d.changed();
        }
      },
    };
  }
  executeInteraction(raw: unknown, context: ZhihuInteractionExecutionContext) {
    this.guard();
    return executeParticipationInteraction(
      this.interactionHost(),
      raw,
      context,
    );
  }
  assertInteractionAvailable(
    accountId: string,
    limits: Pick<ZhihuInteractionExecutionContext, "dailyLimit" | "gapMinutes">,
    authorization?: ZhihuInteractionRuleAuthorization,
  ) {
    this.guard();
    assertParticipationInteractionAvailable(
      this.interactionHost(),
      accountId,
      limits,
      authorization,
    );
  }
  queueInteraction(raw: unknown, context: ZhihuInteractionExecutionContext) {
    this.guard();
    return queueParticipationInteraction(this.interactionHost(), raw, context);
  }
  continueInteraction(raw: unknown, context: ZhihuInteractionExecutionContext) {
    this.guard();
    return continueParticipationInteraction(
      this.interactionHost(),
      raw,
      context,
    );
  }
  reconcileInteraction(raw: unknown) {
    this.guard();
    return reconcileParticipationInteraction(this.interactionHost(), raw);
  }
  snapshot(): ZhihuParticipationSnapshot {
    const state = readParticipationState(this.d.db);
    return {
      candidates: state.candidates,
      activities: state.activities,
      busy: this.isBusy,
      logFolder: this.logs.folder,
    };
  }
  private guard(canContinue?: Guard) {
    if (this.closed) fail("工作空间已关闭，未继续查询或写入");
    canContinue?.();
  }
  private account(accountId: string, uid?: string) {
    const account = this.d.accounts.get(accountId);
    if (
      account.provider !== "zhihu" ||
      account.status !== "connected" ||
      !account.uid
    )
      fail("请选择已核验登录身份的知乎账号");
    if (uid && account.uid !== uid)
      fail("知乎账号身份已变化，未写入旧账号结果");
    const environment = this.d.db.get<{ engine: string }>(
      "SELECT engine FROM browser_environments WHERE id=?",
      account.environmentId ?? "",
    );
    if (environment?.engine !== "bitbrowser")
      fail("知乎日常参与需要绑定比特浏览器环境");
    return account;
  }
  private event(
    event: string,
    message: string,
    accountId: string,
    details: Record<string, unknown> = {},
    level: "info" | "error" = "info",
  ) {
    if (!this.closed)
      this.logs.record({ event, message, accountId, details, level });
  }
  private persist(state: ReturnType<typeof readParticipationState>) {
    this.d.db.setSetting(
      zhihuParticipationStateKey,
      zhihuParticipationStateSchema.parse(state),
    );
  }
  private candidate(
    state: ReturnType<typeof readParticipationState>,
    accountId: string,
    candidateId: string,
    version?: number,
  ) {
    const candidate =
      state.candidates.find((item) => item.id === candidateId) ??
      fail("候选内容不存在，请重新读取");
    if (candidate.accountId !== accountId)
      fail("候选内容不属于当前账号，不能跨账号使用");
    if (version !== undefined && candidate.version !== version)
      fail("候选上下文版本已变化，请重新核对后继续");
    return candidate;
  }
  private activity(
    state: ReturnType<typeof readParticipationState>,
    key: string,
    version: number,
  ) {
    const activity =
      state.activities.find((item) => item.id === key) ??
      fail("参与任务不存在，请重新读取");
    if (activity.version !== version)
      fail("参与任务版本已变化，请重新读取；不会重复创建稿件");
    this.account(activity.accountId);
    return activity;
  }
  async discover(
    raw: unknown,
    canContinue?: Guard,
  ): Promise<ZhihuParticipationCandidate[]> {
    const input = zhihuParticipationDiscoverInput.parse(raw);
    this.guard(canContinue);
    const account = this.account(input.accountId),
      port = this.d.ports.zhihuParticipation;
    const saved = readParticipationState(this.d.db),
      cached = saved.discoveryCache.find(
        (item) =>
          item.accountId === account.id &&
          (item.source ?? "search") === input.source &&
          item.query === input.query &&
          item.kind === input.kind,
      );
    if (
      !input.refresh &&
      cached &&
      Date.parse(cached.observedAt) >= Date.now() - 10 * 60000 &&
      Date.parse(cached.observedAt) <= Date.now() + 60000
    ) {
      const found = cached.candidateIds.map((key) =>
        saved.candidates.find(
          (item) => item.id === key && item.accountId === account.id,
        ),
      );
      if (found.every((item): item is ZhihuParticipationCandidate => !!item))
        return found;
    }
    const reader = port ?? fail("知乎只读发现适配不可用");
    if (this.active.has(account.id))
      fail("此账号已有上下文查询，等待完成后再试");
    this.active.add(account.id);
    this.d.changed();
    this.event(
      "research.discovering",
      "查询官方内容候选；不会点赞、评论或关注",
      account.id,
      { kind: input.kind, query: input.query, source: input.source },
    );
    try {
      const hits = await this.d.accounts.use(
        account.id,
        "zhihu",
        async (current) => {
          this.guard(canContinue);
          this.account(current.id, account.uid!);
          const result = await reader.discover(current, {
            query: input.query,
            kind: input.kind,
            limit: input.source === "creator_recommend" ? 50 : 10,
            source: input.source,
          });
          this.guard(canContinue);
          this.account(account.id, account.uid!);
          const parsed = zhihuResearchHitSchema
            .array()
            .max(input.source === "creator_recommend" ? 50 : 10)
            .parse(cleanKnowledge(result));
          if (
            input.source === "creator_recommend" &&
            parsed.some((hit) => hit.kind !== "question" || !hit.recommendation)
          )
            fail("推荐问题缺少官方浏览量证据，未保存为合格候选");
          return parsed;
        },
        "知乎只读发现相关问题与作者",
      );
      this.guard(canContinue);
      const state = readParticipationState(this.d.db),
        stamp = now(),
        result: ZhihuParticipationCandidate[] = [];
      for (const hit of hits) {
        if (result.some((item) => item.url === hit.url)) continue;
        let candidate = state.candidates.find(
          (item) => item.accountId === account.id && item.url === hit.url,
        );
        if (!candidate) {
          if (state.candidates.length >= 500)
            fail("候选历史已达500条，已停止新增；不会隐式删除历史");
          candidate = {
            ...hit,
            id: id("zhcandidate"),
            accountId: account.id,
            version: 1,
            document: null,
            checkedAt: stamp,
          };
          state.candidates.push(candidate);
        } else {
          const changedRecommendation =
            !!hit.recommendation &&
            JSON.stringify(candidate.recommendation) !==
              JSON.stringify(hit.recommendation);
          if (
            !candidate.document &&
            (candidate.title !== hit.title ||
              candidate.excerpt !== hit.excerpt ||
              candidate.author !== hit.author ||
              changedRecommendation)
          )
            Object.assign(candidate, hit, { version: candidate.version + 1 });
          else {
            candidate.excerpt = hit.excerpt;
            candidate.author = hit.author;
            if (hit.recommendation)
              candidate.recommendation = hit.recommendation;
          }
          candidate.checkedAt = stamp;
        }
        result.push(candidate);
      }
      const entry = {
          accountId: account.id,
          query: input.query,
          source: input.source,
          kind: input.kind,
          candidateIds: result.map((item) => item.id),
          observedAt: stamp,
        },
        prior = state.discoveryCache.findIndex(
          (item) =>
            item.accountId === account.id &&
            (item.source ?? "search") === input.source &&
            item.query === input.query &&
            item.kind === input.kind,
        );
      if (prior >= 0) state.discoveryCache[prior] = entry;
      else {
        if (state.discoveryCache.length >= 500)
          fail("查询缓存已达500组，已停止新增；请先整理本地历史");
        state.discoveryCache.push(entry);
      }
      this.guard(canContinue);
      this.persist(state);
      this.event(
        "research.discovered",
        `已保留${result.length}个官方候选，尚未阅读或互动`,
        account.id,
        {
          count: result.length,
          source: input.source,
          minimumViewsExclusive:
            input.source === "creator_recommend" ? 10000 : null,
        },
      );
      return result;
    } catch (error) {
      this.event(
        "research.failed",
        safeMessage(error),
        account.id,
        { operation: "discover" },
        "error",
      );
      throw error;
    } finally {
      this.active.delete(account.id);
      if (!this.closed) this.d.changed();
    }
  }
  async inspect(
    raw: unknown,
    canContinue?: Guard,
  ): Promise<ZhihuParticipationCandidate> {
    const input = zhihuParticipationInspectInput.parse(raw);
    this.guard(canContinue);
    const account = this.account(input.accountId),
      candidate = this.candidate(
        readParticipationState(this.d.db),
        account.id,
        input.candidateId,
        input.version,
      ),
      port = this.d.ports.zhihuParticipation;
    if (
      candidate.document &&
      Date.parse(candidate.document.observedAt) >= Date.now() - 5 * 60000 &&
      Date.parse(candidate.document.observedAt) <= Date.now() + 60000
    )
      return candidate;
    const reader = port ?? fail("知乎只读上下文适配不可用");
    if (this.active.has(account.id))
      fail("此账号已有上下文查询，等待完成后再试");
    this.active.add(account.id);
    this.d.changed();
    try {
      const document = await this.d.accounts.use(
        account.id,
        "zhihu",
        async (current) => {
          this.guard(canContinue);
          this.account(current.id, account.uid!);
          const value = await reader.inspect(current, { url: candidate.url });
          this.guard(canContinue);
          this.account(account.id, account.uid!);
          return zhihuResearchDocumentSchema.parse(cleanKnowledge(value));
        },
        "知乎只读完整上下文",
      );
      this.guard(canContinue);
      if (document.url !== candidate.url || document.kind !== candidate.kind)
        fail("返回的官方页面与原候选不一致，未覆盖原上下文");
      const state = readParticipationState(this.d.db),
        current = this.candidate(
          state,
          account.id,
          candidate.id,
          input.version,
        );
      const related = document.related.filter(
        (hit, index, all) =>
          hit.url !== current.url &&
          all.findIndex((item) => item.url === hit.url) === index &&
          !state.candidates.some(
            (item) => item.accountId === account.id && item.url === hit.url,
          ),
      );
      if (state.candidates.length + related.length > 500)
        fail(
          "当前页的相关候选将使历史超过500条，已整批停止保存；不会部分写入或删除历史",
        );
      for (const hit of related)
        state.candidates.push({
          ...hit,
          id: id("zhcandidate"),
          accountId: account.id,
          version: 1,
          document: null,
          checkedAt: now(),
        });
      const before = current.document && {
          ...current.document,
          observedAt: "",
        },
        after = { ...document, observedAt: "" };
      if (!before || JSON.stringify(before) !== JSON.stringify(after))
        current.version++;
      current.document = document;
      current.title = document.title;
      current.checkedAt = now();
      this.persist(state);
      this.event(
        "research.inspected",
        "完整上下文已保存；打开和采集不代表本人已读或完成互动",
        account.id,
        {
          candidateId: current.id,
          version: current.version,
          characters: document.text.length,
          relatedAdded: related.length,
        },
      );
      return current;
    } catch (error) {
      this.event(
        "research.failed",
        safeMessage(error),
        account.id,
        { operation: "inspect", candidateId: candidate.id },
        "error",
      );
      throw error;
    } finally {
      this.active.delete(account.id);
      if (!this.closed) this.d.changed();
    }
  }
  plan(raw: unknown, canContinue?: Guard) {
    return this.planActivity(raw, canContinue, false);
  }
  /** Server-only rule entry. The renderer's plan IPC cannot adopt legacy tasks. */
  planAutocareRule(raw: unknown, canContinue: () => void) {
    if (typeof canContinue !== "function") fail("规则任务缺少当前授权门禁");
    return this.planActivity(raw, canContinue, true);
  }
  private planActivity(raw: unknown, canContinue: Guard, ruleOwned: boolean) {
    const input = zhihuParticipationPlanInput.parse(raw);
    this.guard(canContinue);
    const actor = this.account(input.accountId);
    const state = readParticipationState(this.d.db),
      candidate = this.candidate(
        state,
        input.accountId,
        input.candidateId,
        input.version,
      );
    const autocare = ruleOwned ? readAutocareState(this.d.db) : null;
    if (autocare) {
      const scope =
        input.kind === "like"
          ? autocareRandomLikeScope
          : input.kind === "comment"
            ? autocareRandomCommentScope
            : input.kind === "follow"
              ? autocareRandomFollowScope
              : null;
      const allowed =
        input.kind === "like"
          ? autocare.config.randomLikes || autocare.config.likeCandidates
          : input.kind === "comment"
            ? autocare.config.randomComments
            : input.kind === "follow" && autocare.config.followCandidates;
      if (
        !scope ||
        input.planId !== scope ||
        !allowed ||
        !autocare.enabled ||
        !autocare.config.accountIds.includes(input.accountId) ||
        autocare.identities[input.accountId] !== actor.uid ||
        !withinAutocareRun(autocare) ||
        !candidate.document ||
        candidate.document.truncated ||
        candidate.document.text.length < 8
      )
        fail("当前账号、准确规则范围、批次或完整上下文不满足自动互动授权");
    }
    if (input.kind !== "read" && !candidate.document)
      fail("先保存完整上下文，再安排回答、评论、点赞或关注候选");
    if (input.kind === "answer" && candidate.kind !== "question")
      fail("回答候选必须是知乎官方问题");
    if (input.kind === "follow" && candidate.kind !== "author")
      fail("关注候选必须是作者；不会自动关注");
    if (["comment", "like"].includes(input.kind) && candidate.kind === "author")
      fail("评论或点赞候选需要具体内容");
    if (
      input.kind === "like" &&
      !["answer", "article"].includes(candidate.kind)
    )
      fail("点赞候选仅限回答或文章，问题不能点赞");
    const existing = state.activities.find(
      (item) =>
        item.accountId === input.accountId &&
        item.candidateId === candidate.id &&
        item.kind === input.kind &&
        (input.kind === "answer" ||
          input.kind === "follow" ||
          input.kind === "like" ||
          (ruleOwned && item.planId === autocareParticipationScope) ||
          (item.planId === input.planId &&
            item.scheduledAt === input.scheduledAt &&
            item.status !== "skipped")),
    );
    if (existing) {
      if (existing.attempts?.length)
        fail("原任务已有真实互动尝试，请核对原记录，不能改写上下文或建立重试");
      if (existing.planId !== input.planId && autocare) {
        if (
          existing.planId !== autocareParticipationScope ||
          existing.resolution ||
          existing.automation ||
          existing.contentId ||
          !["planned", "needs_review", "prepared"].includes(existing.status)
        )
          fail("只能接管原普通待办中从未执行、未处理、未排期的准确目标");
        const priorRead = autocare.research
          .filter(
            (read) =>
              read.accountId === input.accountId &&
              read.candidateId === candidate.id &&
              read.status === "saved" &&
              Date.parse(read.at) <= Date.parse(existing.createdAt),
          )
          .sort((a, b) => b.at.localeCompare(a.at))[0];
        if (priorRead?.uid && priorRead.uid !== actor.uid)
          fail("旧待办保存的读取身份与当前账号不同，原记录保留，未接管");
        const previous = {
          planId: existing.planId,
          version: existing.version,
          candidateVersion: existing.candidateVersion,
          contextObservedAt: existing.context?.observedAt ?? null,
        };
        existing.planId = input.planId;
        existing.candidateVersion = candidate.version;
        existing.context = structuredClone(candidate.document!);
        existing.reason = input.reason;
        existing.draft = input.draft;
        existing.scheduledAt = input.scheduledAt
          ? new Date(input.scheduledAt).toISOString()
          : null;
        existing.status = "needs_review";
        existing.version++;
        this.guard(canContinue);
        this.persist(state);
        this.event(
          "interaction.rule_adopted",
          "原未执行待办已按当前绑定身份的新规则授权接管，完整正文将重新核对；尚未提交",
          input.accountId,
          {
            activityId: existing.id,
            previousPlanId: previous.planId,
            planId: existing.planId,
            previousVersion: previous.version,
            previousCandidateVersion: previous.candidateVersion,
            previousContextObservedAt: previous.contextObservedAt,
            previousActorUid: priorRead?.uid || null,
            actorUid: actor.uid,
            authorization: "current_binding_new_rule",
          },
        );
        this.d.changed();
        return existing;
      }
      if (existing.planId !== input.planId)
        fail("此账号的候选已有其他计划任务，请使用原计划，不能跨计划认领");
      if (
        !existing.contentId &&
        !existing.resolution &&
        existing.candidateVersion !== candidate.version
      ) {
        existing.candidateVersion = candidate.version;
        if (existing.automation) {
          this.event(
            "interaction.queue_invalidated",
            "上下文已变化，旧互动决策仅保留审计，需重新授权安排",
            existing.accountId,
            { activityId: existing.id, automation: existing.automation },
          );
          delete existing.automation;
          existing.status =
            existing.kind === "read" ? "planned" : "needs_review";
        }
        existing.context = candidate.document
          ? structuredClone(candidate.document)
          : null;
        existing.reason = input.reason;
        existing.draft = input.draft || existing.draft;
        existing.scheduledAt = input.scheduledAt
          ? new Date(input.scheduledAt).toISOString()
          : null;
        existing.version++;
        this.guard(canContinue);
        this.persist(state);
        this.event(
          "activity.context_updated",
          "原待审任务已按新上下文更新准确版本，未另建任务或稿件",
          existing.accountId,
          { activityId: existing.id, candidateVersion: candidate.version },
        );
        this.d.changed();
      }
      return existing;
    }
    if (state.activities.length >= 2000)
      fail("参与任务历史已达2000条，已停止新增；不会隐式删除历史");
    const activity: ZhihuParticipationActivity = {
      id: id("zhactivity"),
      accountId: input.accountId,
      planId: input.planId,
      candidateId: candidate.id,
      candidateVersion: candidate.version,
      kind: input.kind,
      reason: input.reason,
      draft: input.draft,
      createdAt: now(),
      scheduledAt: input.scheduledAt
        ? new Date(input.scheduledAt).toISOString()
        : null,
      status: input.kind === "read" ? "planned" : "needs_review",
      contentId: null,
      version: 1,
      basis: "",
      context: candidate.document ? structuredClone(candidate.document) : null,
      resolution: null,
    };
    state.activities.push(activity);
    this.guard(canContinue);
    this.persist(state);
    this.event(
      "activity.planned",
      "参与候选已安排；本次未执行评论、点赞或关注",
      activity.accountId,
      { activityId: activity.id, kind: activity.kind, planId: activity.planId },
    );
    this.d.changed();
    return activity;
  }
  save(raw: unknown, canContinue?: Guard) {
    const input = zhihuParticipationSaveInput.parse(raw);
    this.guard(canContinue);
    const state = readParticipationState(this.d.db),
      activity = this.activity(state, input.id, input.version);
    if (activity.contentId || activity.resolution || activity.attempts?.length)
      fail(
        "此任务已有回答稿、真实尝试或本人记录；请打开原记录，不重复编辑任务副本",
      );
    activity.reason = input.reason;
    activity.draft = input.draft;
    if (activity.automation) {
      this.event(
        "interaction.queue_invalidated",
        "任务文字已修改，已撤销旧排期执行依据，需重新安排",
        activity.accountId,
        { activityId: activity.id, automation: activity.automation },
      );
      delete activity.automation;
      activity.status = "needs_review";
    }
    activity.version++;
    this.guard(canContinue);
    this.persist(state);
    this.d.changed();
    return activity;
  }
  resolve(raw: unknown) {
    const input = zhihuParticipationResolveInput.parse(raw);
    this.guard();
    const state = readParticipationState(this.d.db),
      activity = this.activity(state, input.id, input.version);
    if (activity.attempts?.length)
      fail(
        "此任务已有真实互动尝试，不能用本人记录覆盖官方证据或未知提交；请只读核对原尝试",
      );
    if (activity.resolution) fail("此任务已有人工作业记录，未覆盖历史证据");
    activity.status = input.outcome;
    activity.resolution = {
      outcome: input.outcome,
      note: String(cleanKnowledge(input.note)),
      at: now(),
      evidence: "self_report",
    };
    activity.version++;
    this.persist(state);
    this.event(
      "activity.self_reported",
      "本人记录已保存；不是知乎官方回执或系统自动阅读证明",
      activity.accountId,
      {
        activityId: activity.id,
        kind: activity.kind,
        outcome: input.outcome,
        evidence: "self_report",
      },
    );
    this.d.changed();
    return activity;
  }
  answer(
    raw: unknown,
    canContinue?: Guard,
    onSaved?: (content: ZhihuContent) => void,
  ) {
    const input = zhihuParticipationAnswerInput.parse(raw);
    this.guard(canContinue);
    const state = readParticipationState(this.d.db),
      activity =
        state.activities.find((item) => item.id === input.id) ??
        fail("参与任务不存在");
    this.account(activity.accountId);
    const body = input.body;
    if (activity.contentId) {
      const content = this.d.zhihu.store.get(
        "zhihu_contents",
        activity.contentId,
      );
      if (
        (input.version === activity.version ||
          input.version === activity.version - 1) &&
        content.title === input.title &&
        content.body === body &&
        activity.basis === input.basis
      )
        return { activity, contentId: content.id };
      fail("此问题已有原回答稿，请打开原稿继续；不会重复创建");
    }
    if (
      activity.version !== input.version ||
      activity.kind !== "answer" ||
      activity.resolution
    )
      fail("回答任务类型或版本已变化，不能重复起草");
    const candidate = this.candidate(
      state,
      activity.accountId,
      activity.candidateId,
      activity.candidateVersion,
    );
    if (
      candidate.kind !== "question" ||
      !candidate.document ||
      candidate.document.kind !== "question" ||
      candidate.document.url !== candidate.url
    )
      fail("先获取此官方问题的完整上下文快照，再基于真实上下文起草");
    if (candidate.document?.truncated === true)
      fail(
        "问题上下文已明确截断，不能据此准备回答；请本人阅读原文并取得完整上下文",
      );
    if (
      state.activities.some(
        (item) =>
          item.id !== activity.id &&
          item.accountId === activity.accountId &&
          item.candidateId === candidate.id &&
          item.contentId,
      )
    )
      fail("同一账号同一问题已有回答稿，请打开原稿");
    if (
      this.d.zhihu
        .snapshot()
        .contents.some(
          (item) =>
            item.kind === "answer" &&
            item.questionUrl === candidate.url &&
            (item.accountId === activity.accountId ||
              (!item.accountId &&
                item.source?.editorial?.accountId === activity.accountId)),
        )
    )
      fail("同一账号同一问题已有知乎原稿，不能重复创建");
    if (zhihuWarmingHasPromotion(`${input.title}\n${body}`))
      fail("日常养号回答含推广信息，请移除后重新核对");
    let contentId = "";
    this.guard(canContinue);
    this.d.db.transaction(() => {
      this.guard(canContinue);
      const content = this.d.zhihu.saveContent({
        accountId: activity.accountId,
        kind: "answer",
        purpose: "warming",
        category: "日常参与",
        title: input.title,
        body,
        questionUrl: candidate.url,
        aiAssisted: true,
      });
      if (content.accountId !== activity.accountId)
        fail("回答稿未能绑定原账号，未保存此次任务");
      activity.contentId = content.id;
      activity.draft = body;
      activity.basis = input.basis;
      activity.context = structuredClone(candidate.document);
      activity.status = "prepared";
      activity.version++;
      this.persist(state);
      contentId = content.id;
      onSaved?.(content);
      this.event(
        "answer.prepared",
        "账号专用AI辅助回答草稿已保存，未审核、未发布；来源与依据保留在活动记录",
        activity.accountId,
        {
          activityId: activity.id,
          candidateId: candidate.id,
          candidateVersion: candidate.version,
          contentId,
        },
      );
    });
    this.d.changed();
    return { activity, contentId };
  }
}

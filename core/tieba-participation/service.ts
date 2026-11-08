import { tiebaFollowWriteState } from "../tieba-autocare/store";
import { tiebaPublishingWriteState } from "../tieba-publishing/store";
import type { z } from "zod";
import { id, type Database } from "../database";
import { AppError, safeMessage } from "../errors";
import type { AppPorts } from "../ports";
import type { WebsiteAccounts } from "../website-accounts";
import type { BrowserEnvironments } from "../browser-environments";
import type { BrowserEnvironmentQueue } from "../browser-environment-queue";
import type { AiService } from "../ai";
import { RuntimeLog } from "../runtime-log";
import type {
  TiebaParticipationSnapshot,
  TiebaThreadContext,
  TiebaReplyReceipt,
  tiebaSaveReplySchema,
} from "../../shared/tieba-participation";
import { TiebaAutocareStore, type TargetRecord } from "../tieba-autocare/store";
import {
  TiebaParticipationStore,
  type CandidateRecord,
  type DraftRecord,
  type GenerationRecord,
} from "./store";
import {
  assertTiebaContext,
  checkTiebaReply,
  generatedTiebaReplySchema,
  tiebaBodyHash,
  tiebaContentHash,
  tiebaReplyInstruction,
} from "./generation";
import type { WebsiteAccount } from "../../shared/website-accounts";

const ref = (id: string) => ({ kind: "website" as const, id });
const businessDay = (time: number) =>
  new Date(time + 8 * 3600000).toISOString().slice(0, 10);
const dayStart = (time: number) =>
  new Date(
    Math.floor((time + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000,
  ).toISOString();
type Dependencies = {
  db: Database;
  accounts: WebsiteAccounts;
  environments: BrowserEnvironments;
  queue: BrowserEnvironmentQueue;
  ports: AppPorts;
  ai: AiService;
  dataPath: string;
  changed(): void;
  clock?(): number;
};

/** Explicit content preparation and submission. Queries never create remote or paid work. */
export class TiebaParticipation {
  readonly store: TiebaParticipationStore;
  readonly logs: RuntimeLog;
  private targets: TiebaAutocareStore;
  private working = false;
  private closed = false;
  private controllers = new Set<AbortController>();
  constructor(private d: Dependencies) {
    this.store = new TiebaParticipationStore(d.db);
    this.targets = new TiebaAutocareStore(d.db);
    this.logs = new RuntimeLog(d.db, d.dataPath, "tieba-participation");
    for (const draft of this.store.drafts()) {
      if (draft.status === "generating") {
        draft.status = "attention";
        draft.message = "上次生成已中断，费用与正文待核对，不自动重试。";
      } else if (draft.status === "submitting") {
        draft.status = draft.submittedAt ? "uncertain" : "draft";
        draft.message = draft.submittedAt
          ? "上次回帖可能已提交，仅可核对原结果。"
          : "上次提交前已中断，请检查正文后明确提交。";
      } else continue;
      draft.version++;
      draft.updatedAt = this.now();
      this.store.saveDraft(draft);
    }
    for (const attempt of this.store.generations())
      if (attempt.status === "reserved") {
        attempt.status = "uncertain";
        attempt.message = "生成请求因重启中断，可能已计费，不自动重试。";
        this.store.saveGeneration(attempt);
      }
  }
  get isBusy() {
    return this.working;
  }
  private time() {
    return this.d.clock?.() ?? Date.now();
  }
  private now() {
    return new Date(this.time()).toISOString();
  }
  private alive() {
    if (this.closed)
      throw new AppError("TIEBA_PARTICIPATION_CLOSED", "贴吧回复工作已停止。");
  }
  private browser() {
    if (!this.d.ports.tiebaParticipation)
      throw new AppError(
        "TIEBA_PARTICIPATION_UNAVAILABLE",
        "当前后台尚未接入帖子读取和回帖，请应用更新后重试。",
      );
    return this.d.ports.tiebaParticipation;
  }
  private account(accountId: string, uid?: string) {
    const account = this.d.accounts.get(accountId);
    if (
      account.provider !== "tieba" ||
      !account.uid ||
      (uid && account.uid !== uid)
    )
      throw new AppError(
        "TIEBA_REPLY_IDENTITY_CHANGED",
        "原贴吧账号身份未核实或已变化，请在原账号重新检查。",
      );
    if (this.d.environments.forAccount(ref(accountId)).engine !== "bitbrowser")
      throw new AppError(
        "TIEBA_REPLY_ENVIRONMENT",
        "帖子操作需要该账号关联的指纹浏览器环境。",
      );
    return account;
  }
  private target(targetId: string, writing = false) {
    const target = this.targets.target(targetId);
    if (!target)
      throw new AppError(
        "TIEBA_REPLY_TARGET_MISSING",
        "目标贴吧不存在，请先添加观察吧或同步关注吧。",
      );
    const account = this.account(target.accountId, target.uid);
    this.d.environments.assertStamp(ref(account.id), target.stamp);
    if (writing && target.paused)
      throw new AppError(
        "TIEBA_REPLY_TARGET_PAUSED",
        target.pauseReason || "目标贴吧已暂停，请先处理原因。",
      );
    return { target, account };
  }
  private candidate(candidateId: string, writing = false) {
    const candidate = this.store.candidate(candidateId);
    if (!candidate)
      throw new AppError(
        "TIEBA_REPLY_CANDIDATE_MISSING",
        "帖子候选已不存在，请重新发现帖子。",
      );
    const { target, account } = this.target(candidate.targetId, writing);
    if (candidate.uid !== account.uid || candidate.forumId !== target.forumId)
      throw new AppError(
        "TIEBA_REPLY_IDENTITY_CHANGED",
        "候选的身份或目标贴吧已变化。",
      );
    this.d.environments.assertStamp(ref(account.id), candidate.stamp);
    return { candidate, target, account };
  }
  private draft(draftId: string, version?: number) {
    const draft = this.store.draft(draftId);
    if (!draft)
      throw new AppError("TIEBA_REPLY_DRAFT_MISSING", "回复草稿已不存在。");
    if (version != null && version !== draft.version)
      throw new AppError(
        "TIEBA_REPLY_VERSION_CHANGED",
        "草稿已在其他窗口更新，请重新读取后再操作。",
      );
    return draft;
  }
  private event(
    event: string,
    message: string,
    accountId?: string,
    taskId?: string,
    level: "info" | "warning" | "error" = "info",
  ) {
    if (!this.closed)
      this.logs.record({ event, message, accountId, taskId, level });
  }
  private async operation<T>(action: () => Promise<T>) {
    this.alive();
    if (this.working)
      throw new AppError(
        "TIEBA_REPLY_BUSY",
        "已有帖子读取或回复操作正在进行，请等待完成。",
      );
    this.working = true;
    this.d.changed();
    try {
      return await action();
    } finally {
      this.working = false;
      if (!this.closed) this.d.changed();
    }
  }
  private async queued<T>(
    accountId: string,
    label: string,
    action: () => Promise<T>,
  ) {
    this.alive();
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      return await this.d.queue.schedule(
        [ref(accountId)],
        label,
        async () => {
          this.alive();
          return action();
        },
        controller.signal,
      );
    } catch (error) {
      if (!this.closed) this.pauseOnLimit(error, accountId);
      throw error;
    } finally {
      this.controllers.delete(controller);
    }
  }
  private async verify(account: WebsiteAccount) {
    const current = await this.d.accounts.verify(account.id);
    this.alive();
    if (current.status !== "connected" || current.uid !== account.uid)
      throw new AppError(
        "TIEBA_REPLY_LOGIN_REQUIRED",
        current.message || "请在原账号完成贴吧登录核验。",
      );
    return this.account(account.id, account.uid!);
  }
  private context(candidate: CandidateRecord) {
    const context = candidate.context;
    if (
      !context ||
      context.threadId !== candidate.threadId ||
      context.forumId !== candidate.forumId
    )
      throw new AppError(
        "TIEBA_CONTEXT_REQUIRED",
        "请先读取这条帖子的完整上下文。",
      );
    assertTiebaContext(context);
    const at = Date.parse(context.checkedAt);
    if (
      !Number.isFinite(at) ||
      at > this.time() + 5000 ||
      this.time() - at > 30 * 60000
    )
      throw new AppError(
        "TIEBA_CONTEXT_STALE",
        "上下文读取时间已过期，请重新读取后生成或提交。",
      );
    const managed = this.d.db.all<{ uid: string | null }>(
      "SELECT uid FROM website_accounts WHERE provider='tieba'",
    );
    if (
      context.authorUid &&
      managed.some((row) => row.uid === context.authorUid)
    )
      throw new AppError(
        "TIEBA_MANAGED_THREAD",
        "本人或其他受管账号的主题，不作为回复候选。",
      );
    if (context.replies.some((reply) => reply.authorUid === candidate.uid))
      throw new AppError(
        "TIEBA_ALREADY_PARTICIPATED",
        "该账号已在此主题发言，跳过重复参与。",
      );
    return context;
  }
  snapshot(): TiebaParticipationSnapshot {
    this.alive();
    const allDrafts = this.store.drafts();
    const pendingDrafts = allDrafts.filter(
      (draft) => !["verified", "skipped"].includes(draft.status),
    );
    const visibleDrafts = [
      ...pendingDrafts,
      ...allDrafts
        .filter((draft) => ["verified", "skipped"].includes(draft.status))
        .slice(0, 300),
    ];
    const allCandidates = this.store.candidates();
    const referenced = new Set(visibleDrafts.map((draft) => draft.candidateId));
    const recentCandidates = allCandidates.slice(0, 300);
    const recentIds = new Set(
      recentCandidates.map((candidate) => candidate.id),
    );
    const visibleCandidates = [
      ...recentCandidates,
      ...allCandidates.filter(
        (candidate) =>
          referenced.has(candidate.id) && !recentIds.has(candidate.id),
      ),
    ];
    return {
      busy: this.working,
      accounts: this.d.db
        .all<{ id: string }>(
          "SELECT id FROM website_accounts WHERE provider='tieba' ORDER BY created_at",
        )
        .map(({ id }) => this.d.accounts.get(id)),
      targets: this.targets
        .targets()
        .map(({ stamp: _stamp, ...target }) => target),
      candidates: visibleCandidates.map(
        ({ stamp: _stamp, ...candidate }) => candidate,
      ),
      drafts: visibleDrafts.map(
        ({
          stamp: _stamp,
          contextHash: _context,
          bodyHash: _body,
          history: _history,
          aiGenerated: _aiGenerated,
          ...draft
        }) => draft,
      ),
      logs: this.logs.read({}),
      message: this.working
        ? "正在处理帖子与回复"
        : "发现帖子后读取上下文，AI生成及官网提交均由明确操作触发。",
    };
  }
  async discover(input: { targetId: string }) {
    return this.operation(async () => {
      const { target, account } = this.target(input.targetId);
      await this.queued(account.id, `发现帖子 · ${target.name}`, async () => {
        const verified = await this.verify(account);
        this.target(input.targetId);
        const list = await this.browser().listThreads(
          verified,
          target.uid,
          target,
        );
        this.alive();
        this.target(input.targetId);
        const managed = new Set(
          this.snapshot()
            .accounts.map((item) => item.uid)
            .filter(Boolean),
        );
        const current = this.store.candidates();
        const seen = new Set<string>();
        this.d.db.transaction(() => {
          for (const item of list.slice(0, 30)) {
            if (
              !/^[1-9]\d{0,19}$/.test(item.threadId) ||
              item.forumId !== target.forumId ||
              !item.title.trim()
            )
              continue;
            if (seen.has(item.threadId)) continue;
            seen.add(item.threadId);
            const old = current.find(
              (row) => row.uid === target.uid && row.threadId === item.threadId,
            );
            if (old) {
              const draft = this.store
                .drafts()
                .find((row) => row.candidateId === old.id);
              const recoverable =
                !draft ||
                (!draft.submittedAt &&
                  ["draft", "ready", "failed", "skipped"].includes(
                    draft.status,
                  ));
              if (
                recoverable &&
                old.accountId === account.id &&
                old.targetId === target.id &&
                old.forumId === target.forumId &&
                JSON.stringify(old.stamp) !== JSON.stringify(target.stamp)
              ) {
                this.store.saveCandidate({
                  ...old,
                  stamp: target.stamp,
                  context: null,
                  status: "discovered",
                  message:
                    "原账号环境已重新核实，请重新读取上下文；原草稿正文保留。",
                  updatedAt: this.now(),
                });
                if (draft) {
                  draft.history.push({
                    version: draft.version,
                    body: draft.body,
                    at: draft.updatedAt,
                  });
                  draft.status = "draft";
                  draft.version++;
                  draft.message =
                    "账号环境已重新核实，请读取上下文并保存正文后再明确提交。";
                  draft.updatedAt = this.now();
                  this.store.saveDraft(draft);
                }
              }
              continue;
            }
            const own = !!item.authorUid && managed.has(item.authorUid);
            this.store.saveCandidate({
              ...item,
              id: id("tiebacandidate"),
              targetId: target.id,
              accountId: account.id,
              uid: target.uid,
              status: own ? "skipped" : "discovered",
              context: null,
              message: own
                ? "本人或受管账号的主题，不作为自动参与候选。"
                : "待读取首帖正文与必要楼层",
              stamp: target.stamp,
              updatedAt: this.now(),
            });
          }
        });
        this.event(
          "threads.discovered",
          `已读取 ${Math.min(list.length, 30)} 条帖子候选，原稿保留；重新核实身份的候选需再次读取上下文。`,
          account.id,
        );
      });
      return this.snapshot();
    });
  }
  async read(input: { candidateId: string }) {
    return this.operation(async () => {
      const { candidate, account } = this.candidate(input.candidateId);
      await this.queued(
        account.id,
        `读取帖子 · ${candidate.title}`,
        async () => {
          const verified = await this.verify(account);
          this.candidate(candidate.id);
          const context = await this.browser().readThread(
            verified,
            candidate.uid,
            candidate,
          );
          this.alive();
          this.candidate(candidate.id);
          if (
            context.threadId !== candidate.threadId ||
            context.forumId !== candidate.forumId
          )
            throw new AppError(
              "TIEBA_REPLY_TARGET_CHANGED",
              "官网返回了其他主题，原上下文已保留。",
            );
          const updated = this.store.candidate(candidate.id)!;
          updated.context = context;
          updated.updatedAt = this.now();
          try {
            this.context(updated);
            updated.status = "read";
            updated.message = "已保存完整首帖与必要楼层，可准备回复草稿。";
          } catch (error) {
            updated.status = "skipped";
            updated.message = safeMessage(error);
          }
          this.store.saveCandidate(updated);
          const draft = this.store
            .drafts()
            .find((row) => row.candidateId === candidate.id);
          if (
            draft &&
            !draft.submittedAt &&
            ["draft", "ready"].includes(draft.status) &&
            draft.contextHash !== tiebaContentHash(context)
          ) {
            draft.status = "draft";
            draft.version++;
            draft.message = "首帖上下文已变化，请重新检查并保存回复正文。";
            draft.updatedAt = this.now();
            this.store.saveDraft(draft);
          }
          this.event("thread.read", updated.message, account.id, candidate.id);
        },
      );
      return this.snapshot();
    });
  }
  async generate(
    input: { candidateId: string; confirmed: true },
    guard?: () => void,
  ) {
    return this.operation(async () => {
      guard?.();
      if (!input.confirmed)
        throw new AppError(
          "TIEBA_REPLY_GENERATION_CONFIRMATION",
          "请明确触发回复生成后再调用模型。",
        );
      const { candidate, account } = this.candidate(input.candidateId, true),
        context = this.context(candidate);
      const old = this.store
        .drafts()
        .find(
          (row) =>
            row.uid === candidate.uid && row.threadId === candidate.threadId,
        );
      if (
        old &&
        (old.submittedAt || !["failed", "skipped"].includes(old.status))
      )
        throw new AppError(
          "TIEBA_REPLY_GENERATION_EXISTS",
          "该主题已有回复或费用待核对记录，请使用原草稿，不重复生成。",
        );
      if ((old?.generationAttempts ?? 0) >= 2)
        throw new AppError(
          "TIEBA_REPLY_GENERATION_LIMIT",
          "该主题已达两次生成尝试上限，未再次调用。",
        );
      if (
        this.store
          .generations()
          .filter((row) => row.createdAt >= dayStart(this.time())).length >= 4
      )
        throw new AppError(
          "TIEBA_REPLY_DAILY_GENERATION_LIMIT",
          "今日已达四次回复生成尝试上限，未再次调用。",
        );
      this.d.ai.assertTextConfigured("copy");
      const draft: DraftRecord = {
        id: old?.id ?? id("tiebareply"),
        candidateId: candidate.id,
        accountId: account.id,
        uid: candidate.uid,
        threadId: candidate.threadId,
        title: candidate.title,
        url: candidate.url,
        version: (old?.version ?? 0) + 1,
        status: "generating",
        aiGenerated: false,
        body: "",
        evidence: [],
        checks: [],
        model: this.d.ai.modelFor("copy"),
        generationAttempts: (old?.generationAttempts ?? 0) + 1,
        submittedAt: null,
        receipt: null,
        message: "正在依据首帖上下文生成回复，费用沿用全局模型预算。",
        createdAt: old?.createdAt ?? this.now(),
        updatedAt: this.now(),
        stamp: candidate.stamp,
        contextHash: tiebaContentHash(context),
        bodyHash: "",
        history: old
          ? [
              ...old.history,
              { version: old.version, body: old.body, at: old.updatedAt },
            ]
          : [],
      };
      const attempt: GenerationRecord = {
        id: id("tiebageneration"),
        draftId: draft.id,
        status: "reserved",
        createdAt: this.now(),
        message: "已记录一次显式生成尝试",
      };
      this.d.db.transaction(() => {
        this.store.saveDraft(draft);
        this.store.saveGeneration(attempt);
      });
      const phase = `tieba_reply:${attempt.id}`;
      let received = false;
      try {
        const result = await this.d.ai.resourceExport(
          phase,
          generatedTiebaReplySchema,
          tiebaReplyInstruction,
          {
            title: context.title,
            body: context.body,
            replies: context.replies,
            url: context.url,
          },
          [],
          {
            maxTokens: 2200,
            schemaName: "tieba_reply",
            model: draft.model!,
            retainResponse: true,
            beforeRequest: () => {
              this.alive();
              guard?.();
              const fresh = this.candidate(candidate.id, true);
              if (
                !input.confirmed ||
                tiebaContentHash(this.context(fresh.candidate)) !==
                  draft.contextHash ||
                this.draft(draft.id).status !== "generating"
              )
                throw new AppError(
                  "TIEBA_REPLY_GENERATION_CHANGED",
                  "生成范围或上下文已变化，未发起新请求。",
                );
            },
          },
        );
        this.alive();
        received = true;
        attempt.status = "success";
        // A paid response survives a pause, revoked automation scope, or changed target.
        draft.body = result.body;
        draft.aiGenerated = !!result.body.trim();
        draft.evidence = result.evidence;
        draft.bodyHash = tiebaBodyHash(draft.body);
        guard?.();
        const current = this.candidate(candidate.id, true);
        if (
          tiebaContentHash(this.context(current.candidate)) !==
          draft.contextHash
        )
          throw new AppError(
            "TIEBA_CONTEXT_CHANGED",
            "生成期间上下文已变化，结果保留待检查。",
          );
        if (!result.publishable) {
          draft.status = "skipped";
          draft.message = result.reason || "原文缺少可补充的内容，已跳过。";
        } else {
          draft.checks = checkTiebaReply(result.body, context, result.evidence);
          draft.status = "ready";
          draft.message = "回复草稿已通过程序检查，请审阅后明确提交。";
        }
        draft.bodyHash = tiebaBodyHash(draft.body);
      } catch (error) {
        if (this.closed) throw error;
        const call = this.d.db.get<{ status: string }>(
          "SELECT status FROM api_calls WHERE phase=? ORDER BY created_at DESC LIMIT 1",
          phase,
        );
        const unknown =
          !received &&
          (call?.status === "uncertain" ||
            call?.status === "reserved" ||
            (!(error instanceof AppError) && !call));
        attempt.status = received
          ? "success"
          : unknown
            ? "uncertain"
            : "failed";
        const scopeRevoked =
          error instanceof AppError &&
          /AUTOMATION|CONTEXT_CHANGED|TARGET_PAUSED|IDENTITY|ENVIRONMENT|LOGIN/.test(
            error.code,
          );
        draft.status =
          received && scopeRevoked ? "draft" : unknown ? "attention" : "failed";
        draft.message = `${safeMessage(error)}${received ? "；已生成正文保留供人工检查，未提交官网。" : unknown ? "；费用待核对，不自动重试。" : "；未提交官网回复。"}`;
      }
      this.alive();
      draft.updatedAt = this.now();
      attempt.message = draft.message;
      this.d.db.transaction(() => {
        this.store.saveDraft(draft);
        this.store.saveGeneration(attempt);
      });
      this.event(
        "reply.generated",
        draft.message,
        account.id,
        draft.id,
        ["attention", "failed"].includes(draft.status) ? "warning" : "info",
      );
      return this.snapshot();
    });
  }
  saveDraft(input: z.infer<typeof tiebaSaveReplySchema>) {
    this.alive();
    if (this.working)
      throw new AppError("TIEBA_REPLY_BUSY", "请等待当前帖子操作完成后保存。");
    const draft = this.draft(input.draftId, input.version);
    if (
      draft.submittedAt ||
      !["draft", "ready", "failed", "skipped"].includes(draft.status)
    )
      throw new AppError(
        "TIEBA_REPLY_NOT_EDITABLE",
        "此回复正在处理或需核对结果，不能修改原正文。",
      );
    const { candidate } = this.candidate(draft.candidateId, true),
      context = this.context(candidate);
    const checks = checkTiebaReply(input.body, context, draft.evidence);
    draft.history.push({
      version: draft.version,
      body: draft.body,
      at: draft.updatedAt,
    });
    draft.body = input.body.trim();
    draft.bodyHash = tiebaBodyHash(draft.body);
    draft.contextHash = tiebaContentHash(context);
    draft.stamp = candidate.stamp;
    draft.checks = checks;
    draft.version++;
    draft.status = "ready";
    draft.updatedAt = this.now();
    draft.message = "正文已保存，程序检查通过；尚未提交官网。";
    this.store.saveDraft(draft);
    this.event("reply.saved", draft.message, draft.accountId, draft.id);
    this.d.changed();
    return this.snapshot();
  }
  private submissionAllowed(draft: DraftRecord) {
    this.alive();
    const { candidate, account } = this.candidate(draft.candidateId, true);
    this.d.environments.assertStamp(ref(account.id), draft.stamp);
    const context = this.context(candidate);
    if (
      tiebaContentHash(context) !== draft.contextHash ||
      tiebaBodyHash(draft.body) !== draft.bodyHash
    )
      throw new AppError(
        "TIEBA_CONTEXT_CHANGED",
        "正文或上下文与已保存版本不同，请重新读取并检查。",
      );
    checkTiebaReply(draft.body, context, draft.evidence);
    if (
      this.store
        .drafts()
        .some(
          (other) =>
            other.uid === draft.uid &&
            other.id !== draft.id &&
            ["uncertain", "submitting"].includes(other.status),
        )
    )
      throw new AppError(
        "TIEBA_REPLY_UNCERTAIN_BLOCK",
        "该账号仍有回帖结果待核对，请先核对原任务。",
      );
    if (
      this.d.db.get(
        "SELECT id FROM tieba_autocare_tasks WHERE json_extract(data,'$.accountId')=? AND day=? AND status IN ('uncertain','submitting') LIMIT 1",
        draft.accountId,
        businessDay(this.time()),
      )
    )
      throw new AppError(
        "TIEBA_SIGN_UNCERTAIN_BLOCK",
        "该账号今日仍有签到提交结果待核对，请先处理原任务。",
      );
    const hasTopics = !!this.d.db.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tieba_topic_drafts'",
    );
    if (
      hasTopics &&
      this.d.db.get(
        "SELECT id FROM tieba_topic_drafts WHERE uid=? AND status IN ('uncertain','submitting','pending_review') LIMIT 1",
        draft.uid,
      )
    )
      throw new AppError(
        "TIEBA_TOPIC_UNCERTAIN_BLOCK",
        "该账号仍有主题提交结果待核对，请先处理原主题。",
      );
    const resourcePosting = tiebaPublishingWriteState(this.d.db, draft.uid);
    const follow = tiebaFollowWriteState(this.d.db, draft.uid);
    if (resourcePosting.uncertain || follow.uncertain)
      throw new AppError(
        "TIEBA_PUBLISHING_UNCERTAIN_BLOCK",
        "该账号仍有关注或资源发帖结果待核对，请先处理原记录。",
      );
    const latest = this.d.db.get<{ at: string | null }>(
      "SELECT MAX(at) at FROM (SELECT submitted_at at FROM tieba_reply_drafts WHERE submitted_at IS NOT NULL UNION ALL SELECT submitted_at at FROM tieba_autocare_tasks WHERE submitted_at IS NOT NULL" +
        (hasTopics
          ? " UNION ALL SELECT submitted_at at FROM tieba_topic_drafts WHERE submitted_at IS NOT NULL"
          : "") +
        ")",
    )?.at;
    const lastMutation = Math.max(
      Date.parse(latest ?? "") || 0,
      Date.parse(resourcePosting.lastMutationAt ?? "") || 0,
      Date.parse(follow.lastMutationAt ?? "") || 0,
    );
    if (lastMutation && lastMutation + 60000 > this.time())
      throw new AppError(
        "TIEBA_REPLY_INTERVAL",
        "距离上次贴吧提交不足60秒，请稍后明确提交，不自动追赶。",
      );
    const count = this.store
      .drafts()
      .filter(
        (other) =>
          other.uid === draft.uid &&
          other.submittedAt &&
          other.submittedAt >= dayStart(this.time()),
      ).length;
    if (count >= 2)
      throw new AppError(
        "TIEBA_REPLY_DAILY_LIMIT",
        "此账号今日已达两次回帖提交上限，未知尝试也计入。",
      );
    return { candidate, account, context };
  }
  private exactReceipt(draft: DraftRecord, receipt: TiebaReplyReceipt) {
    try {
      const url = new URL(receipt.url ?? "");
      const queryIds = url.searchParams.getAll("pid"),
        hashId = url.hash
          ? url.hash.match(/^#(?:post_)?([1-9]\d{0,19})$/u)?.[1]
          : null;
      const exactFloor =
        (queryIds.length > 0 || !!hashId) &&
        queryIds.every((value) => value === receipt.postId) &&
        (!url.hash || hashId === receipt.postId);
      return (
        !!draft.submittedAt &&
        receipt.status === "verified" &&
        receipt.threadId === draft.threadId &&
        /^[1-9]\d{0,19}$/.test(receipt.postId ?? "") &&
        receipt.authorUid === draft.uid &&
        !!receipt.body &&
        receipt.body.normalize("NFKC").replace(/\s+/gu, " ").trim() ===
          draft.body.normalize("NFKC").replace(/\s+/gu, " ").trim() &&
        url.origin === "https://tieba.baidu.com" &&
        !url.username &&
        !url.password &&
        url.pathname === `/p/${draft.threadId}` &&
        exactFloor &&
        Number.isFinite(Date.parse(receipt.checkedAt)) &&
        Date.parse(receipt.checkedAt) >= Date.parse(draft.submittedAt)
      );
    } catch {
      return false;
    }
  }
  async submit(
    input: { draftId: string; version: number; confirmed: true },
    guard?: () => void,
  ) {
    return this.operation(async () => {
      guard?.();
      let draft = this.draft(input.draftId, input.version);
      if (!input.confirmed || draft.status !== "ready" || draft.submittedAt)
        throw new AppError(
          "TIEBA_REPLY_NOT_READY",
          "只有已检查的准确版本可明确提交；已有提交记录只能核对。",
        );
      const { account } = this.submissionAllowed(draft);
      const originalVersion = draft.version;
      draft = {
        ...draft,
        status: "submitting",
        version: draft.version + 1,
        message: "等待原账号环境，尚未提交。",
        updatedAt: this.now(),
      };
      if (!this.store.claimSubmit(draft, originalVersion))
        throw new AppError(
          "TIEBA_REPLY_VERSION_CHANGED",
          "回复已被其他操作领取，未重复提交。",
        );
      try {
        await this.queued(account.id, `提交回复 · ${draft.title}`, async () => {
          await this.verify(account);
          guard?.();
          const allowed = this.submissionAllowed(draft);
          const context = await this.browser().readThread(
            allowed.account,
            draft.uid,
            allowed.candidate,
          );
          this.alive();
          const fresh = { ...allowed.candidate, context };
          this.store.saveCandidate({ ...fresh, updatedAt: this.now() });
          this.context(fresh);
          checkTiebaReply(draft.body, context, draft.evidence);
          if (tiebaContentHash(context) !== draft.contextHash) {
            this.store.saveCandidate({
              ...allowed.candidate,
              context,
              updatedAt: this.now(),
            });
            throw new AppError(
              "TIEBA_CONTEXT_CHANGED",
              "提交前首帖已变化，原稿保留，请重新审阅。",
            );
          }
          const receipt = await this.browser().reply(
            allowed.account,
            draft.uid,
            context,
            draft.body,
            async () => {
              guard?.();
              this.submissionAllowed(draft);
              const stored = this.draft(draft.id, draft.version);
              if (stored.status !== "submitting" || stored.submittedAt)
                throw new AppError(
                  "TIEBA_REPLY_ALREADY_SUBMITTED",
                  "回复已有提交检查点，不能再次点击。",
                );
              draft.submittedAt = this.now();
              draft.message = "已保存提交检查点，正在等待官网结果。";
              draft.updatedAt = this.now();
              this.store.saveDraft(draft);
              this.event(
                "reply.submitting",
                draft.message,
                draft.accountId,
                draft.id,
              );
              this.d.changed();
            },
            { aiGenerated: draft.aiGenerated ?? Boolean(draft.model) },
          );
          this.alive();
          draft.receipt = receipt;
          draft.status = this.exactReceipt(draft, receipt)
            ? "verified"
            : draft.submittedAt
              ? "uncertain"
              : receipt.status === "verified"
                ? "skipped"
                : "draft";
          draft.message =
            draft.status === "verified"
              ? "官网已核实该账号、正文和楼层链接。"
              : draft.status === "skipped"
                ? "官网已存在本人相同回复，本次没有再次提交。"
                : receipt.message || "官网结果待核对，不会自动再次提交。";
        });
      } catch (error) {
        if (this.closed) throw error;
        draft.status = draft.submittedAt
          ? "uncertain"
          : error instanceof AppError &&
              [
                "TIEBA_ALREADY_PARTICIPATED",
                "TIEBA_MANAGED_THREAD",
                "TIEBA_REPLY_DUPLICATE",
              ].includes(error.code)
            ? "skipped"
            : "draft";
        draft.message = safeMessage(error);
        this.pauseOnLimit(error, draft.accountId);
      }
      this.alive();
      draft.version++;
      draft.updatedAt = this.now();
      this.store.saveDraft(draft);
      this.event(
        "reply.result",
        draft.message,
        draft.accountId,
        draft.id,
        draft.status === "uncertain" ? "warning" : "info",
      );
      return this.snapshot();
    });
  }
  private pauseOnLimit(error: unknown, accountId: string) {
    if (
      !(error instanceof AppError) ||
      !/LOGIN|IDENTITY|UID|ENVIRONMENT_CHANGED|VERIFICATION|CAPTCHA|RATE_LIMITED/.test(
        error.code,
      )
    )
      return;
    for (const target of this.targets
      .targets()
      .filter((row) => row.accountId === accountId))
      this.targets.saveTarget({
        ...target,
        paused: true,
        pauseReason: safeMessage(error),
      });
  }
  async reconcile(input: { draftId: string }) {
    return this.operation(async () => {
      let draft = this.draft(input.draftId);
      if (draft.status !== "uncertain" || !draft.submittedAt)
        throw new AppError(
          "TIEBA_REPLY_RECONCILE_REQUIRED",
          "此记录无需补核，仅未知的原提交可查询结果。",
        );
      const account = this.account(draft.accountId, draft.uid),
        candidate = this.store.candidate(draft.candidateId),
        currentStamp = this.d.environments.stamp(ref(account.id));
      if (!candidate?.context)
        throw new AppError(
          "TIEBA_CONTEXT_REQUIRED",
          "原上下文已缺失，不能猜测回帖结果。",
        );
      await this.queued(account.id, `核对原回复 · ${draft.title}`, async () => {
        this.d.environments.assertStamp(ref(account.id), currentStamp);
        const verified = await this.verify(account);
        this.d.environments.assertStamp(ref(account.id), currentStamp);
        draft = this.draft(draft.id);
        if (draft.status !== "uncertain" || !draft.submittedAt) return;
        const receipt = await this.browser().reconcileReply(
          verified,
          draft.uid,
          candidate.context!,
          draft.body,
          draft.submittedAt,
        );
        this.alive();
        this.account(draft.accountId, draft.uid);
        this.d.environments.assertStamp(ref(account.id), currentStamp);
        draft.receipt = receipt;
        draft.status = this.exactReceipt(draft, receipt)
          ? "verified"
          : "uncertain";
        draft.message =
          draft.status === "verified"
            ? "官网补核确认原回复的身份、正文和楼层。"
            : receipt.message || "未查到确定的原回复，保留未知结果，不重发。";
        draft.version++;
        draft.updatedAt = this.now();
        this.store.saveDraft(draft);
        this.event(
          "reply.reconciled",
          draft.message,
          draft.accountId,
          draft.id,
          draft.status === "uncertain" ? "warning" : "info",
        );
      });
      return this.snapshot();
    });
  }
  dispose() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
  }
}

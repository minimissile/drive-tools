import { createHash } from "node:crypto";
import { id, now } from "../database";
import { AppError, safeMessage } from "../errors";
import { cleanKnowledge } from "../knowledge-response";
import { zhihuWarmingHasPromotion } from "../../shared/zhihu";
import {
  zhihuInteractionExecuteInput,
  zhihuInteractionReconcileInput,
  zhihuInteractionQueueInput,
  zhihuInteractionContinueInput,
  isUnsubmittedTechnicalInteractionAttempt,
  zhihuInteractionRequestSchema,
  zhihuInteractionReceiptSchema,
  type ZhihuInteractionAttempt,
  type ZhihuInteractionRequest,
  type ZhihuInteractionReceipt,
  type ZhihuInteractionContinuation,
} from "../../shared/zhihu-interaction";
import type { ZhihuParticipationActivity } from "../../shared/zhihu-participation";
import type { WebsiteAccount } from "../../shared/website-accounts";
import type { RuntimeLog } from "../runtime-log";
import type { ZhihuParticipationDependencies } from "./service";
import {
  readParticipationState,
  zhihuParticipationStateKey,
  zhihuParticipationStateSchema,
  type ZhihuParticipationState,
} from "./state";

export interface ZhihuInteractionExecutionContext {
  planId: string;
  planRevision: number;
  dailyLimit: number;
  gapMinutes: number;
  excludedUids: string[];
  guard(): void;
  /** Set only by a direct, exact-target human confirmation command. */
  humanConfirmed?: boolean;
}
export interface ParticipationInteractionHost {
  d: ZhihuParticipationDependencies;
  logs: RuntimeLog;
  closed(): boolean;
  account(accountId: string, uid?: string): WebsiteAccount;
  run<T>(accountId: string, action: () => Promise<T>): Promise<T>;
}
const fail = (message: string): never => {
  throw new AppError("ZHIHU_INTERACTION_BLOCKED", message);
};
const normalize = (value: string) =>
  value.normalize("NFKC").replace(/\s+/g, "").trim();
const day = (value: string | number) =>
  new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);
function persist(
  host: ParticipationInteractionHost,
  state: ZhihuParticipationState,
) {
  if (host.closed()) fail("工作空间已关闭，原提交记录保留待核对");
  host.d.db.setSetting(
    zhihuParticipationStateKey,
    zhihuParticipationStateSchema.parse(state),
  );
}
function activity(state: ZhihuParticipationState, key: string) {
  return (
    state.activities.find((item) => item.id === key) ??
    fail("互动任务不存在，请读取原任务")
  );
}
function network(
  host: ParticipationInteractionHost,
  account: WebsiteAccount,
): string {
  const row = host.d.db.get<{ data: string }>(
    "SELECT data FROM browser_environments WHERE id=?",
    account.environmentId ?? "",
  );
  if (!row) return "unknown";
  try {
    const data = JSON.parse(row.data);
    return typeof data.network?.ip === "string" && data.network.ip
      ? data.network.ip
      : "unknown";
  } catch {
    return "unknown";
  }
}
function log(
  host: ParticipationInteractionHost,
  event: string,
  message: string,
  item: ZhihuParticipationActivity,
  details: Record<string, unknown> = {},
  level: "info" | "warning" | "error" = "info",
) {
  if (!host.closed())
    host.logs.record({
      event,
      message,
      accountId: item.accountId,
      taskId: item.id,
      details: { planId: item.planId, kind: item.kind, ...details },
      level,
    });
}
/** Recovery records interruption, not permission to repeat an action. No browser or model work. */
export function recoverParticipationInteractions(
  host: ParticipationInteractionHost,
) {
  let state: ZhihuParticipationState;
  try {
    state = readParticipationState(host.d.db);
  } catch (error) {
    host.logs.record({
      event: "interaction.history_unreadable",
      level: "error",
      message: safeMessage(error),
    });
    return;
  }
  const interrupted = state.activities.filter(
    (item) =>
      item.status === "executing" ||
      item.attempts?.some((attempt) => attempt.status === "running"),
  );
  if (!interrupted.length) return;
  for (const item of interrupted) {
    for (const attempt of item.attempts ?? [])
      if (attempt.status === "running") {
        attempt.status = attempt.submittedAt ? "unknown" : "failed";
        attempt.finishedAt = now();
        attempt.error = attempt.submittedAt
          ? "应用重启中断已记录提交的原尝试，结果待核对；未重放或清除提交记录"
          : "应用重启中断原尝试；从未进入提交检查点，已记录失败且不自动重放";
      }
    item.status = item.attempts?.some((attempt) => attempt.status === "unknown")
      ? "attention"
      : "failed";
    item.version++;
  }
  persist(host, state);
  for (const item of interrupted)
    log(
      host,
      "interaction.recovered_interruption",
      item.status === "attention"
        ? "上次真实互动已提交后中断，原任务待核对；不会自动继续"
        : "上次原尝试在提交前中断，失败记录保留；不会自动继续",
      item,
      {},
      "warning",
    );
}
function assertQuota(
  host: ParticipationInteractionHost,
  state: ZhihuParticipationState,
  item: ZhihuParticipationActivity,
  ctx: ZhihuInteractionExecutionContext,
  networkKey: string,
  ownAttemptId?: string,
) {
  const entries = state.activities.flatMap((other) =>
    (other.attempts ?? [])
      .filter((attempt) => attempt.id !== ownAttemptId)
      .map((attempt) => ({ other, attempt })),
  );
  if (
    entries.some(
      ({ other, attempt }) =>
        other.accountId === item.accountId &&
        (attempt.status === "unknown" || attempt.status === "running"),
    )
  )
    fail("此账号有进行中或结果待核对的互动尝试，禁止继续真实互动");
  if (
    entries.filter(
      ({ other, attempt }) =>
        other.accountId === item.accountId &&
        day(attempt.submittedAt ?? attempt.startedAt) === day(Date.now()),
    ).length >= ctx.dailyLimit
  )
    fail("已达此账号跨计划共享的互动日额度，请等待下一运营日");
  const gap = Math.max(60, ctx.gapMinutes) * 60000,
    stamp = Date.now();
  if (
    entries.some(
      ({ other, attempt }) =>
        (other.accountId === item.accountId ||
          networkKey === "unknown" ||
          !attempt.networkKey ||
          attempt.networkKey === "unknown" ||
          attempt.networkKey === networkKey) &&
        stamp - Date.parse(attempt.submittedAt ?? attempt.startedAt) < gap,
    )
  )
    fail("账号或同出口互动错峰间隔尚未满足，未执行新操作");
  if (
    host.d.zhihu
      .snapshot()
      .tasks.some(
        (task) =>
          task.attemptedAt &&
          (task.accountId === item.accountId ||
            networkKey === "unknown" ||
            !task.networkKey ||
            task.networkKey === "unknown" ||
            task.networkKey === networkKey) &&
          stamp - Date.parse(task.attemptedAt) < gap,
      )
  )
    fail("此账号或同出口近期已有知乎发布，互动需继续等待错峰间隔");
}
function assertExact(
  host: ParticipationInteractionHost,
  state: ZhihuParticipationState,
  item: ZhihuParticipationActivity,
  expectedVersion: number,
  ctx: ZhihuInteractionExecutionContext,
  requireDue = true,
) {
  ctx.guard();
  if (host.closed()) fail("工作空间已关闭，未继续互动");
  if (
    item.version !== expectedVersion ||
    item.planId !== ctx.planId ||
    item.resolution ||
    item.contentId
  )
    fail("互动任务版本、计划或本人处理状态已变化，未继续操作");
  if (!["like", "comment", "follow"].includes(item.kind))
    fail("此任务不属于可执行的个人内容互动");
  const candidate =
    state.candidates.find(
      (entry) =>
        entry.id === item.candidateId && entry.accountId === item.accountId,
    ) ?? fail("原账号候选不存在，未执行互动");
  if (
    candidate.version !== item.candidateVersion ||
    !candidate.document ||
    candidate.document.truncated ||
    !item.context ||
    item.context.truncated
  )
    fail("互动需要当前准确版本的完整上下文，片段或旧版本不能执行");
  const canonicalContext = (document: typeof item.context) =>
    document &&
    JSON.stringify({
      kind: document.kind,
      url: document.url,
      title: document.title,
      text: document.text,
    });
  if (canonicalContext(candidate.document) !== canonicalContext(item.context))
    fail("保存的互动依据与当前官方上下文不同，请重新核对");
  if (
    requireDue &&
    item.scheduledAt &&
    Date.parse(item.scheduledAt) > Date.now()
  )
    fail("尚未到原任务安排的时间，未提前执行互动");
  if (item.kind === "follow" && candidate.kind !== "author")
    fail("关注目标必须是作者");
  if (item.kind === "like" && !["article", "answer"].includes(candidate.kind))
    fail("点赞目标必须是文章或回答");
  if (
    item.kind === "comment" &&
    !["answer", "article"].includes(candidate.kind)
  )
    fail("真实评论目标必须是文章或回答");
  return candidate;
}
function validateReceipt(
  raw: unknown,
  request: ZhihuInteractionRequest,
  submittedAt: string | null,
  startedAt: string,
): ZhihuInteractionReceipt {
  const receipt = zhihuInteractionReceiptSchema.parse(cleanKnowledge(raw));
  const expected = {
    like: "liked",
    comment: "commented",
    follow: "following",
  } as const;
  if (
    receipt.kind !== request.kind ||
    receipt.url !== request.url ||
    receipt.actorUid !== request.actorUid ||
    receipt.state !== expected[request.kind] ||
    request.excludedUids.includes(receipt.targetAuthorUid)
  )
    fail("官方互动证据的账号、目标或状态不匹配，结果待核对");
  if (receipt.outcome === "performed" && !submittedAt)
    fail("未保存提交意图却收到执行回执，结果待核对");
  if (
    request.kind === "comment" &&
    (!receipt.commentId || receipt.text !== request.text)
  )
    fail("评论证据缺少精确原文或官方评论ID，不能登记成功");
  if (request.kind !== "comment" && receipt.text)
    fail("非评论操作返回了不符的正文证据");
  if (
    Date.parse(receipt.observedAt) < Date.parse(startedAt) - 60000 ||
    Date.parse(receipt.observedAt) > Date.now() + 60000
  )
    fail("官方证据观察时间与本次核对不匹配");
  const path = new URL(request.url).pathname,
    targetId = path.split("/").at(-1);
  if (request.kind !== "follow" && receipt.targetId !== targetId)
    fail("官方目标ID与原请求不一致，不能登记成功");
  if (request.kind === "follow" && receipt.targetId !== receipt.targetAuthorUid)
    fail("关注回执的目标ID与官方作者UID不一致，不能登记成功");
  return receipt;
}
function finish(
  host: ParticipationInteractionHost,
  itemId: string,
  attemptId: string,
  result: { receipt: ZhihuInteractionReceipt } | { error: unknown },
  fallback: ZhihuParticipationActivity,
) {
  if (host.closed()) return fallback;
  const state = readParticipationState(host.d.db),
    item = activity(state, itemId),
    attempt =
      item.attempts?.find((entry) => entry.id === attemptId) ??
      fail("原互动尝试不存在，未新建或重放");
  if (attempt.status === "succeeded") return item;
  if ("receipt" in result) {
    attempt.receipt = result.receipt;
    attempt.status = "succeeded";
    attempt.error = "";
    item.status = "succeeded";
  } else {
    const text = safeMessage(result.error),
      uncertain =
        !!attempt.submittedAt ||
        (result.error instanceof AppError && result.error.uncertain);
    attempt.status = uncertain ? "unknown" : "failed";
    attempt.error = text;
    item.status =
      uncertain ||
      /验证码|安全验证|实名|协议|限制|频繁|身份|登录|待核对/.test(text)
        ? "attention"
        : "failed";
  }
  attempt.finishedAt = now();
  item.version++;
  persist(host, state);
  log(
    host,
    `interaction.${item.status}`,
    attempt.receipt
      ? attempt.receipt.outcome === "already_present"
        ? "官方页面已存在此状态，未再次点击"
        : "已核实本账号真实互动状态"
      : attempt.error,
    item,
    { attemptId, submittedAt: attempt.submittedAt, receipt: attempt.receipt },
    item.status === "attention" ? "error" : "info",
  );
  host.d.changed();
  return item;
}
function prepareInteraction(
  host: ParticipationInteractionHost,
  raw: unknown,
  ctx: ZhihuInteractionExecutionContext,
  requireDue = true,
  continuation?: ZhihuInteractionContinuation,
) {
  const input = zhihuInteractionExecuteInput.parse(raw);
  if (
    !ctx ||
    typeof ctx.guard !== "function" ||
    !/^(?:ioplan|autocare)_[\w-]+$/.test(ctx.planId) ||
    !Number.isSafeInteger(ctx.planRevision) ||
    ctx.planRevision < 1 ||
    !Number.isSafeInteger(ctx.dailyLimit) ||
    ctx.dailyLimit < 1 ||
    ctx.dailyLimit > 10 ||
    !Number.isFinite(ctx.gapMinutes) ||
    ctx.gapMinutes < 0 ||
    ctx.gapMinutes > 10080
  )
    fail("缺少有效的独立互动执行授权与本地限额");
  if (input.decision.relevance === null && !ctx.humanConfirmed)
    fail("本人确认记录只能由明确的单项确认入口创建，模型不能代替本人确认");
  if (
    ctx.planId.startsWith("autocare_") &&
    (!ctx.humanConfirmed || input.decision.relevance !== null)
  )
    fail("普通运营互动仅接受准确目标的本人确认");
  const state = readParticipationState(host.d.db),
    item = activity(state, input.id),
    candidate = assertExact(host, state, item, input.version, ctx, requireDue),
    account = host.account(item.accountId);
  const continued =
    continuation ??
    (requireDue && item.status === "queued"
      ? item.automation?.continuation
      : undefined);
  if (
    (!continued && item.attempts?.length) ||
    ["executing", "succeeded", "attention", "done", "skipped"].includes(
      item.status,
    ) ||
    (item.status === "failed" && !continuation)
  )
    fail("此原任务已有执行或处理历史，不能自动重放；请核对原记录");
  if (!item.context!.text.includes(input.decision.quote))
    fail("相关性引用必须真实存在于完整上下文中，不能编造依据");
  const comment = item.kind === "comment" ? item.draft.trim() : "";
  if (
    item.kind === "comment" &&
    (comment.length < 10 ||
      comment.length > 1000 ||
      zhihuWarmingHasPromotion(comment) ||
      /互关|互粉|互赞|互评|刷赞|涨粉群|私信|加群|扫码/.test(comment))
  )
    fail("评论需要10至1000字的具体无推广正文，不使用互赞互关或引流模板");
  const managed = host.d.db
      .all<{ uid: string }>(
        "SELECT uid FROM website_accounts WHERE provider='zhihu' AND uid IS NOT NULL",
      )
      .map((entry) => entry.uid),
    excludedUids = [
      ...new Set([account.uid!, ...ctx.excludedUids, ...managed]),
    ],
    networkKey = network(host, account);
  const request = zhihuInteractionRequestSchema.parse({
    kind: item.kind,
    url: candidate.url,
    actorUid: account.uid!,
    excludedUids,
    text: comment,
    contextText: item.context!.text,
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          accountId: item.accountId,
          uid: account.uid,
          planId: ctx.planId,
          revision: ctx.planRevision,
          version: item.version,
          candidateVersion: item.candidateVersion,
          kind: item.kind,
          url: candidate.url,
          text: comment,
          context: item.context!.text,
          decision: input.decision,
        }),
      )
      .digest("hex"),
  });
  if (continued) {
    const history = item.attempts ?? [],
      previous = history.at(-1);
    if (
      !previous ||
      history.length >= 20 ||
      previous.id !== continued.attemptId ||
      previous.request.fingerprint !== continued.requestFingerprint ||
      !history.every(isUnsubmittedTechnicalInteractionAttempt) ||
      !history.every(
        (attempt) =>
          attempt.planId === ctx.planId &&
          attempt.request.actorUid === request.actorUid &&
          attempt.request.kind === request.kind &&
          attempt.request.url === request.url &&
          attempt.request.text === request.text &&
          attempt.request.contextText === request.contextText &&
          attempt.request.excludedUids.every((uid) =>
            request.excludedUids.includes(uid),
          ) &&
          JSON.stringify(attempt.decision) === JSON.stringify(input.decision),
      )
    )
      fail(
        "仅允许修复技术故障后继续从未提交的原任务；身份、目标、全文、正文或原AI决定已变化，未续排",
      );
    if (
      !continuation &&
      (item.automation?.planRevision !== ctx.planRevision ||
        continued.fromVersion !== item.version - 1)
    )
      fail("原任务继续授权或准确版本已变化，未重复执行");
  }
  if (
    state.activities.some(
      (other) =>
        other.id !== (continued ? item.id : null) &&
        (other.attempts ?? []).some(
          (attempt) =>
            attempt.request.actorUid === request.actorUid &&
            attempt.request.kind === request.kind &&
            attempt.request.url === request.url,
        ),
    )
  )
    fail("此账号对同一目标已有真实尝试记录，不能通过新任务重复执行");
  if (
    comment &&
    state.activities.some(
      (other) =>
        other.id !== (continued ? item.id : null) &&
        other.attempts?.some(
          (attempt) =>
            attempt.request.kind === "comment" &&
            normalize(attempt.request.text) === normalize(comment),
        ),
    )
  )
    fail("相同评论已经用于其他真实尝试，不跨目标或跨账号复制模板");
  if (
    state.activities.some(
      (other) =>
        other.id !== item.id &&
        other.status === "queued" &&
        other.automation &&
        other.accountId === item.accountId &&
        other.kind === item.kind &&
        state.candidates.find((entry) => entry.id === other.candidateId)
          ?.url === candidate.url,
    )
  )
    fail("同一账号和目标已有原互动排期，不能通过新任务重复安排");
  if (
    comment &&
    state.activities.some(
      (other) =>
        other.id !== item.id &&
        other.status === "queued" &&
        other.automation &&
        other.kind === "comment" &&
        normalize(other.draft) === normalize(comment),
    )
  )
    fail("相同评论已进入原排期，不能跨目标或跨账号复制安排");
  return { input, state, item, account, request, networkKey };
}
/** Explicitly requeue only the original exact, demonstrably unsubmitted DOM
 * failure. Every old attempt remains immutable and still consumes quota/gap. */
export function continueParticipationInteraction(
  host: ParticipationInteractionHost,
  raw: unknown,
  ctx: ZhihuInteractionExecutionContext,
): ZhihuParticipationActivity {
  const input = zhihuInteractionContinueInput.parse(raw),
    original = activity(readParticipationState(host.d.db), input.id),
    previous = original.attempts?.at(-1) ?? fail("原互动尝试不存在，未续排"),
    previousAutomation = original.automation,
    rebind =
      original.status === "queued" &&
      !!previousAutomation?.continuation &&
      previousAutomation.planRevision < ctx.planRevision &&
      previousAutomation.continuation.fromVersion === original.version - 1 &&
      previousAutomation.continuation.attemptId === previous.id &&
      previousAutomation.continuation.requestFingerprint ===
        previous.request.fingerprint &&
      !!original.attempts?.every(isUnsubmittedTechnicalInteractionAttempt) &&
      JSON.stringify(previousAutomation.decision) ===
        JSON.stringify(previous.decision);
  if (
    (original.status !== "failed" && !rebind) ||
    previous.id !== input.attemptId
  )
    fail("只能明确继续此准确原失败尝试，未复活已处理或未知任务");
  const continuation: ZhihuInteractionContinuation = {
    attemptId: input.attemptId,
    requestFingerprint: previous.request.fingerprint,
    fromVersion: input.version,
    at: now(),
    repair: String(cleanKnowledge(input.repair)),
  };
  const { state, item } = prepareInteraction(
    host,
    { id: input.id, version: input.version, decision: previous.decision },
    ctx,
    false,
    continuation,
  );
  const at = Date.parse(input.scheduledAt),
    gap = Math.max(60, ctx.gapMinutes) * 60000;
  if (
    at < Date.now() ||
    at > Date.now() + 7 * 86400000 ||
    (rebind &&
      (!original.scheduledAt || at < Date.parse(original.scheduledAt))) ||
    (item.attempts ?? []).some(
      (attempt) => at - Date.parse(attempt.startedAt) < gap,
    )
  )
    fail("原任务只能安排未来合法时段，旧真实尝试仍须满足至少60分钟间隔");
  item.automation = {
    planRevision: ctx.planRevision,
    decision: previous.decision,
    queuedAt: now(),
    continuation,
  };
  item.scheduledAt = new Date(at).toISOString();
  item.status = "queued";
  item.version++;
  ctx.guard();
  persist(host, state);
  log(
    host,
    "interaction.continued",
    rebind
      ? "原未提交续排已按当前授权重新绑定；旧尝试与旧授权元数据完整保留，尚未执行"
      : "技术故障已明确修复，原AI决定重新排期；旧未提交尝试完整保留，尚未执行",
    item,
    {
      scheduledAt: item.scheduledAt,
      continuation,
      planRevision: ctx.planRevision,
      rebind,
      previousAutomation: previousAutomation ?? null,
      preservedAttempts: item.attempts?.map((attempt) => attempt.id),
    },
    "warning",
  );
  host.d.changed();
  return item;
}
/** Persist one current authorized decision only; no browser, model, or attempt reservation. */
export function queueParticipationInteraction(
  host: ParticipationInteractionHost,
  raw: unknown,
  ctx: ZhihuInteractionExecutionContext,
): ZhihuParticipationActivity {
  const input = zhihuInteractionQueueInput.parse(raw),
    { state, item } = prepareInteraction(host, input, ctx, false),
    at = Date.parse(input.scheduledAt);
  if (at < Date.now() - 1000 || at > Date.now() + 7 * 86400000)
    fail("互动排期需要在当前至未来7天内，未保存无效排期");
  const previous = item.automation;
  item.automation = {
    planRevision: ctx.planRevision,
    decision: input.decision,
    queuedAt: now(),
  };
  item.scheduledAt = new Date(at).toISOString();
  item.status = "queued";
  item.version++;
  ctx.guard();
  persist(host, state);
  log(
    host,
    "interaction.queued",
    "当前授权的精确互动决策已排期；未访问网页、未创建真实尝试",
    item,
    {
      scheduledAt: item.scheduledAt,
      automation: item.automation,
      previousAutomation: previous ?? null,
    },
  );
  host.d.changed();
  return item;
}
export async function executeParticipationInteraction(
  host: ParticipationInteractionHost,
  raw: unknown,
  ctx: ZhihuInteractionExecutionContext,
): Promise<ZhihuParticipationActivity> {
  const { input, state, item, account, request, networkKey } =
      prepareInteraction(host, raw, ctx),
    port = host.d.ports.zhihuInteraction ?? fail("个人真实互动适配不可用");
  if (
    item.automation &&
    (item.automation.planRevision !== ctx.planRevision ||
      JSON.stringify(item.automation.decision) !==
        JSON.stringify(input.decision))
  )
    fail("已排期的互动决策或计划版本已变化，需要重新核对后排期");
  assertQuota(host, state, item, ctx, networkKey);
  return host.run(account.id, async () => {
    ctx.guard();
    host.account(account.id, account.uid!);
    const { state: fresh, item: current } = prepareInteraction(host, raw, ctx);
    assertQuota(host, fresh, current, ctx, networkKey);
    const attempt: ZhihuInteractionAttempt = {
      id: id("zhattempt"),
      planId: ctx.planId,
      planRevision: ctx.planRevision,
      activityVersion: input.version,
      decision: input.decision,
      request,
      networkKey,
      startedAt: now(),
      submittedAt: null,
      finishedAt: null,
      status: "running",
      receipt: null,
      error: "",
    };
    current.attempts = [...(current.attempts ?? []), attempt];
    current.status = "executing";
    current.version++;
    persist(host, fresh);
    host.d.changed();
    log(
      host,
      "interaction.started",
      "已保存原互动尝试，等待账号租约与提交前检查",
      current,
      {
        attemptId: attempt.id,
        fingerprint: request.fingerprint,
        decision: input.decision,
        networkKey,
      },
    );
    const guard = () => {
      if (host.closed()) fail("工作空间已关闭，未继续真实互动");
      const latest = readParticipationState(host.d.db),
        original = activity(latest, item.id),
        active = original.attempts?.find((entry) => entry.id === attempt.id);
      assertExact(host, latest, original, input.version + 1, ctx);
      host.account(account.id, account.uid!);
      if (
        !active ||
        active.status !== "running" ||
        active.request.fingerprint !== request.fingerprint ||
        original.draft.trim() !== item.draft.trim()
      )
        fail("原尝试或评论准确版本已变化，未继续操作");
      assertQuota(host, latest, original, ctx, networkKey, attempt.id);
    };
    try {
      const receipt = await host.d.accounts.use(
        account.id,
        "zhihu",
        async (currentAccount) => {
          guard();
          return port.execute(currentAccount, {
            request,
            guard,
            onSubmitting: () => {
              guard();
              const latest = readParticipationState(host.d.db),
                original = activity(latest, item.id),
                active = original.attempts!.find(
                  (entry) => entry.id === attempt.id,
                )!;
              if (active.submittedAt)
                fail("原尝试已记录提交意图，禁止第二次点击");
              active.submittedAt = now();
              persist(host, latest);
              log(
                host,
                "interaction.submitting",
                "已在不可逆点击之前保存提交意图，未知结果不会重试",
                original,
                { attemptId: attempt.id, submittedAt: active.submittedAt },
              );
              host.d.changed();
            },
          });
        },
        "知乎单条个人相关内容互动",
      );
      if (host.closed()) return current;
      const original = activity(readParticipationState(host.d.db), item.id),
        active = original.attempts!.find((entry) => entry.id === attempt.id)!;
      return finish(
        host,
        item.id,
        attempt.id,
        {
          receipt: validateReceipt(
            receipt,
            request,
            active.submittedAt,
            attempt.startedAt,
          ),
        },
        current,
      );
    } catch (error) {
      return finish(host, item.id, attempt.id, { error }, current);
    }
  });
}
/** Observe the original submitted attempt only. A missing result never authorizes another click. */
export async function reconcileParticipationInteraction(
  host: ParticipationInteractionHost,
  raw: unknown,
): Promise<ZhihuParticipationActivity> {
  const input = zhihuInteractionReconcileInput.parse(raw),
    state = readParticipationState(host.d.db),
    item = activity(state, input.id);
  if (item.version !== input.version || item.status !== "attention")
    fail("仅可核对此准确版本的待核对原互动任务");
  const attempt =
    item.attempts?.at(-1) ?? fail("原尝试记录不存在，未创建新的互动");
  if (!attempt.submittedAt || attempt.status !== "unknown")
    fail("此原尝试没有可核对的提交记录；不会据此重试");
  const account = host.account(item.accountId, attempt.request.actorUid),
    port = host.d.ports.zhihuInteraction ?? fail("只读核对适配不可用");
  return host.run(account.id, async () => {
    try {
      const receipt = await host.d.accounts.use(
        account.id,
        "zhihu",
        async (current) => {
          if (host.closed()) fail("工作空间已关闭");
          host.account(account.id, attempt.request.actorUid);
          return port.reconcile(current, {
            request: attempt.request,
            submittedAt: attempt.submittedAt!,
          });
        },
        "知乎原互动结果只读核对",
      );
      if (host.closed()) return item;
      if (!receipt) {
        log(
          host,
          "interaction.reconcile_unresolved",
          "官方页面尚未找到准确结果，原unknown记录保留且不会重试",
          item,
          { attemptId: attempt.id },
          "warning",
        );
        return activity(readParticipationState(host.d.db), item.id);
      }
      return finish(
        host,
        item.id,
        attempt.id,
        {
          receipt: validateReceipt(
            receipt,
            attempt.request,
            attempt.submittedAt,
            attempt.startedAt,
          ),
        },
        item,
      );
    } catch (error) {
      log(
        host,
        "interaction.reconcile_failed",
        safeMessage(error),
        item,
        { attemptId: attempt.id },
        "error",
      );
      throw error;
    }
  });
}

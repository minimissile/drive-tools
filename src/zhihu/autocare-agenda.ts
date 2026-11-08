import {
  autocareRandomCommentScope,
  autocareRandomLikeScope,
  autocareRandomFollowScope,
  type AutocareSnapshot,
} from "../../shared/zhihu-autocare";

export type AutocareAgendaState =
  "running" | "scheduled" | "waiting" | "attention" | "paused";
export type AutocareAgendaAction = "tasks" | "participation" | "account";
export interface AutocareAgendaItem {
  id: string;
  accountId: string;
  accountName: string;
  operation: string;
  detail: string;
  reason: string;
  at: string | null;
  timeLabel: string;
  state: AutocareAgendaState;
  stateLabel: string;
  /** A failed item can remain visible while other account work continues. */
  blocking?: boolean;
  action?: AutocareAgendaAction;
}

export interface AutocareDailyAccount {
  accountId: string;
  accountName: string;
  operations: { label: string; progress: string }[];
  actionSummary: string;
  progressSummary: string;
  remainingSummary: string;
  limits: string[];
  usage: string[];
  nextAt: string | null;
  nextOperation: string;
  waitingReason: string;
}
export interface AutocareDailyProgress {
  date: string;
  usageKnown: boolean;
  accounts: AutocareDailyAccount[];
}

export function getAutocareRunView(
  snapshot: AutocareSnapshot,
  at = Date.now(),
) {
  const startedAt = validTime(
    snapshot.run?.startedAt ?? snapshot.todayPlan?.startedAt,
  );
  const deadlineAt = validTime(
    snapshot.run?.deadlineAt ?? snapshot.todayPlan?.deadlineAt,
  );
  const status = snapshot.run?.status ?? snapshot.todayPlan?.runStatus ?? null;
  const supported =
    snapshot.run !== undefined || snapshot.todayPlan?.runStatus !== undefined;
  const pastDeadline = !!deadlineAt && Date.parse(deadlineAt) <= at;
  return {
    supported,
    startedAt,
    deadlineAt,
    status,
    pastDeadline,
    ended: pastDeadline || status === "completed" || status === "expired",
  };
}

const validTime = (value: string | undefined | null) =>
  value && Number.isFinite(Date.parse(value)) ? value : null;
const shanghaiDay = (value: string | number) => {
  const stamp = new Date(value).getTime();
  return Number.isFinite(stamp)
    ? new Date(stamp + 8 * 3600000).toISOString().slice(0, 10)
    : "";
};

/** The server supplies cross-mode usage. Older running backends can show only
 * verified local results; their remaining allowance is deliberately unknown. */
export function buildAutocareDailyProgress(
  snapshot: AutocareSnapshot,
  at = Date.now(),
): AutocareDailyProgress {
  const plan = snapshot.todayPlan;
  const date = plan?.date || shanghaiDay(at);
  const cfg = snapshot.config;
  const run = getAutocareRunView(snapshot, at);
  const accounts = new Map(
    snapshot.accounts.map((account) => [account.id, account]),
  );
  const planned = new Map(
    plan?.accounts.map((account) => [account.accountId, account]),
  );
  return {
    date,
    usageKnown:
      !!plan && cfg.accountIds.every((accountId) => planned.has(accountId)),
    accounts: cfg.accountIds.map((accountId) => {
      const account = accounts.get(accountId);
      const saved = planned.get(accountId);
      const published = snapshot.jobs.filter(
        (job) =>
          job.accountId === accountId &&
          job.status === "published" &&
          job.url &&
          shanghaiDay(job.updatedAt) === date,
      );
      const articleCompleted = saved?.publication.articleCompleted;
      const answerCompleted = saved?.publication.answerCompleted;
      const articles =
        articleCompleted ??
        published.filter((job) => job.kind !== "answer").length;
      const answers =
        answerCompleted ??
        published.filter((job) => job.kind === "answer").length;
      const activities = snapshot.participation.activities.filter(
        (activity) => activity.accountId === accountId,
      );
      const actorUid = snapshot.identities[accountId] ?? account?.uid;
      const performed = (kind: "like" | "comment" | "follow", scope?: string) =>
        activities.filter(
          (activity) =>
            activity.kind === kind &&
            (!scope || activity.planId === scope) &&
            activity.attempts?.some(
              (attempt) =>
                attempt.request.actorUid === actorUid &&
                attempt.receipt?.evidence === "official_ui" &&
                attempt.receipt.outcome === "performed" &&
                shanghaiDay(attempt.submittedAt ?? attempt.startedAt) === date,
            ),
        ).length;
      const operations: AutocareDailyAccount["operations"] = [];
      if (cfg.publish)
        operations.push({
          label: "发文",
          progress: `${articleCompleted === undefined ? "已记录发布" : "已发布"} ${articles} 篇`,
        });
      if (cfg.answerRecommended)
        operations.push({
          label: "回答",
          progress: `${answerCompleted === undefined ? "已记录发布" : "已发布"} ${answers} 篇`,
        });
      if (cfg.readRecommended)
        operations.push({
          label: "内容读取",
          progress: `已保存 ${snapshot.research.filter((record) => record.accountId === accountId && record.status === "saved" && shanghaiDay(record.at) === date).length} 次正文`,
        });
      if (cfg.randomLikes || cfg.likeCandidates)
        operations.push({
          label: "随机点赞",
          progress: `新增 ${performed("like")} 次`,
        });
      if (cfg.randomComments)
        operations.push({
          label: "随机评论",
          progress: `新增 ${performed("comment", autocareRandomCommentScope)} 次`,
        });
      if (cfg.followCandidates)
        operations.push({
          label: "自动关注",
          progress: `新增 ${performed("follow")} 次`,
        });
      const actionSummary = [
        ...(cfg.publish ? ["发文"] : []),
        ...(cfg.answerRecommended ? ["回答"] : []),
        ...(cfg.readRecommended ? ["读取"] : []),
        ...(cfg.randomLikes || cfg.likeCandidates ? ["随机点赞"] : []),
        ...(cfg.randomComments ? ["随机评论"] : []),
        ...(cfg.followCandidates ? ["自动关注"] : []),
      ].join("、");
      const progressSummary = [
        ...(cfg.publish
          ? [
              `${articleCompleted === undefined ? "已记录发文" : "发文"} ${articles}`,
            ]
          : []),
        ...(cfg.answerRecommended
          ? [
              `${answerCompleted === undefined ? "已记录回答" : "回答"} ${answers}`,
            ]
          : []),
        ...(cfg.randomLikes || cfg.likeCandidates
          ? [`点赞 ${performed("like")}`]
          : []),
        ...(cfg.randomComments
          ? [`评论 ${performed("comment", autocareRandomCommentScope)}`]
          : []),
        ...(cfg.readRecommended
          ? [
              `正文 ${snapshot.research.filter((record) => record.accountId === accountId && record.status === "saved" && shanghaiDay(record.at) === date).length}`,
            ]
          : []),
        ...(cfg.followCandidates ? [`关注 ${performed("follow")}`] : []),
      ].join(" · ");
      const limits: string[] = [],
        usage: string[] = [];
      if (cfg.publish || cfg.answerRecommended) {
        const limit =
          saved?.publication.limit ??
          (account
            ? Math.min(account.plan.dailyLimit, cfg.dailyLimit)
            : cfg.dailyLimit);
        limits.push(
          `发布≤${limit}${cfg.answerRecommended ? `（回答≤${Math.min(limit, cfg.answersPerDay)}）` : ""}`,
        );
        if (saved)
          usage.push(
            `发布完成 ${saved.publication.completed} 篇，已尝试 ${saved.publication.attempts} 次，剩余 ${saved.publication.remaining} 次`,
          );
      }
      if (
        cfg.randomLikes ||
        cfg.randomComments ||
        cfg.likeCandidates ||
        cfg.followCandidates
      ) {
        limits.push(
          `互动≤${saved?.interaction.limit ?? cfg.interactionDailyLimit}`,
        );
        if (saved)
          usage.push(
            `互动新增 ${saved.interaction.completed} 次，已尝试 ${saved.interaction.attempts} 次，剩余 ${saved.interaction.remaining} 次`,
          );
      }
      if (
        cfg.readRecommended ||
        cfg.answerRecommended ||
        cfg.randomLikes ||
        cfg.randomComments ||
        cfg.likeCandidates ||
        cfg.followCandidates
      ) {
        limits.push(`读取≤${saved?.research.limit ?? cfg.researchPerDay}`);
        if (saved)
          usage.push(
            `读取已用 ${saved.research.used} 次，剩余 ${saved.research.remaining} 次`,
          );
      }
      const storedPublications =
        saved?.scheduledPublications
          .filter((job) =>
            job.kind === "answer" ? cfg.answerRecommended : cfg.publish,
          )
          .map((job) => ({
            at: job.at,
            operation: job.kind === "answer" ? "发布回答" : "发布文章",
          })) ??
        snapshot.jobs
          .filter(
            (job) =>
              job.accountId === accountId &&
              job.status === "queued" &&
              (job.kind === "answer" ? cfg.answerRecommended : cfg.publish) &&
              job.scheduledAt,
          )
          .map((job) => ({
            at: job.scheduledAt!,
            operation: job.kind === "answer" ? "发布回答" : "发布文章",
          }));
      const cycle = snapshot.cycles[accountId];
      const nextCycle = saved
        ? saved.next
        : cycle
          ? { kind: cycle.kind, at: cycle.at }
          : null;
      const storedNext = [
        ...storedPublications,
        ...(nextCycle
          ? [
              {
                at: nextCycle.at,
                operation:
                  nextCycle.kind === "interaction"
                    ? "随机互动检查"
                    : nextCycle.kind === "prepare"
                      ? "发文 / 回答准备"
                      : "内容读取",
              },
            ]
          : []),
      ]
        .filter((item) => validTime(item.at))
        .sort((a, b) => a.at.localeCompare(b.at))[0];
      const beyondDeadline =
        !!storedNext &&
        !!run.deadlineAt &&
        Date.parse(storedNext.at) >= Date.parse(run.deadlineAt);
      const next =
        run.supported &&
        !!run.startedAt &&
        !!run.deadlineAt &&
        !run.ended &&
        !beyondDeadline
          ? storedNext
          : undefined;
      return {
        accountId,
        accountName: account?.nickname || account?.alias || "账号已移除",
        operations,
        actionSummary,
        progressSummary,
        remainingSummary: saved
          ? `${run.ended ? "未用额度" : "可用额度"} ${[
              ...(cfg.publish || cfg.answerRecommended
                ? [`发布 ${saved.publication.remaining}`]
                : []),
              ...(cfg.randomLikes ||
              cfg.randomComments ||
              cfg.likeCandidates ||
              cfg.followCandidates
                ? [`互动 ${saved.interaction.remaining}`]
                : []),
              ...(cfg.readRecommended ||
              cfg.answerRecommended ||
              cfg.randomLikes ||
              cfg.randomComments ||
              cfg.likeCandidates ||
              cfg.followCandidates
                ? [`读取 ${saved.research.remaining}`]
                : []),
            ].join(" · ")}`
          : "",
        limits,
        usage,
        nextAt: next?.at || null,
        nextOperation:
          next?.operation ||
          (!run.supported
            ? "两小时方案待应用"
            : !run.startedAt
              ? "尚未启动本轮"
              : run.ended
                ? "本轮已结束"
                : beyondDeadline
                  ? "原安排超过本轮截止"
                  : "尚未保存下一时段"),
        waitingReason:
          saved?.waitingReason ||
          snapshot.researchStops[accountId] ||
          snapshot.accountMessages[accountId] ||
          (run.ended
            ? "已到本轮截止，未完成项目不会延长到整日执行。"
            : beyondDeadline
              ? "原安排超出启动后2小时，本轮不会执行该项。"
              : ""),
      };
    }),
  };
}

function cycleOperation(
  snapshot: AutocareSnapshot,
  cycle: AutocareSnapshot["cycles"][string],
) {
  const cfg = snapshot.config;
  if (cycle.kind === "interaction") {
    const targets = cycle.targets.filter((target) =>
      /点赞|评论|关注/.test(target),
    );
    return (
      (targets.length
        ? targets
        : [
            ...(cfg.randomLikes || cfg.likeCandidates ? ["随机点赞"] : []),
            ...(cfg.randomComments ? ["随机评论"] : []),
            ...(cfg.followCandidates ? ["自动关注作者"] : []),
          ]
      ).join(" / ") || "随机互动"
    );
  }
  if (cycle.kind === "prepare")
    return (
      [
        ...(cfg.publish ? ["文章准备"] : []),
        ...(cfg.answerRecommended ? ["回答准备"] : []),
      ].join(" / ") || "内容准备"
    );
  return cycle.targets.length ? cycle.targets.join(" / ") : "推荐内容读取";
}

/** Projects existing records only. It never predicts a full-day schedule or
 * assigns the global busy flag to an account. */
export function buildAutocareAgenda(
  snapshot: AutocareSnapshot,
): AutocareAgendaItem[] {
  const run = getAutocareRunView(snapshot);
  const selected = new Set(snapshot.config.accountIds);
  const accounts = new Map(
    snapshot.accounts.map((account) => [account.id, account]),
  );
  const candidates = new Map(
    snapshot.participation.candidates.map((candidate) => [
      candidate.id,
      candidate,
    ]),
  );
  const names = new Map(
    snapshot.accounts.map((account) => [
      account.id,
      account.nickname || account.alias,
    ]),
  );
  type Blocker = NonNullable<AutocareSnapshot["blockers"]>[number];
  const blockers: Blocker[] = snapshot.blockers
    ? snapshot.blockers.filter((entry) => selected.has(entry.accountId))
    : [];
  if (!snapshot.blockers) {
    // Older backends have no typed causes. Prefer actual records and never send
    // a publication error to account management merely because it blocks work.
    for (const accountId of selected) {
      const account = accounts.get(accountId);
      if (!account || account.status !== "connected")
        blockers.push({
          accountId,
          kind: "account",
          message: "账号尚未连接或登录已失效，请在账号管理中处理。",
          blocking: true,
        });
      else if (
        snapshot.identities[accountId] &&
        account.uid !== snapshot.identities[accountId]
      )
        blockers.push({
          accountId,
          kind: "account",
          message: "账号身份已变化，请核对账号后重新开启。",
          blocking: true,
        });
      if (snapshot.researchStops[accountId])
        blockers.push({
          accountId,
          kind: "restriction",
          message: snapshot.researchStops[accountId],
          blocking: true,
        });
      for (const job of snapshot.jobs.filter(
        (entry) =>
          entry.accountId === accountId && entry.status === "attention",
      ))
        blockers.push({
          accountId,
          kind: job.taskId ? "publication" : "generation",
          message: job.message,
          jobId: job.id,
          taskId: job.taskId,
          blocking: snapshot.blockedAccountIds.includes(accountId),
        });
      if (
        snapshot.blockedAccountIds.includes(accountId) &&
        !blockers.some((entry) => entry.accountId === accountId)
      )
        blockers.push({
          accountId,
          kind: "configuration",
          message:
            snapshot.accountMessages[accountId] || "此账号仍有待处理事项。",
          blocking: true,
        });
    }
  }
  const blocked = new Map(
    blockers
      .filter((entry) => entry.blocking)
      .map((entry) => [entry.accountId, entry.message]),
  );
  const jobBlockers = (id: string, taskId?: string) =>
    blockers.filter(
      (entry) => entry.jobId === id || (!!taskId && entry.taskId === taskId),
    );

  const items: AutocareAgendaItem[] = [];
  const push = (item: Omit<AutocareAgendaItem, "accountName">) =>
    items.push({
      ...item,
      accountName: names.get(item.accountId) || "账号已移除",
    });
  const attentionAccounts = new Set<string>();
  for (const activity of snapshot.participation.activities) {
    if (!selected.has(activity.accountId) || activity.resolution) continue;
    const active = activity.status === "executing";
    const attention = activity.status === "attention";
    if (!active && !attention) continue;
    const attempt = activity.attempts?.at(-1);
    const cause = blockers.find((entry) => entry.activityId === activity.id);
    const blocking = cause?.blocking ?? (!snapshot.blockers && attention);
    const operation =
      activity.kind === "comment"
        ? activity.planId === autocareRandomCommentScope
          ? "随机评论"
          : "评论"
        : activity.kind === "like"
          ? activity.planId === autocareRandomLikeScope
            ? "随机点赞"
            : "点赞"
          : activity.kind === "follow"
            ? activity.planId === autocareRandomFollowScope
              ? "自动关注作者"
              : "关注作者"
            : "日常参与";
    if (attention && blocking) attentionAccounts.add(activity.accountId);
    push({
      id: `activity:${activity.id}`,
      accountId: activity.accountId,
      operation,
      detail:
        activity.context?.title ||
        candidates.get(activity.candidateId)?.title ||
        "原互动目标",
      reason: attention
        ? cause?.message ||
          attempt?.error ||
          blocked.get(activity.accountId) ||
          "原互动结果需要核对，系统不会重复提交。"
        : "正在处理已保存的准确目标，结果将在互动记录中更新。",
      at: validTime(attention ? attempt?.finishedAt : attempt?.startedAt),
      timeLabel: attention ? "最近结果" : "实际开始",
      state: attention ? "attention" : "running",
      stateLabel: attention
        ? blocking
          ? "需核对"
          : "单项未完成"
        : snapshot.enabled
          ? "执行中"
          : "正在收尾",
      action: "participation",
      blocking,
    });
  }

  for (const [index, cause] of blockers.entries()) {
    if (
      (cause.activityId &&
        snapshot.participation.activities.some(
          (activity) =>
            activity.id === cause.activityId &&
            !activity.resolution &&
            ["attention", "executing"].includes(activity.status),
        )) ||
      snapshot.jobs.some(
        (job) =>
          job.status === "attention" &&
          (job.id === cause.jobId ||
            (!!cause.taskId && job.taskId === cause.taskId)),
      ) ||
      (snapshot.commentJobs ?? []).some(
        (job) => job.status === "attention" && job.id === cause.jobId,
      )
    )
      continue;
    const action: AutocareAgendaAction | undefined =
      cause.kind === "account"
        ? "account"
        : cause.kind === "publication" ||
            cause.kind === "generation" ||
            cause.taskId
          ? "tasks"
          : cause.kind === "interaction" || cause.activityId
            ? "participation"
            : undefined;
    push({
      id: `blocker:${cause.accountId}:${index}`,
      accountId: cause.accountId,
      operation:
        cause.kind === "account"
          ? "处理账号状态"
          : cause.kind === "publication"
            ? "原发布任务未完成"
            : cause.kind === "generation"
              ? "内容准备未完成"
              : cause.kind === "interaction"
                ? "原互动结果需核对"
                : cause.kind === "restriction"
                  ? "读取或互动暂停"
                  : "运行条件需处理",
      detail: cause.blocking
        ? "后续自动任务等待此项恢复。"
        : "仅此项未完成，其他任务仍可继续。",
      reason: cause.message,
      at: null,
      timeLabel: cause.blocking ? "处理后继续" : "原任务保留",
      state: "attention",
      stateLabel: cause.blocking ? "需处理" : "单项未完成",
      action,
      blocking: cause.blocking,
    });
  }

  for (const job of snapshot.jobs) {
    if (
      !selected.has(job.accountId) ||
      !["queued", "collecting", "generating", "ready", "attention"].includes(
        job.status,
      )
    )
      continue;
    const queued = job.status === "queued";
    const active = job.status === "collecting" || job.status === "generating";
    const attention = job.status === "attention";
    const causes = jobBlockers(job.id, job.taskId);
    const blocking =
      causes.some((entry) => entry.blocking) ||
      (!snapshot.blockers && attention && blocked.has(job.accountId));
    const operationEnabled =
      job.kind === "answer"
        ? snapshot.config.answerRecommended
        : snapshot.config.publish;
    const held =
      (blocked.has(job.accountId) || attentionAccounts.has(job.accountId)) &&
      !active;
    const kind = job.kind === "answer" ? "回答" : "文章";
    push({
      id: `job:${job.id}`,
      accountId: job.accountId,
      operation: attention
        ? `${kind}${job.taskId ? "发布" : "准备"}未完成`
        : queued
          ? `发布${kind}`
          : active
            ? `${kind}${job.status === "collecting" ? "资料准备" : "生成"}`
            : `${kind}待排期`,
      detail: job.candidateId
        ? candidates.get(job.candidateId)?.title || "原内容任务"
        : "已保存的文章任务",
      reason: attention
        ? causes.map((entry) => entry.message).join("；") || job.message
        : !operationEnabled && !active
          ? "该操作已关闭，原稿保留，不会执行。"
          : held
            ? "账号需处理，原任务保留；查看上方具体原因。"
            : job.message,
      at: attention
        ? validTime(job.updatedAt)
        : queued
          ? validTime(job.scheduledAt)
          : active
            ? validTime(job.generatedAt || job.createdAt)
            : null,
      timeLabel: attention
        ? "最近结果"
        : queued
          ? "已保存排期"
          : active
            ? "本次开始"
            : "尚未排期",
      state: attention
        ? "attention"
        : active
          ? "running"
          : !operationEnabled
            ? "paused"
            : held
              ? "waiting"
              : !snapshot.enabled
                ? "paused"
                : queued
                  ? "scheduled"
                  : "waiting",
      stateLabel: attention
        ? blocking
          ? "需处理"
          : "单项未完成"
        : active
          ? snapshot.enabled && operationEnabled
            ? "准备中"
            : "正在收尾"
          : !operationEnabled
            ? "已关闭 · 原稿保留"
            : held
              ? "等待处理"
              : !snapshot.enabled
                ? "原稿保留"
                : queued
                  ? "已排期"
                  : "等待排期",
      action: attention || job.taskId ? "tasks" : undefined,
      blocking,
    });
  }

  for (const record of snapshot.research) {
    if (!selected.has(record.accountId) || record.status !== "reading")
      continue;
    const candidate = candidates.get(record.candidateId);
    push({
      id: `research:${record.id}`,
      accountId: record.accountId,
      operation:
        candidate?.kind === "question" ? "读取推荐问题" : "读取完整正文",
      detail: candidate?.title || "原内容目标",
      reason: record.message,
      at: validTime(record.at),
      timeLabel: "实际开始",
      state: "running",
      stateLabel: snapshot.enabled ? "读取中" : "正在收尾",
    });
  }

  for (const job of snapshot.commentJobs ?? []) {
    if (
      !selected.has(job.accountId) ||
      !["generating", "ready", "attention"].includes(job.status) ||
      job.activityId
    )
      continue;
    const active = job.status === "generating";
    const attention = job.status === "attention";
    const causes = jobBlockers(job.id);
    const blocking =
      causes.some((entry) => entry.blocking) ||
      (!snapshot.blockers && attention && blocked.has(job.accountId));
    push({
      id: `comment:${job.id}`,
      accountId: job.accountId,
      operation: attention
        ? "随机评论准备未完成"
        : active
          ? "随机评论生成"
          : "随机评论正文已保存",
      detail: candidates.get(job.candidateId)?.title || "原评论目标",
      reason: causes.map((entry) => entry.message).join("；") || job.message,
      at: attention
        ? validTime(job.updatedAt)
        : active
          ? validTime(job.generatedAt || job.createdAt)
          : null,
      timeLabel: attention ? "最近结果" : active ? "本次开始" : "尚未提交",
      state: attention
        ? "attention"
        : active
          ? "running"
          : !snapshot.config.randomComments || !snapshot.enabled
            ? "paused"
            : "waiting",
      stateLabel: attention
        ? blocking
          ? "需处理"
          : "单项未完成"
        : active
          ? snapshot.enabled && snapshot.config.randomComments
            ? "准备中"
            : "正在收尾"
          : !snapshot.config.randomComments || !snapshot.enabled
            ? "已关闭 · 原稿保留"
            : "正文已保存",
      action: "participation",
      blocking,
    });
  }

  for (const [accountId, cycle] of Object.entries(snapshot.cycles)) {
    if (!selected.has(accountId)) continue;
    const held = blocked.has(accountId) || attentionAccounts.has(accountId);
    const current =
      cycle.revision === snapshot.revision &&
      cycle.uid === snapshot.identities[accountId];
    push({
      id: `cycle:${cycle.id}`,
      accountId,
      operation: cycleOperation(snapshot, cycle),
      detail:
        cycle.kind === "interaction"
          ? "选一项操作；无完整正文时先读取"
          : cycle.kind === "prepare"
            ? "准备文章 / 回答，成稿后排期发布"
            : "读取内容，保存后供后续自动任务使用",
      reason: held
        ? "账号需处理，本轮安排等待恢复。"
        : !current
          ? "设置或账号已变化，等待重新安排。"
          : !snapshot.enabled
            ? "总开关已关闭，当前记录不会按时启动。"
            : "",
      at: validTime(cycle.at),
      timeLabel: "已保存时段",
      state:
        held || !current
          ? "waiting"
          : snapshot.enabled
            ? "scheduled"
            : "paused",
      stateLabel: held
        ? "等待处理"
        : !current
          ? "待重新安排"
          : snapshot.enabled
            ? "已排期"
            : "已暂停",
    });
  }

  for (const item of items) {
    if (item.state === "attention") continue;
    if (item.state === "running") {
      if (run.ended) item.stateLabel = "正在收尾";
      continue;
    }
    if (!run.supported) {
      item.state = "waiting";
      item.stateLabel = "旧版安排 · 待应用";
      item.detail = "两小时方案尚未加载，当前记录仍属于旧版安排";
    } else if (!run.startedAt && item.state !== "paused") {
      item.state = "waiting";
      item.stateLabel = "尚未启动本轮";
      item.detail = "原记录保留，开启后按两小时窗口重新安排";
    } else if (item.state !== "paused" && run.ended) {
      item.state = "paused";
      item.stateLabel = run.status === "completed" ? "本轮已结束" : "已到截止";
      item.detail = `已到本轮截止；${item.reason || "未完成内容保留，本轮不再提交"}`;
    } else if (
      item.state !== "paused" &&
      item.at &&
      run.deadlineAt &&
      Date.parse(item.at) >= Date.parse(run.deadlineAt)
    ) {
      item.state = "paused";
      item.stateLabel = "超出本轮截止";
      item.detail = "原安排超过启动后2小时，本轮不会执行该项";
    }
  }
  return items.sort((a, b) => {
    // Untimed recovery comes first; all actual times retain chronological order.
    if (!a.at || !b.at) {
      const rank = (item: AutocareAgendaItem) =>
        item.at ? 1 : item.state === "attention" ? 0 : 2;
      const difference = rank(a) - rank(b);
      if (difference) return difference;
    }
    return (
      (a.at || "").localeCompare(b.at || "") ||
      a.accountName.localeCompare(b.accountName, "zh-CN") ||
      a.id.localeCompare(b.id)
    );
  });
}

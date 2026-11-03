import { id, now, type Database } from "../database";
import { AppError, safeMessage } from "../errors";
import type { WebsiteAccounts } from "../website-accounts";
import type { BrowserEnvironments } from "../browser-environments";
import type { BrowserEnvironmentQueue } from "../browser-environment-queue";
import type { AppPorts } from "../ports";
import {
  zhihuContentInput,
  zhihuWarmingHasPromotion,
  zhihuContentForAccount,
  zhihuPolicyInput,
  zhihuQuestionId,
  zhihuReceiptUrl,
  type ZhihuContent,
  type ZhihuPlan,
  type ZhihuTask,
  type ZhihuProgress,
  type ZhihuSnapshot,
} from "../../shared/zhihu";
import { ZhihuStore } from "./store";
import { RuntimeLog } from "../runtime-log";
import { saveZhihuImage } from "./assets";
import { contentImagePath, readContentImage } from "../content-assets";
import type { SourceMaterial } from "../../shared/content-sources";
import { zhihuCounts, zhihuDue } from "./policy";

type Dependencies = {
  db: Database;
  accounts: WebsiteAccounts;
  environments: BrowserEnvironments;
  queue: BrowserEnvironmentQueue;
  ports: AppPorts;
  dataPath: string;
  changed(): void;
  clock?: () => number;
};
const fail = (message: string): never => {
  throw new AppError("ZHIHU_BLOCKED", message);
};
const ref = (id: string) => ({ kind: "website" as const, id });
export class ZhihuOperations {
  readonly store: ZhihuStore;
  readonly logs: RuntimeLog;
  private lastHeartbeatAt: string | null = null;
  private lastHeartbeat = 0;
  running = false;
  private executing = false;
  private closed = false;
  private generation = 0;
  private abort?: AbortController;
  private timer: ReturnType<typeof setInterval>;
  private time: () => number;
  constructor(private d: Dependencies) {
    this.store = new ZhihuStore(d.db);
    this.logs = new RuntimeLog(d.db, d.dataPath, "zhihu");
    this.time = d.clock ?? Date.now;
    for (const task of this.tasks())
      if (["running", "submitting"].includes(task.status))
        this.saveTask({
          ...task,
          status: "attention",
          message: "上次执行中断，请核对官方页面后登记结果；不会自动重发。",
        });
    for (const plan of this.plans())
      if (plan.active)
        this.savePlan({
          ...plan,
          active: false,
          message: "应用重启，需重新启用计划与调度。",
        });
    this.timer = setInterval(() => {
      void this.tick();
    }, 5000);
    this.timer.unref();
  }
  get isBusy() {
    return this.executing;
  }
  private tasks() {
    return this.store.list("zhihu_tasks");
  }
  private plans() {
    return this.store.list("zhihu_plans");
  }
  private saveTask(task: ZhihuTask) {
    const previous = this.tasks().find((t) => t.id === task.id);
    if (
      !previous ||
      previous.status !== task.status ||
      previous.message !== task.message
    )
      this.logs.record({
        level: task.status === "attention" ? "error" : "info",
        event: `task.${task.status}`,
        message: task.message,
        accountId: task.accountId,
        taskId: task.id,
        details: {
          title: task.title,
          firstPost: !!task.firstPost,
          scheduledAt: task.scheduledAt,
          url: task.url ?? null,
        },
      });
    this.store.save("zhihu_tasks", task.id, task);
    this.d.changed();
    return task;
  }
  private savePlan(plan: ZhihuPlan) {
    const previous = this.plans().find((p) => p.accountId === plan.accountId);
    if (
      !previous ||
      previous.active !== plan.active ||
      previous.message !== plan.message ||
      JSON.stringify(previous.progress) !== JSON.stringify(plan.progress)
    )
      this.logs.record({
        level:
          !plan.active && plan.message.startsWith("计划暂停")
            ? "warning"
            : "info",
        event: "plan.updated",
        message: plan.message,
        accountId: plan.accountId,
        details: {
          active: plan.active,
          creator: plan.progress?.creator ?? null,
          level: plan.progress?.level ?? null,
          score: plan.progress?.score ?? null,
          nextLevelScore: plan.progress?.nextLevelScore ?? null,
          scoreUpdatedOn: plan.progress?.scoreUpdatedOn ?? null,
        },
      });
    this.store.save("zhihu_plans", plan.accountId, plan);
    this.d.changed();
    return plan;
  }
  private account(accountId: string) {
    const account = this.d.accounts.get(accountId);
    if (account.provider !== "zhihu") fail("请选择知乎账号。");
    return account;
  }
  plan(accountId: string): ZhihuPlan {
    this.account(accountId);
    return (
      this.plans().find((p) => p.accountId === accountId) ?? {
        ...zhihuPolicyInput.parse({ accountId }),
        active: false,
        progress: null,
        message: "设置规则后启用养号计划",
      }
    );
  }
  snapshot(): ZhihuSnapshot {
    const tasks = this.tasks();
    return {
      running: this.running,
      busy: this.executing,
      lastHeartbeatAt: this.lastHeartbeatAt,
      logFolder: this.logs.folder,
      accounts: this.d.db
        .all<{ id: string }>(
          "SELECT id FROM website_accounts WHERE provider='zhihu' ORDER BY created_at",
        )
        .map((row) => this.d.accounts.get(row.id))
        .map((a) => {
          const env = this.d.environments.forAccount(ref(a.id));
          return {
            ...a,
            environmentName: env.name,
            engine: env.engine,
            ip: env.network?.ip ?? null,
            plan: this.plan(a.id),
            ...zhihuCounts(tasks, a.id, this.time()),
          };
        }),
      contents: this.store.list("zhihu_contents"),
      tasks,
      drafts: this.d.db.all<{ id: string; title: string }>(
        "SELECT id,title FROM drafts WHERE platform='zhihu' ORDER BY updated_at DESC LIMIT 100",
      ),
    };
  }
  saveContent(raw: unknown) {
    const input = zhihuContentInput.parse(raw),
      previous = input.id ? this.store.get("zhihu_contents", input.id) : null;
    if (
      previous &&
      this.tasks().some(
        (t) =>
          t.contentId === previous.id &&
          ["running", "submitting"].includes(t.status),
      )
    )
      fail("内容正在发布，请完成后再编辑。");
    const content: ZhihuContent = {
      ...input,
      aiAssisted: input.aiAssisted || (previous?.source?.editorial?.aiAssisted ?? false),
      id: previous?.id ?? id("zhcontent"),
      version: (previous?.version ?? 0) + 1,
      reviewed: false,
      images: previous?.images ?? [],
      source: previous?.source,
      createdAt: previous?.createdAt ?? now(),
      updatedAt: now(),
    };
    this.store.save("zhihu_contents", content.id, content);
    this.d.changed();
    return content;
  }
  saveSource(material: SourceMaterial) {
    const content = this.saveContent({
      kind: "article",
      purpose: material.source.editorial?.purpose ?? "warming",
      category: material.source.editorial?.direction.slice(0, 40) || "趣味图文",
      title: material.title,
      body: material.body,
      questionUrl: "",
      aiAssisted: material.source.editorial?.aiAssisted ?? false,
    });
    const next = {
      ...content,
      images: material.images,
      source: material.source,
    };
    this.store.save("zhihu_contents", content.id, next);
    this.d.changed();
    return next;
  }
  review(contentId: string, version: number) {
    const content = this.store.get("zhihu_contents", contentId);
    if (content.version !== version) fail("内容版本已变化，请刷新并重新审阅。");
    if (
      content.purpose === "warming" &&
      zhihuWarmingHasPromotion(content.body)
    )
      fail("养号素材包含链接或推广内容，请改为正常内容，或移除推广信息。");
    this.store.save("zhihu_contents", contentId, {
      ...content,
      reviewed: true,
    });
    this.d.changed();
    return this.store.get("zhihu_contents", contentId);
  }
  importDraft(draftId: string) {
    const draft = this.d.db.get<{ title: string; body: string }>(
      "SELECT title,body FROM drafts WHERE id=? AND platform='zhihu'",
      draftId,
    );
    if (!draft) fail("未找到知乎草稿，请先在内容工作室准备。");
    return this.saveContent({
      ...draft,
      kind: "article",
      purpose: "regular",
      category: "已有草稿",
      aiAssisted: true,
    });
  }
  async images(contentId: string) {
    const before = this.store.get("zhihu_contents", contentId);
    if (!this.d.ports.readWeiboImages)
      fail("当前环境不支持选择本地图片，请使用源码桌面窗口。");
    const files = await this.d.ports.readWeiboImages!("zhihu");
    if (!files) return before;
    if (files.length > 9) fail("每份内容最多 9 张图片。");
    const images: ZhihuContent["images"] = [];
    for (const file of files)
      images.push(await saveZhihuImage(this.d.dataPath, file.bytes, file.name));
    const current = this.store.get("zhihu_contents", contentId);
    if (
      current.version !== before.version ||
      this.tasks().some(
        (t) =>
          t.contentId === contentId &&
          ["running", "submitting"].includes(t.status),
      )
    )
      fail("内容已变化，请重新选择图片。");
    const next = {
      ...current,
      images,
      reviewed: false,
      version: current.version + 1,
      updatedAt: now(),
    };
    this.store.save("zhihu_contents", contentId, next);
    this.d.changed();
    return next;
  }
  configure(raw: unknown) {
    const input = zhihuPolicyInput.parse(raw),
      plan = this.plan(input.accountId);
    if (this.executing) fail("任务正在执行，请完成后修改规则。");
    return this.savePlan({ ...plan, ...input });
  }
  private ready(
    accountId: string,
    purpose: "warming" | "regular",
    firstPost = false,
    retryTaskId?: string,
  ) {
    const account = this.account(accountId),
      plan = this.plan(accountId);
    const env = this.d.environments.forAccount(ref(accountId));
    if (env.engine !== "bitbrowser")
      fail("知乎自动运营需要关联比特浏览器配置。");
    if (
      !account.uid ||
      account.status !== "connected" ||
      !this.d.environments.identityCurrent(ref(accountId))
    )
      fail("请先检查知乎登录身份。");
    const progress = plan.progress;
    if (firstPost) {
      if (purpose !== "warming" || progress?.creator !== false)
        return fail(
          "首篇开通仅适用于已核验为未入驻的账号，请先检查创作者状态。",
        );
    } else if (!progress?.creator || progress.level === null)
      return fail("请先入驻创作者中心，并检查或记录实际等级。");
    if (!progress) return fail("请先检查创作者状态。");
    if (new Date(progress.checkedAt).getTime() < this.time() - 7 * 86400000)
      fail("创作者状态已超过七天，请重新检查或记录。");
    if (plan.environment)
      this.d.environments.assertStamp(ref(accountId), plan.environment);
    if (plan.uid && plan.uid !== account.uid)
      fail("计划的账号身份已变化，请重新记录创作者状态。");
    if (
      this.tasks().some(
        (t) =>
          t.accountId === accountId &&
          t.status === "attention" &&
          t.id !== retryTaskId,
      )
    )
      fail("此账号有待核对的发布结果，请先登记结果。");
    if (
      !firstPost &&
      purpose === "warming" &&
      progress.level! >= plan.targetLevel
    )
      fail("账号已达到目标等级，养号结束。");
    if (
      !firstPost &&
      purpose === "regular" &&
      progress.level! < plan.targetLevel
    )
      fail("账号尚未达到目标等级，请先完成养号。");
    return account;
  }
  activate(accountId: string, active: boolean) {
    const plan = this.plan(accountId);
    if (active) this.ready(accountId, "warming");
    const next = this.savePlan({
      ...plan,
      active,
      message: active ? "已启用，等待启动调度与可用素材" : "已暂停养号计划",
    });
    if (!active)
      for (const task of this.tasks())
        if (
          task.accountId === accountId &&
          task.purpose === "warming" &&
          task.status === "queued"
        )
          this.cancel(task.id);
    return next;
  }
  private recordProgress(accountId: string, progress: ZhihuProgress) {
    const account = this.account(accountId),
      plan = this.plan(accountId);
    return this.savePlan({
      ...plan,
      progress,
      environment: this.d.environments.stamp(ref(accountId)),
      uid: account.uid ?? undefined,
    }).progress!;
  }
  record(accountId: string, creator: boolean, level: number, note: string) {
    if (this.executing) fail("请等待当前任务结束再记录等级。");
    const a = this.account(accountId);
    if (!a.uid || !this.d.environments.identityCurrent(ref(accountId)))
      fail("请先检查知乎登录身份。");
    return this.recordProgress(accountId, {
      creator,
      level,
      note,
      checkedAt: now(),
      source: "manual",
    });
  }
  async checkProgress(accountId: string, canContinue?: () => void) {
    canContinue?.();
    if (!this.d.ports.zhihu) fail("知乎浏览器适配不可用。");
    this.logs.record({
      level: "info",
      event: "progress.checking",
      message: "开始检查官方创作者状态",
      accountId,
    });
    try {
      return await this.d.accounts.use(
        accountId,
        "zhihu",
        async (account) => {
          canContinue?.();
          const progress = await this.d.ports.zhihu!.progress(account);
          canContinue?.();
          return this.recordProgress(accountId, progress);
        },
        "检查知乎创作者状态",
      );
    } catch (e) {
      this.logs.record({
        level: "error",
        event: "progress.failed",
        message: safeMessage(e),
        accountId,
      });
      throw e;
    }
  }
  enqueue(
    accountId: string,
    contentId: string,
    scheduledAt: string,
    firstPost = false,
  ) {
    const content = this.store.get("zhihu_contents", contentId);
    if (!content.reviewed) fail("请先审核当前内容版本。");
    if (!zhihuContentForAccount(content, accountId)) fail("此稿已指定其他账号，请选择原目标账号。");
    if (firstPost && content.kind !== "article")
      fail("首篇开通目前使用已审核文章。");
    if (
      firstPost &&
      this.tasks().some(
        (t) =>
          t.accountId === accountId && t.firstPost && t.status !== "cancelled",
      )
    )
      fail("此账号已有首篇开通任务，请核对结果，避免重复提交。");
    const account = this.ready(accountId, content.purpose, firstPost);
    const questionId =
      content.kind === "answer" ? zhihuQuestionId(content.questionUrl) : null;
    if (
      this.tasks().some(
        (t) =>
          t.status !== "cancelled" &&
          (t.contentId === contentId ||
            (questionId &&
              t.accountId === accountId &&
              t.questionId === questionId)),
      )
    )
      fail(
        "这份素材已排队或使用，或此账号已安排该问题的回答。请先核对历史任务。",
      );
    return this.saveTask({
      id: id("zhtask"),
      firstPost,
      accountId,
      uid: account.uid!,
      contentId,
      contentVersion: content.version,
      title: content.title,
      kind: content.kind,
      purpose: content.purpose,
      questionId,
      environment: this.d.environments.stamp(ref(accountId)),
      status: "queued",
      scheduledAt,
      message: "等待本地调度",
      createdAt: now(),
    });
  }
  scheduler(running: boolean) {
    this.running = running;
    this.logs.record({
      level: "info",
      event: running ? "scheduler.started" : "scheduler.stopped",
      message: running ? "本地调度已启动" : "本地调度已停止",
    });
    this.generation++;
    if (!running) this.abort?.abort();
    this.d.changed();
    return running;
  }
  cancel(taskId: string) {
    const task = this.store.get("zhihu_tasks", taskId);
    if (task.status !== "queued") fail("仅可取消尚未执行的任务。");
    return this.saveTask({
      ...task,
      status: "cancelled",
      message: "已取消，尚未执行发布",
    });
  }
  retry(taskId: string) {
    if (this.executing) fail("发布任务正在执行，请稍后重试。");
    const task = this.store.get("zhihu_tasks", taskId);
    if (task.status !== "attention" || task.submittedAt)
      fail(
        "仅从未进入提交阶段的暂停任务可继续；已提交或结果未知的任务请先核对回执。",
      );
    const account = this.ready(
      task.accountId,
      task.purpose,
      !!task.firstPost,
      task.id,
    );
    if (account.uid !== task.uid) fail("账号身份与原任务不一致。");
    this.d.environments.assertStamp(ref(task.accountId), task.environment);
    const content = this.store.get("zhihu_contents", task.contentId);
    if (!zhihuContentForAccount(content, task.accountId)) fail("素材指定账号与原任务不一致。");
    if (!content.reviewed || content.version !== task.contentVersion)
      fail("素材已变化，请核对后重新安排。");
    return this.saveTask({
      ...task,
      status: "queued",
      scheduledAt: new Date(this.time()).toISOString(),
      message: "已恢复未提交的原任务，继续核验后执行",
    });
  }
  resolve(
    taskId: string,
    outcome: "published" | "not_published",
    url?: string,
  ) {
    const task = this.store.get("zhihu_tasks", taskId);
    if (task.status !== "attention") fail("仅待核对任务可以登记结果。");
    const canonical = url ? zhihuReceiptUrl(url, task.kind) : null;
    if (
      outcome === "published" &&
      (!canonical ||
        (task.questionId &&
          zhihuQuestionId(canonical.split("/answer/")[0]) !== task.questionId))
    )
      fail("请填写属于本任务的知乎官方文章 / 回答链接。");
    return this.saveTask({
      ...task,
      status: outcome === "published" ? "published" : "cancelled",
      url: canonical ?? undefined,
      message:
        outcome === "published"
          ? "本人核对并登记已发布链接"
          : "本人确认未发布，可重新安排",
    });
  }
  /** Execute one existing task for the shared planner without starting auto-allocation. */
  async executeManaged(taskId: string, canContinue: () => boolean): Promise<void> {
    if (this.running || this.executing || this.closed)
      fail("知乎独立调度或任务仍在运行，请停止独立调度后由运营中心统一执行。");
    if (!canContinue()) fail("运营计划已暂停或变化，未执行发布。");
    const task = this.store.get("zhihu_tasks", taskId);
    if (task.status !== "queued") fail("仅可执行运营中心关联的待执行原任务。");
    await this.tick({ taskId, canContinue });
  }
  async tick(managed?: { taskId: string; canContinue(): boolean }) {
    if (
      (managed ? this.running || !managed.canContinue() : !this.running) ||
      this.closed || this.executing
    ) return;
    this.executing = true;
    const generation = this.generation;
    this.lastHeartbeatAt = new Date(this.time()).toISOString();
    if (this.time() - this.lastHeartbeat >= 60000) {
      this.lastHeartbeat = this.time();
      this.logs.record({
        level: "info",
        event: "scheduler.heartbeat",
        message: "调度运行正常，正在检查计划与到期任务",
        details: {
          activePlans: this.plans().filter((p) => p.active).length,
          queued: this.tasks().filter((t) => t.status === "queued").length,
        },
      });
    }
    try {
      for (const plan of managed ? [] : this.plans().filter((p) => p.active)) {
        try {
          if (
            plan.progress &&
            this.time() - new Date(plan.progress.checkedAt).getTime() >=
              86400000
          )
            await this.checkProgress(plan.accountId);
          const currentPlan = this.plan(plan.accountId);
          if (
            !currentPlan.active ||
            !this.running ||
            generation !== this.generation
          )
            continue;
          this.ready(plan.accountId, "warming");
          if (
            this.tasks().some(
              (t) =>
                t.accountId === plan.accountId &&
                ["queued", "running", "submitting", "attention"].includes(
                  t.status,
                ),
            )
          )
            continue;
          const used = new Set(
            this.tasks()
              .filter((t) => t.status !== "cancelled")
              .map((t) => t.contentId),
          );
          const content = this.store
            .list("zhihu_contents")
            .reverse()
            .find(
              (c) => c.purpose === "warming" && c.reviewed && !used.has(c.id) && zhihuContentForAccount(c, plan.accountId),
            );
          if (!content) {
            this.savePlan({
              ...currentPlan,
              active: false,
              message: "养号素材已用尽，请添加并审核素材后重新启用",
            });
            continue;
          }
          this.enqueue(
            plan.accountId,
            content.id,
            new Date(this.time()).toISOString(),
          );
        } catch (e) {
          this.savePlan({
            ...(this.plans().find((p) => p.accountId === plan.accountId) ??
              plan),
            active: false,
            message: safeMessage(e),
          });
        }
      }
      const task = this.tasks()
        .reverse()
        .filter(
          (t) =>
            t.status === "queued" &&
            (!managed || t.id === managed.taskId) &&
            new Date(t.scheduledAt).getTime() <= this.time(),
        )
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0];
      if (!task) return;
      this.abort = new AbortController();
      try {
        await this.d.queue.schedule(
          [ref(task.accountId)],
          `知乎发布 · ${task.title}`,
          async () => {
            const assertCurrent = () => {
              if (
                (managed ? this.running || !managed.canContinue() : !this.running) ||
                this.closed ||
                generation !== this.generation ||
                this.store.get("zhihu_tasks", task.id).status === "cancelled"
              )
                fail("调度已暂停，未继续提交。");
              if (managed && !this.plan(task.accountId).active)
                fail("账号养号计划已暂停，未继续提交。");
              const a = this.ready(
                task.accountId,
                task.purpose,
                task.firstPost,
              );
              if (a.uid !== task.uid) fail("账号身份与任务不一致。");
              this.d.environments.assertStamp(
                ref(task.accountId),
                task.environment,
              );
              const c = this.store.get("zhihu_contents", task.contentId);
              if (!zhihuContentForAccount(c, task.accountId)) fail("素材指定账号与当前任务不一致。");
              if (!c.reviewed || c.version !== task.contentVersion)
                fail("内容已被修改，请核对后重新排队。");
              return c;
            };
            const content = assertCurrent();
            const env = await this.d.environments.checkNetwork(
              this.d.environments.forAccount(ref(task.accountId)).id,
            );
            assertCurrent();
            const networkKey = env.network?.ip ?? "unknown";
            const due = zhihuDue(
              this.tasks(),
              task,
              this.plan(task.accountId),
              networkKey,
              this.time(),
            );
            if (due.at > this.time()) {
              this.saveTask({
                ...task,
                scheduledAt: new Date(due.at).toISOString(),
                message: due.reason,
              });
              return;
            }
            if (!this.d.ports.zhihu) fail("知乎浏览器适配不可用。");
            const images: { path: string; sha256: string }[] = [];
            for (const image of content.images) {
              const asset = {
                ...image,
                storage: image.storage ?? ("zhihu-assets" as const),
              };
              await readContentImage(this.d.dataPath, asset);
              const path = contentImagePath(this.d.dataPath, asset);
              images.push({ path, sha256: image.sha256 });
            }
            this.saveTask({
              ...task,
              networkKey,
              status: "running",
              attemptedAt: new Date(this.time()).toISOString(),
              message: "正在核验身份并填写官方编辑器",
            });
            const result = await this.d.accounts.use(
              task.accountId,
              "zhihu",
              (account) =>
                this.d.ports.zhihu!.publish(
                  account,
                  { task, content, images },
                  async () => {
                    assertCurrent();
                    this.saveTask({
                      ...this.store.get("zhihu_tasks", task.id),
                      status: "submitting",
                      submittedAt: new Date(this.time()).toISOString(),
                      message: "已记录提交意图，等待平台回执",
                    });
                  },
                  (event) =>
                    this.logs.record({
                      level: "info",
                      ...event,
                      accountId: task.accountId,
                      taskId: task.id,
                    }),
                ),
            );
            const url = zhihuReceiptUrl(result.url, task.kind);
            if (
              !url ||
              (task.questionId &&
                zhihuQuestionId(url.split("/answer/")[0]) !== task.questionId)
            )
              return fail("发布回执不完整，请核对官方页面。");
            this.saveTask({
              ...this.store.get("zhihu_tasks", task.id),
              status: "published",
              url,
              message: "已收到知乎官方发布回执",
            });
          },
          this.abort.signal,
        );
        if (
          task.firstPost &&
          this.store.get("zhihu_tasks", task.id).status === "published"
        ) {
          try {
            await this.checkProgress(task.accountId);
          } catch (error) {
            this.logs.record({
              level: "warning",
              event: "creator.refresh_failed",
              message: `首篇已发布，创作者状态刷新未完成：${safeMessage(error)}`,
              accountId: task.accountId,
              taskId: task.id,
            });
          }
        }
      } catch (error) {
        const current = this.store.get("zhihu_tasks", task.id);
        if (current.status !== "cancelled")
          this.saveTask({
            ...current,
            status: "attention",
            message: safeMessage(error),
          });
        const plan = this.plans().find((p) => p.accountId === task.accountId);
        if (plan)
          this.savePlan({
            ...plan,
            active: false,
            message: `计划暂停：${safeMessage(error)}`,
          });
      } finally {
        this.abort = undefined;
      }
    } finally {
      this.executing = false;
      if (!this.closed) this.d.changed();
    }
  }
  close() {
    if (this.running)
      this.logs.record({
        level: "warning",
        event: "scheduler.shutdown",
        message: "应用关闭或开发后台重启，调度停止；需重新启动。",
      });
    this.running = false;
    this.closed = true;
    this.generation++;
    this.abort?.abort();
    clearInterval(this.timer);
  }
}

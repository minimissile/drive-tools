import { runPublish } from "./workers/publish";
import type { BrowserEnvironments } from "../browser-environments";
import { createHash } from "node:crypto";
import { runTemplates } from "./workers/templates";
import { templateUsesAi } from "../../shared/zhidao-generation";
import { runAnswers } from "./workers/answers";
import { runCollect } from "./workers/collect";
import { runMine } from "./workers/mine";
import { z } from "zod";
import { id, now } from "../database";
import { AppError, safeMessage } from "../errors";
import { xlsx } from "../export-formats";
import { csv } from "../csv";
import type { AppPorts } from "../ports";
import type { Repository } from "../repository";
import type { AiService } from "../ai";
import type { SecretStore } from "../secrets";
import {
  operationItemEdit,
  operationItemReview,
  operationLabels,
  runStartInput,
  answerInput,
  type OperationItem,
  type OperationRun,
  type OperationKind,
  type RunStartInput,
  type OperationsSummary,
} from "../../shared/zhidao";
import { OperationsStore } from "./store";
import { ZhidaoClient, sourceFetch, type SourceFetch } from "./client";
import { extractBaiduShares } from "./parsers";
import { Pansou, pansouUrl } from "./pansou";
import { Pansoo } from "../resource-collection/pansoo";
import { Haisou } from "../resource-collection/haisou";
import type { CollectionWebSource } from "../../shared/resource-collection";
import {
  collectionDriveLabels,
  collectionDriveType,
} from "../../shared/resource-collection";
import { answerInstruction } from "./answer-prompt";
import { publicationFingerprint } from "./publishing";
import {
  zhidaoContentIssue,
  type ZhidaoPublishReceipt,
} from "../../shared/zhidao-publishing";

const qaResponse = z.object({ answer: z.string().trim().min(1).max(20000) });

/** Each run owns its checkpoint. No worker is started by a read or by startup. */
export class ZhidaoOperations {
  readonly store: OperationsStore;
  readonly client: ZhidaoClient;
  readonly pansou: Pansou;
  readonly pansoo: Pansoo;
  readonly haisou: Haisou;
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private closed = false;
  private accountPending = new Set<string>();
  private fetcher: SourceFetch;
  private pace: number;
  private verifyCopy?: (copyId: string) => Promise<void>;
  constructor(
    private repo: Repository,
    private secrets: SecretStore,
    private ai: AiService,
    private ports: AppPorts,
    private dataPath: string,
    private changed: () => void,
    options: {
      fetcher?: SourceFetch;
      pace?: number;
      verifyCopy?: (copyId: string) => Promise<void>;
      environments?: BrowserEnvironments;
      schedule?<T>(
        refs: import("../../shared/browser-environments").EnvironmentAccountRef[],
        label: string,
        action: () => Promise<T>,
        signal?: AbortSignal,
      ): Promise<T>;
    } = {},
  ) {
    this.fetcher = options.fetcher ?? sourceFetch;
    this.pace = options.pace ?? 2500;
    this.verifyCopy = options.verifyCopy;
    this.environments = options.environments;
    this.schedule = options.schedule;
    this.store = new OperationsStore(repo.db, (account) => {
      if (
        !this.environments ||
        this.environments.identityCurrent({ kind: "zhidao", id: account.id })
      )
        return account;
      return {
        ...account,
        status: "disconnected",
        bulkPermission: null,
        publishingRights: null,
        message: "环境登录或配置已变化，请重新检查知道身份和业务权益。",
      };
    });
    this.store.recover();
    this.client = new ZhidaoClient(ports.zhidaoSession);
    this.pansou = new Pansou(dataPath, ports.pansouBinary);
    this.pansoo = new Pansoo(ports.collectionWebSession);
    this.haisou = new Haisou(ports.collectionWebSession);
  }
  private environments?: BrowserEnvironments;
  private schedule?: <T>(
    refs: import("../../shared/browser-environments").EnvironmentAccountRef[],
    label: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
  get isBusy() {
    return this.active.size > 0 || this.accountPending.size > 0;
  }
  summary(): OperationsSummary {
    const counts = { mine: 0, collect: 0, answer: 0, template: 0, publish: 0 };
    for (const r of this.repo.db.all<{ kind: OperationKind; n: number }>(
      "SELECT kind,count(*) n FROM operation_runs GROUP BY kind",
    ))
      counts[r.kind] = r.n;
    return {
      runs: this.store.list().items.slice(0, 8),
      accounts: this.store.accounts(),
      counts,
      pending: this.repo.db.get<{ n: number }>(
        "SELECT count(*) n FROM operation_runs WHERE status IN ('draft','paused','failed')",
      )!.n,
      transferPending: this.repo.db.get<{ n: number }>(
        "SELECT count(*) n FROM jobs WHERE stage NOT IN ('completed','cancelled')",
      )!.n,
      aiConfigured:
        this.secrets.has("openrouter") && !!this.ai.modelFor("copy"),
      pansouConfigured: this.pansou.configured || !!this.settings().pansouUrl,
    };
  }
  settings() {
    return {
      pansouUrl: this.repo.db.setting("zhidao:pansouUrl", ""),
    };
  }
  async openCollectionSource(source: CollectionWebSource) {
    if (!this.ports.collectionWebSession)
      throw new AppError(
        "COLLECTION_WEB_UNAVAILABLE",
        "当前环境不支持网页采集会话。",
      );
    await this.ports.collectionWebSession.open(source);
    return true;
  }
  saveSettings(url: string) {
    if (this.isBusy)
      throw new AppError("JOBS_RUNNING", "请先停止运营任务，再修改采集服务。");
    this.repo.db.setSetting("zhidao:pansouUrl", url ? pansouUrl(url) : "");
    return this.settings();
  }
  async addAccount(alias: string, cookie = "", environmentId?: string) {
    const account = {
      id: id("zd"),
      alias,
      uid: "",
      nickname: "",
      status: "disconnected" as const,
      bulkPermission: null,
      checkedAt: null,
      message: "请登录后检查账号",
    };
    this.repo.db.transaction(() => {
      this.store.saveAccount(account);
      this.environments?.registerAccount(
        { kind: "zhidao", id: account.id },
        environmentId,
      );
    });
    if (cookie) {
      if (!this.ports.zhidaoSession)
        throw new AppError("SESSION_UNAVAILABLE", "当前环境不支持账号会话。");
      try {
        const action = async () => {
          this.environments?.invalidateIdentity({
            kind: "zhidao",
            id: account.id,
          });
          await this.ports.zhidaoSession!.setCookie(account.id, cookie);
        };
        if (this.environments)
          await this.environments.run(
            { kind: "zhidao", id: account.id },
            action,
          );
        else await action();
      } catch {
        // Imported cookies may share a realm with other platforms; never clear the environment.
        this.changed();
        return this.store.saveAccount({
          ...account,
          message:
            "账号已添加；Cookie 导入未完成，请使用官方登录窗口后检查身份。",
        });
      }
    }
    this.store.saveAccount(account);
    this.changed();
    return account;
  }
  assertAccountIdle(accountId: string) {
    if (this.accountPending.has(accountId))
      throw new AppError(
        "ACCOUNT_BUSY",
        "此账号正在登录、检查或清理，请等待完成。",
      );
    for (const [runId] of this.active) {
      const c = this.store.run(runId).config;
      if (
        c.accountId === accountId ||
        (Array.isArray(c.accountIds) && c.accountIds.includes(accountId))
      )
        throw new AppError(
          "ACCOUNT_BUSY",
          "此账号正在执行运营任务，请先停止任务。",
        );
    }
  }
  async login(
    accountId: string,
    page?: import("../../shared/zhidao-rights").ZhidaoAccountPage,
  ) {
    this.store.account(accountId);
    this.assertAccountIdle(accountId);
    if (!this.ports.zhidaoSession)
      throw new AppError("SESSION_UNAVAILABLE", "当前环境不支持登录窗口。");
    const ref = { kind: "zhidao" as const, id: accountId };
    const action = async () => {
      this.accountPending.add(accountId);
      try {
        this.environments?.invalidateIdentity(ref);
        await this.ports.zhidaoSession!.login(accountId, page);
      } finally {
        this.accountPending.delete(accountId);
      }
    };
    if (!this.environments) await action();
    else if (this.environments.forAccount(ref).engine === "bitbrowser")
      await this.environments.controlWindow(
        this.environments.forAccount(ref).id,
        action,
      );
    else await this.environments.run(ref, action);
    return true;
  }
  check(accountId: string) {
    const action = () => this.checkWithinEnvironment(accountId);
    return this.environments
      ? this.environments.run({ kind: "zhidao", id: accountId }, action)
      : action();
  }
  private async checkWithinEnvironment(accountId: string) {
    const old = this.store.account(accountId);
    this.assertAccountIdle(accountId);
    this.accountPending.add(accountId);
    try {
      const identity = await this.client.identity(accountId);
      if (old.uid && old.uid !== identity.uid)
        throw new AppError(
          "ACCOUNT_UID_MISMATCH",
          "当前登录身份与此账号不一致，请登录原账号或新增账号。",
        );
      if (
        this.store
          .accounts()
          .some((a) => a.id !== accountId && a.uid === identity.uid)
      )
        throw new AppError(
          "DUPLICATE_ACCOUNT",
          "此身份已在其他知道账号中，请使用原账号记录。",
        );
      this.environments?.confirm(
        { kind: "zhidao", id: accountId },
        identity.uid,
      );
      let bulkPermission: boolean | null = null;
      let publishingRights:
        import("../../shared/zhidao-publishing").ZhidaoPublishingRights | null =
        null;
      let message = "登录有效";
      try {
        const rights = await this.client.publishingRights(accountId);
        if (rights.uid && rights.uid !== identity.uid)
          throw new AppError(
            "ACCOUNT_UID_MISMATCH",
            "答主工作台身份与登录账号不一致，请重新登录检查。",
          );
        const { uid: _uid, ...safeRights } = rights;
        publishingRights = safeRights;
        bulkPermission = rights.hasPermission && !rights.isBanned;
        message = rights.isBanned
          ? "登录有效，批量上传权益受限"
          : bulkPermission
            ? `登录有效，具有批量上传权限${rights.remainingQuota === null ? "；额度暂未读取" : `，剩余额度${rights.remainingQuota}条`}`
            : "登录有效，暂无批量上传权限";
      } catch (error) {
        if (error instanceof AppError && error.code === "ACCOUNT_UID_MISMATCH")
          throw error;
        message = `登录有效；${safeMessage(error)}`;
      }
      const result = this.store.saveAccount({
        ...old,
        uid: identity.uid,
        nickname: identity.nickname,
        status: "connected",
        bulkPermission,
        publishingRights,
        checkedAt: now(),
        message,
      });
      // Keep the user's page and other platform tabs open after a read-only check.
      this.changed();
      return result;
    } catch (error) {
      if (this.closed) throw error;
      this.store.saveAccount({
        ...old,
        status: "expired",
        checkedAt: now(),
        message: safeMessage(error),
      });
      this.changed();
      throw error;
    } finally {
      this.accountPending.delete(accountId);
    }
  }
  removeAccount(accountId: string) {
    const action = () => this.removeWithinEnvironment(accountId);
    return this.environments
      ? this.environments.run({ kind: "zhidao", id: accountId }, action)
      : action();
  }
  private async removeWithinEnvironment(accountId: string) {
    this.store.account(accountId);
    this.assertAccountIdle(accountId);
    this.accountPending.add(accountId);
    try {
      if (this.closed) return false;
      this.repo.db.transaction(() => {
        this.environments?.detach({ kind: "zhidao", id: accountId });
        this.repo.db.run("DELETE FROM zhidao_accounts WHERE id=?", accountId);
      });
      this.changed();
      return true;
    } finally {
      this.accountPending.delete(accountId);
    }
  }
  private async identity(accountId: string) {
    const account = this.store.account(accountId);
    const identity = await this.client.identity(accountId);
    if (!account.uid || identity.uid !== account.uid)
      throw new AppError(
        "ACCOUNT_UID_MISMATCH",
        "请先检查百度知道账号；当前身份与任务绑定身份不一致。",
      );
    return identity;
  }
  private assertAvailable(
    kind: OperationKind,
    config: Record<string, unknown>,
  ) {
    if (this.active.size >= 3)
      throw new AppError(
        "TOO_MANY_RUNS",
        "已有三个运营任务正在运行，请稍后开始。",
      );
    for (const [runId] of this.active) {
      const r = this.store.run(runId);
      if (r.kind === kind)
        throw new AppError(
          "KIND_BUSY",
          `${operationLabels[kind]}已有任务在运行，请先停止或等待完成。`,
        );
    }
    const ids = [
      ...(typeof config.accountId === "string" && config.accountId
        ? [config.accountId]
        : []),
      ...(Array.isArray(config.accountIds) ? config.accountIds : []),
    ];
    for (const accountId of ids) {
      this.store.account(String(accountId));
      this.assertAccountIdle(String(accountId));
    }
  }
  async start(raw: RunStartInput) {
    const v = runStartInput.parse(raw);
    const config = { ...v.input };
    if (v.kind === "collect" && !v.input.zhidao)
      Object.assign(config, { accountIds: [] });
    this.assertAvailable(v.kind, config);
    if (v.kind === "publish") {
      if (
        v.input.selectionRevision &&
        v.input.selectionRevision !==
          this.publicationPreview(v.input.itemIds, v.input.accountId).revision
      )
        throw new AppError(
          "SELECTION_CHANGED",
          "所选问答已变化，请刷新并重新确认后上传。",
        );
      this.validatePublication(v.input.itemIds);
      this.assertNoDuplicatePublication(v.input.itemIds, v.input.accountId);
      if (this.store.account(v.input.accountId).status !== "connected")
        throw new AppError("AUTH_EXPIRED", "请先登录并检查发布账号。");
      Object.assign(config, { uploadMode: "batch-v1" });
    }
    if (v.kind === "template")
      for (const copyId of v.input.copyIds) this.ownTarget(copyId);
    if (
      v.kind === "answer" &&
      v.input.mode === "auto" &&
      this.store.account(v.input.accountId).status !== "connected"
    )
      throw new AppError(
        "AUTH_EXPIRED",
        "请先登录并检查百度知道账号，再开始自动答题。",
      );
    if (
      v.kind === "answer" ||
      (v.kind === "template" && templateUsesAi(v.input))
    )
      this.ai.assertTextConfigured("copy");
    const total =
      v.kind === "template"
        ? v.input.copyIds.length + v.input.resources.length
        : "itemIds" in v.input
          ? v.input.itemIds.length
          : "count" in v.input
            ? v.input.count
            : 1;
    const title =
      v.kind === "mine"
        ? `${v.input.category} · 热门挖词`
        : v.kind === "collect"
          ? `${v.input.keywords[0]}${v.input.keywords.length > 1 ? ` 等${v.input.keywords.length}词` : ""} · 资源采集`
          : v.kind === "answer"
            ? v.input.mode === "auto"
              ? "自动回答"
              : v.input.question.slice(0, 35)
            : v.kind === "publish"
              ? v.input.taskName
              : "资源问答模板";
    const run = this.store.create(v.kind, title, config, total);
    this.launch(run);
    return this.store.run(run.id);
  }
  pause(runId: string) {
    const run = this.store.run(runId);
    const active = this.active.get(runId);
    if (active) {
      active.controller.abort(new Error("用户停止"));
      return this.store.state(
        runId,
        "running",
        "正在停止，当前请求结束后保留结果…",
      );
    }
    if (run.status === "completed") return run;
    return this.store.state(runId, "paused", "任务已停止，已保留结果。");
  }
  resume(runId: string) {
    const run = this.store.run(runId);
    if (this.active.has(runId))
      throw new AppError("RUN_BUSY", "任务仍在运行或停止中。");
    if (run.status === "completed")
      throw new AppError("RUN_COMPLETED", "任务已完成，请新建任务。");
    this.assertAvailable(run.kind, run.config);
    if (run.kind === "answer") {
      answerInput.parse(run.config);
      this.ai.assertTextConfigured("copy");
    }
    if (run.kind === "template" && templateUsesAi(run.config))
      this.ai.assertTextConfigured("copy");
    if (run.kind === "publish") {
      const submitted = new Set(
        this.store
          .items(run.id)
          .filter((item) => ["submitted", "uncertain"].includes(item.status))
          .map((item) => item.key),
      );
      this.validatePublication(
        (run.config.itemIds as string[]).filter(
          (itemId) => !submitted.has(itemId),
        ),
      );
    }
    this.launch(run);
    return this.store.run(runId);
  }
  async openPublication(runId: string) {
    const run = this.store.run(runId);
    if (run.kind !== "publish" || typeof run.config.accountId !== "string")
      throw new AppError("INVALID_STATE", "此任务不是发布任务。");
    return this.login(run.config.accountId, "quota");
  }
  publicationPreview(itemIds: string[], accountId: string) {
    const errors: string[] = [];
    const contents: unknown[] = [];
    for (const itemId of itemIds) {
      try {
        this.validatePublication([itemId]);
        const item = this.store.item(itemId);
        contents.push([
          item.id,
          item.question,
          item.answer,
          item.reviewed,
          item.shareVersion,
        ]);
      } catch (error) {
        errors.push(safeMessage(error));
      }
    }
    if (!errors.length && accountId) {
      try {
        this.assertNoDuplicatePublication(itemIds, accountId);
      } catch (error) {
        errors.push(safeMessage(error));
      }
    }
    return {
      count: itemIds.length,
      errors: [...new Set(errors)],
      revision: createHash("sha256")
        .update(JSON.stringify(contents))
        .digest("hex"),
    };
  }
  async syncPublication(runId: string) {
    const run = this.store.run(runId);
    if (run.kind !== "publish" || typeof run.config.accountId !== "string")
      throw new AppError("INVALID_STATE", "此任务不是发布任务。");
    const accountId = run.config.accountId;
    this.assertAccountIdle(accountId);
    const taskIds = new Set(
      this.store
        .items(runId)
        .filter((item) => item.status === "submitted" && item.taskId)
        .map((item) => item.taskId),
    );
    if (!taskIds.size)
      throw new AppError(
        "NO_UPLOAD_RECEIPT",
        "尚无已确认的上传任务ID，请先核对上传结果。",
      );
    this.accountPending.add(accountId);
    try {
      await this.identity(accountId);
      const receipts = new Map<string, ZhidaoPublishReceipt>();
      // Search uses the original name; identity is checked before reading another account's records.
      for (let page = 1; page <= 20 && receipts.size < taskIds.size; page++) {
        const result = await this.client.uploadTasks(
          accountId,
          page,
          run.config.uploadMode === "batch-v1"
            ? String(run.config.taskName)
            : undefined,
        );
        for (const task of result.list)
          if (taskIds.has(task.id))
            receipts.set(task.id, { ...task, checkedAt: now() });
        if (page * 50 >= result.total || !result.list.length) break;
      }
      if (this.closed)
        throw new AppError(
          "SERVICE_CLOSED",
          "工作空间已关闭，请重新打开记录。",
        );
      // A read failure never clears the last confirmed audit status or changes upload checkpoints.
      const current = this.store.run(runId);
      const previous = Array.isArray(current.config.platformTasks)
        ? (current.config.platformTasks as ZhidaoPublishReceipt[])
        : [];
      const merged = new Map(
        previous
          .filter((task) => taskIds.has(task.id))
          .map((task) => [task.id, task]),
      );
      for (const [taskId, task] of receipts) merged.set(taskId, task);
      this.repo.db.transaction(() => {
        for (const item of this.store.items(runId)) {
          const task = receipts.get(item.taskId);
          if (task)
            this.store.put(runId, item.key, {
              message:
                task.status === "finished"
                  ? `本批审核完成：通过${task.successCount ?? "待确认"}条、失败${task.failCount ?? "待确认"}条；逐条结果请在答主工作台核对`
                  : task.status === "running"
                    ? "平台任务审核处理中"
                    : task.status === "pending"
                      ? "平台任务待执行"
                      : "平台审核状态待核对",
            });
        }
        this.store.config(runId, {
          ...current.config,
          platformTasks: [...merged.values()],
          platformCheckedAt: now(),
          platformMissingCount: taskIds.size - receipts.size,
          platformCheckMessage:
            receipts.size === taskIds.size
              ? "已更新平台审核记录。"
              : `有${taskIds.size - receipts.size}个平台任务暂未找到，已有记录已保留；请打开绑定账号的答主工作台核对。`,
        });
      });
      this.changed();
      return this.store.run(runId);
    } finally {
      this.accountPending.delete(accountId);
    }
  }
  private launch(run: OperationRun) {
    const controller = new AbortController();
    this.store.state(run.id, "running", "正在准备…");
    const promise = Promise.resolve()
      .then(() => this.executeInEnvironments(run, controller.signal))
      .catch((error) => {
        if (this.closed) return;
        const paused =
          controller.signal.aborted ||
          (error instanceof AppError &&
            [
              "SOURCE_VERIFICATION",
              "AUTH_EXPIRED",
              "ACCOUNT_UID_MISMATCH",
              "ANSWER_STOPPED",
              "ANSWER_FAILURES",
              "ANSWER_RESULT_UNCERTAIN",
              "AI_RATE_LIMITED",
              "AI_GENERATION_UNCERTAIN",
              "PUBLISH_RESULT_UNCERTAIN",
              "PUBLISH_QUOTA",
              "PUBLISH_BANNED",
              "NO_BULK_PERMISSION",
            ].includes(error.code));
        this.store.state(
          run.id,
          paused ? "paused" : "failed",
          controller.signal.aborted
            ? "已停止，已保留完成结果。"
            : safeMessage(error),
        );
      })
      .finally(() => {
        this.active.delete(run.id);
        if (!this.closed) this.changed();
      });
    this.active.set(run.id, { controller, promise });
    this.changed();
  }
  async settled(runId: string) {
    await this.active.get(runId)?.promise;
  }
  private progress(run: OperationRun, message: string, done?: number) {
    if (!this.closed) this.store.state(run.id, "running", message, done);
  }
  private workerContext(): import("./workers/context").WorkerContext {
    const owner = this;
    return {
      repo: this.repo,
      secrets: this.secrets,
      ai: this.ai,
      store: this.store,
      client: this.client,
      pansou: this.pansou,
      pansoo: this.pansoo,
      haisou: this.haisou,
      fetcher: this.fetcher,
      pace: this.pace,
      get closed() {
        return owner.closed;
      },
      verifyCopy: this.verifyCopy,
      progress: (run, message, done) => this.progress(run, message, done),
      settings: () => this.settings(),
      identity: (id) => this.identity(id),
      ownTarget: (id) => this.ownTarget(id),
      generateAnswer: (question, style, evidence) =>
        this.generateAnswer(question, style, evidence),
      validatePublication: (ids) => this.validatePublication(ids),
      assertNoDuplicatePublication: (ids, accountId) =>
        this.assertNoDuplicatePublication(ids, accountId),
    };
  }
  private async executeInEnvironments(run: OperationRun, signal: AbortSignal) {
    const ids = [
      ...new Set(
        [
          typeof run.config.accountId === "string" ? run.config.accountId : "",
          ...(Array.isArray(run.config.accountIds)
            ? run.config.accountIds.map(String)
            : []),
        ].filter(Boolean),
      ),
    ].sort();
    const execute = (index: number): Promise<void> => {
      if (index < ids.length && this.environments)
        return this.environments.run({ kind: "zhidao", id: ids[index] }, () =>
          execute(index + 1),
        );
      if (this.environments) {
        const stamps = run.config.environmentStamps as
          | Record<
              string,
              import("../../shared/browser-environments").EnvironmentStamp
            >
          | undefined;
        if (stamps)
          for (const accountId of ids)
            this.environments.assertStamp(
              { kind: "zhidao", id: accountId },
              stamps[accountId],
            );
        else {
          run.config.environmentStamps = Object.fromEntries(
            ids.map((accountId) => [
              accountId,
              this.environments!.stamp({ kind: "zhidao", id: accountId }),
            ]),
          );
          this.store.config(run.id, run.config);
        }
      }
      return this.execute(run, signal);
    };
    return this.schedule && ids.length
      ? this.schedule(
          ids.map((id) => ({ kind: "zhidao", id })),
          "百度知道运营任务",
          () => execute(ids.length),
          signal,
        )
      : execute(0);
  }
  private async execute(run: OperationRun, signal: AbortSignal) {
    if (run.kind === "mine") await runMine(this.workerContext(), run, signal);
    else if (run.kind === "collect")
      await runCollect(this.workerContext(), run, signal);
    else if (run.kind === "answer")
      await runAnswers(this.workerContext(), run, signal);
    else if (run.kind === "template")
      await runTemplates(this.workerContext(), run, signal);
    else await runPublish(this.workerContext(), run, signal);
    signal.throwIfAborted();
    const items = this.store.items(run.id);
    const failed = items.filter((i) =>
      ["failed", "uncertain"].includes(i.status),
    ).length;
    if (run.kind === "answer" && run.config.mode === "auto") {
      const submitted = items.filter((i) => i.status === "submitted").length;
      this.store.state(
        run.id,
        failed ? "paused" : "completed",
        `${submitted >= run.total ? "已达到本次目标" : "本轮随机取题已结束"}，已提交${submitted}/${run.total}条${failed ? `，${failed}条需要核对或重试` : ""}。提交不等于审核通过，请在官方活动页查看审核进度和发布权益。`,
        submitted,
      );
      return;
    }
    if (run.kind === "publish") {
      const submitted = items.filter(
        (item) => item.status === "submitted",
      ).length;
      this.store.state(
        run.id,
        failed ? "paused" : "completed",
        failed
          ? "部分上传结果需要核对，请处理后继续。"
          : `已提交${submitted}/${run.total}条问答；上传任务已创建，平台审核与发布结果请点击“查询平台审核”。`,
        submitted,
      );
      return;
    }
    this.store.state(
      run.id,
      failed ? "paused" : "completed",
      failed
        ? `已处理，${failed}项需要核对或重试。`
        : `已完成，${run.kind === "collect" ? `采集${items.filter((i) => !!i.link).length}条链接，保留${items.filter((i) => i.status === "skipped").length}条未命中记录` : `保留${items.length}条结果`}（目标${run.total}）。${this.store.run(run.id).message.startsWith("实际采集") ? this.store.run(run.id).message : ""}`,
      items.filter((i) => ["ready", "submitted"].includes(i.status)).length,
    );
  }
  private async generateAnswer(
    question: string,
    style: string,
    evidence: unknown = {},
  ) {
    return this.ai.resourceExport(
      "zhidao_answer",
      qaResponse,
      answerInstruction(style, evidence),
      { question, evidence },
    );
  }
  private ownTarget(copyId: string) {
    const copy = this.repo.getCopy(copyId);
    const account = this.repo.getAccount(copy.accountId);
    if (
      copy.status !== "ready" ||
      !copy.shareUrl ||
      !copy.verifiedAt ||
      !copy.shareVerifiedAt ||
      copy.ownerUid !== account.uid ||
      copy.shareOwnerUid !== account.uid ||
      !account.enabled
    )
      throw new AppError(
        "OWNERSHIP_UNVERIFIED",
        "资料需完成本人转存、分享及归属核验后才能生成模板。",
      );
    if (account.provider !== "baidu")
      throw new AppError(
        "BAIDU_REQUIRED",
        "百度知道模板当前使用已核验的本人百度网盘分享。",
      );
    return { copy, resource: this.repo.getResource(copy.resourceId) };
  }
  private validatePublication(ids: string[]) {
    for (const itemId of ids) {
      const item = this.store.item(itemId);
      if (
        !["template", "answer"].includes(this.store.run(item.runId).kind) ||
        item.status !== "ready" ||
        !item.reviewed
      )
        throw new AppError(
          "REVIEW_REQUIRED",
          "请选择已人工审核且标题不超过49字的问答。",
        );
      const issue = zhidaoContentIssue(item);
      if (issue)
        throw new AppError("INVALID_CONTENT", `${issue}，请编辑后重新审核。`);
      if (item.copyId) {
        const { copy } = this.ownTarget(item.copyId);
        if (
          copy.shareVersion !== item.shareVersion ||
          copy.shareUrl !== item.link
        )
          throw new AppError(
            "STALE_SHARE",
            "分享已更新，请重新生成并审核问答模板。",
          );
      }
    }
  }
  private assertNoDuplicatePublication(ids: string[], accountId: string) {
    const selected = new Set<string>();
    const rows = this.repo.db.all<{ data: string }>(
      "SELECT i.data FROM operation_items i JOIN operation_runs r ON r.id=i.run_id WHERE r.kind='publish' AND json_extract(r.config,'$.accountId')=? AND i.status IN ('submitted','uncertain','submitting')",
      accountId,
    );
    const history = new Set(
      rows.map((row) => {
        const item = JSON.parse(row.data) as OperationItem;
        return publicationFingerprint(item.question, item.answer);
      }),
    );
    for (const itemId of ids) {
      const source = this.store.item(itemId);
      const fingerprint = publicationFingerprint(
        source.question,
        source.answer,
      );
      if (selected.has(fingerprint))
        throw new AppError(
          "DUPLICATE_CONTENT",
          "所选问答包含重复内容，请保留一条后上传。",
        );
      selected.add(fingerprint);
      if (history.has(fingerprint))
        throw new AppError(
          "ALREADY_SUBMITTED",
          "所选问答已有提交或待核对记录，请打开原发布任务处理，避免重复上传。",
        );
    }
  }
  private referencedByActivePublication(itemId: string) {
    for (const [runId] of this.active) {
      const run = this.store.run(runId);
      if (
        run.kind === "publish" &&
        Array.isArray(run.config.itemIds) &&
        run.config.itemIds.includes(itemId)
      )
        return true;
    }
    return false;
  }
  saveItem(raw: unknown) {
    const input = operationItemEdit.parse(raw);
    const item = this.store.item(input.id);
    const run = this.store.run(item.runId);
    if (
      this.active.has(run.id) ||
      this.referencedByActivePublication(item.id) ||
      ["submitted", "uncertain"].includes(item.status)
    )
      throw new AppError("ITEM_LOCKED", "运行中或已提交的结果不能修改。");
    const changed =
      item.question !== input.question || item.answer !== input.answer;
    if (!changed && input.reviewed) {
      const issue = zhidaoContentIssue(input);
      if (issue)
        throw new AppError("REVIEW_REQUIRED", `${issue}，再确认审核。`);
    }
    return this.store.put(item.runId, item.key, {
      name: input.name,
      question: input.question,
      answer: input.answer,
      reviewed: changed ? false : input.reviewed,
      status: item.answer || input.answer ? "ready" : item.status,
    });
  }
  reviewItem(raw: unknown) {
    const input = operationItemReview.parse(raw);
    const issue = zhidaoContentIssue(input);
    if (issue) throw new AppError("REVIEW_REQUIRED", `${issue}，再确认审核。`);
    // One explicit review saves the edited content and its fresh confirmation
    // atomically. Ordinary edits still revoke the previous review.
    return this.repo.db.transaction(() => {
      const saved = this.saveItem({ ...input, reviewed: false });
      const reviewed = this.store.put(saved.runId, saved.key, {
        reviewed: true,
      });
      this.validatePublication([saved.id]);
      return reviewed;
    });
  }
  async openAnswer(itemId: string) {
    const item = this.store.item(itemId);
    const run = this.store.run(item.runId);
    const accountId = run.config.accountId;
    if (
      typeof accountId !== "string" ||
      !/^[\w-]{1,100}$/.test(item.questionId)
    )
      throw new AppError("INVALID_ANSWER", "此结果没有可打开的知道问题。");
    this.store.account(accountId);
    this.assertAccountIdle(accountId);
    if (!this.ports.zhidaoSession?.openQuestion)
      throw new AppError(
        "SESSION_UNAVAILABLE",
        "当前环境不支持打开账号问题页。",
      );
    const ref = { kind: "zhidao" as const, id: accountId };
    const action = async () => {
      this.accountPending.add(accountId);
      try {
        await this.ports.zhidaoSession!.openQuestion!(
          accountId,
          item.questionId,
        );
      } finally {
        this.accountPending.delete(accountId);
      }
    };
    if (!this.environments) await action();
    else if (this.environments.forAccount(ref).engine === "bitbrowser")
      await this.environments.controlWindow(
        this.environments.forAccount(ref).id,
        action,
      );
    else await this.environments.run(ref, action);
    return true;
  }
  resolve(itemId: string, outcome: "submitted" | "retry", remoteId = "") {
    const item = this.store.item(itemId);
    if (this.active.has(item.runId) || item.status !== "uncertain")
      throw new AppError("INVALID_STATE", "仅停止任务中的未知结果可以核对。");
    if (outcome === "submitted" && !remoteId.trim())
      throw new AppError(
        "REMOTE_ID_REQUIRED",
        "请填写平台返回的回答ID或上传任务ID。",
      );
    const kind = this.store.run(item.runId).kind;
    const group =
      kind === "publish" && item.uploadBatchId
        ? this.store
            .items(item.runId)
            .filter((entry) => entry.uploadBatchId === item.uploadBatchId)
        : [item];
    if (group.some((entry) => entry.status !== "uncertain"))
      throw new AppError("INVALID_STATE", "本批状态已变化，请刷新记录后核对。");
    this.repo.db.transaction(() => {
      for (const entry of group)
        this.store.put(entry.runId, entry.key, {
          status: outcome === "submitted" ? "submitted" : "ready",
          ...(kind === "publish"
            ? { taskId: remoteId.trim() }
            : { answerId: remoteId.trim() }),
          message:
            outcome === "submitted"
              ? "用户已核对平台结果并登记ID"
              : "用户确认平台未提交，下次继续时可重试",
        });
    });
    const resolved = this.store.item(item.id);
    const run = this.store.run(item.runId);
    if (kind === "publish") {
      const items = this.store.items(run.id);
      const submitted = items.filter(
        (entry) => entry.status === "submitted",
      ).length;
      this.store.state(
        run.id,
        submitted === run.total ? "completed" : "paused",
        submitted === run.total
          ? `已登记${submitted}条问答的上传任务ID；请查询平台审核结果。`
          : "已保存整批核对结果，可继续原发布任务。",
        submitted,
      );
    }
    if (run.kind === "answer" && run.config.mode === "auto") {
      const items = this.store.items(run.id);
      const submitted = items.filter((i) => i.status === "submitted").length;
      const completed =
        submitted >= run.total && !items.some((i) => i.status === "uncertain");
      this.store.state(
        run.id,
        completed ? "completed" : "paused",
        `${completed ? "已达到本次目标" : "已保存核对结果"}，已提交${submitted}/${run.total}条。审核通过情况以平台记录为准。`,
        submitted,
      );
    }
    return resolved;
  }
  removeItems(ids: string[]) {
    for (const itemId of ids) {
      const item = this.store.item(itemId);
      if (
        this.active.has(item.runId) ||
        this.referencedByActivePublication(item.id) ||
        ["submitted", "uncertain"].includes(item.status)
      )
        throw new AppError(
          "ITEM_LOCKED",
          "请先停止任务；已提交或未知结果需要保留核对记录。",
        );
    }
    this.repo.db.transaction(() => {
      for (const itemId of ids)
        this.repo.db.run("DELETE FROM operation_items WHERE id=?", itemId);
    });
    return true;
  }
  async export(runId: string, format: "txt" | "csv" | "xlsx") {
    const run = this.store.run(runId),
      items = this.store.items(runId);
    if (!items.length)
      throw new AppError("EMPTY_RESULTS", "暂无可导出的结果。");
    const isQa = ["answer", "template", "publish"].includes(run.kind);
    const rows = isQa
      ? [
          ["qid", "问题标题", "回答内容"],
          ...items
            .filter((i) => !!i.question && !!i.answer)
            .map((i) => [i.questionId, i.question, i.answer]),
        ]
      : run.kind === "mine"
        ? [
            ["名称", "来源", "来源链接", "证据"],
            ...items.map((i) => [
              i.name,
              i.sourceName,
              i.sourceUrl,
              i.evidence,
            ]),
          ]
        : [
            [
              "资源名称",
              "网盘链接",
              "提取码",
              "来源",
              "状态",
              "网盘类型",
              "采集渠道",
            ],
            ...items.map((i) => [
              i.name,
              i.link,
              i.code,
              i.sourceUrl,
              i.message,
              i.link ? collectionDriveLabels[collectionDriveType(i.link)] : "",
              i.sourceName,
            ]),
          ];
    if (rows.length === 1)
      throw new AppError("EMPTY_RESULTS", "暂无可导出的完整结果。");
    const bytes =
      format === "xlsx"
        ? xlsx(rows, isQa ? "问答结果" : "资源清单")
        : Buffer.from(
            format === "csv"
              ? csv(rows)
              : run.kind === "mine"
                ? items.map((i) => i.name).join("\n")
                : rows
                    .slice(1)
                    .map((r) => r.join("\n"))
                    .join("\n\n"),
          );
    return this.ports.saveFile(
      `${operationLabels[run.kind]}-${now().slice(0, 10)}.${format}`,
      bytes,
    );
  }
  targets(query = "", page = 1) {
    const where =
      "c.status='ready' AND c.share_url IS NOT NULL AND c.share_verified_at IS NOT NULL AND c.owner_uid=a.uid AND c.share_owner_uid=a.uid AND a.enabled=1 AND a.provider='baidu' AND instr(lower(r.title),lower(?))>0";
    return {
      items: this.repo.db.all<{
        copyId: string;
        title: string;
        url: string;
        provider: string;
      }>(
        `SELECT c.id copyId,r.title,c.share_url url,a.provider FROM copies c JOIN resources r ON r.id=c.resource_id JOIN accounts a ON a.id=c.account_id WHERE ${where} ORDER BY c.updated_at DESC LIMIT 25 OFFSET ?`,
        query,
        (page - 1) * 25,
      ),
      total: this.repo.db.get<{ n: number }>(
        `SELECT count(*) n FROM copies c JOIN resources r ON r.id=c.resource_id JOIN accounts a ON a.id=c.account_id WHERE ${where}`,
        query,
      )!.n,
    };
  }
  async templateSources(copyIds: string[]) {
    return Promise.all(
      copyIds.map(async (copyId) => {
        const { copy, resource } = this.ownTarget(copyId);
        return {
          title: resource.title,
          link: copy.shareUrl!,
          code: (await this.secrets.get(`share:${copyId}`)) ?? "",
          summary: resource.summary,
          image: "",
        };
      }),
    );
  }
  templatesPage(page = 1) {
    return {
      items: this.repo.db
        .all<{ data: string }>(
          "SELECT i.data FROM operation_items i JOIN operation_runs r ON r.id=i.run_id WHERE r.kind IN ('template','answer') AND i.status='ready' ORDER BY i.rowid DESC LIMIT 25 OFFSET ?",
          (page - 1) * 25,
        )
        .map((r) => JSON.parse(r.data) as OperationItem),
      total: this.repo.db.get<{ n: number }>(
        "SELECT count(*) n FROM operation_items i JOIN operation_runs r ON r.id=i.run_id WHERE r.kind IN ('template','answer') AND i.status='ready'",
      )!.n,
    };
  }
  importResources(rows: string[][]) {
    let nameCol = 0,
      linkCol = 1,
      codeCol = 2;
    const header = rows.findIndex(
      (r) =>
        r.some((c) => /名称|文件名|资源名/.test(c)) &&
        r.some((c) => /链接/.test(c)),
    );
    if (header >= 0) {
      nameCol = rows[header].findIndex((c) => /名称|文件名|资源名/.test(c));
      linkCol = rows[header].findIndex((c) => /链接/.test(c));
      const col = rows[header].findIndex((c) => /提取码|密码/.test(c));
      codeCol = col >= 0 ? col : 2;
    }
    const run = this.store.create(
      "collect",
      "导入资源表",
      { mode: "import" },
      rows.length,
    );
    let skipped = 0;
    for (const row of rows.slice(header >= 0 ? header + 1 : 0)) {
      const shares = extractBaiduShares(
        `${row[linkCol] ?? ""} 提取码：${row[codeCol] ?? ""}`,
      );
      if (!shares[0]) {
        skipped++;
        continue;
      }
      const share = shares[0];
      this.store.put(run.id, share.link.split("?")[0], {
        ...share,
        name: (row[nameCol] ?? "").slice(0, 100) || "导入资源",
        status: "ready",
        message: "文件导入，转存前检查有效性",
        sourceName: "本地资源表",
      });
    }
    const count = this.store.items(run.id).length;
    return this.store.state(
      run.id,
      "completed",
      `导入${count}条，忽略${skipped}条无效记录`,
      count,
    );
  }
  savePool(runId: string, itemIds: string[], name: string) {
    const run = this.store.run(runId);
    if (run.kind !== "mine")
      throw new AppError("INVALID_KIND", "请选择挖词结果。");
    const items = itemIds.map((itemId) => this.store.item(itemId));
    if (items.some((i) => i.runId !== runId))
      throw new AppError("INVALID_SELECTION", "选择包含其他任务的结果。");
    const poolId = id("pool");
    this.repo.db.run(
      "INSERT INTO pools(id,name,resource_id,keywords,created_at) VALUES(?,?,?,?,?)",
      poolId,
      name,
      null,
      JSON.stringify(
        items.map((i) => ({
          id: id("kw"),
          word: i.name,
          source: i.sourceName,
          platform: null,
          metrics: {},
          sourceUpdatedAt: null,
          fetchedAt: i.createdAt,
        })),
      ),
      now(),
    );
    this.changed();
    return poolId;
  }
  close() {
    this.closed = true;
    for (const [runId, value] of this.active) {
      this.store.state(
        runId,
        "paused",
        "已退出，结果已保存；重新打开后可核对并继续。",
      );
      value.controller.abort();
    }
    this.pansou.stop();
  }
}

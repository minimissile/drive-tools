import { runPublish } from "./workers/publish";
import { runTemplates } from "./workers/templates";
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
  publishInput,
  operationItemEdit,
  operationLabels,
  runStartInput,
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

const qaResponse = z.object({ answer: z.string().trim().min(1).max(20000) });

/** Each run owns its checkpoint. No worker is started by a read or by startup. */
export class ZhidaoOperations {
  readonly store: OperationsStore;
  readonly client: ZhidaoClient;
  readonly pansou: Pansou;
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
    } = {},
  ) {
    this.fetcher = options.fetcher ?? sourceFetch;
    this.pace = options.pace ?? 2500;
    this.verifyCopy = options.verifyCopy;
    this.store = new OperationsStore(repo.db);
    this.store.recover();
    this.client = new ZhidaoClient(ports.zhidaoSession);
    this.pansou = new Pansou(dataPath, ports.pansouBinary);
  }
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
    return { pansouUrl: this.repo.db.setting("zhidao:pansouUrl", "") };
  }
  saveSettings(url: string) {
    if (this.isBusy)
      throw new AppError("JOBS_RUNNING", "请先停止运营任务，再修改采集服务。");
    this.repo.db.setSetting("zhidao:pansouUrl", url ? pansouUrl(url) : "");
    return this.settings();
  }
  async addAccount(alias: string, cookie = "") {
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
    if (cookie) {
      if (!this.ports.zhidaoSession)
        throw new AppError("SESSION_UNAVAILABLE", "当前环境不支持账号会话。");
      try {
        await this.ports.zhidaoSession.setCookie(account.id, cookie);
      } catch {
        await this.ports.zhidaoSession.clear(account.id).catch(() => {});
        throw new AppError(
          "COOKIE_IMPORT_FAILED",
          "Cookie未保存，请检查格式或使用本人登录窗口。",
        );
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
  async login(accountId: string) {
    this.store.account(accountId);
    this.assertAccountIdle(accountId);
    if (!this.ports.zhidaoSession)
      throw new AppError("SESSION_UNAVAILABLE", "当前环境不支持登录窗口。");
    this.accountPending.add(accountId);
    try {
      await this.ports.zhidaoSession.login(accountId);
      return true;
    } finally {
      this.accountPending.delete(accountId);
    }
  }
  async check(accountId: string) {
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
      let bulkPermission: boolean | null = null;
      let message = "登录有效";
      try {
        bulkPermission = await this.client.permission(accountId);
        message = bulkPermission
          ? "登录有效，可使用快捷答题"
          : "登录有效，暂无快捷答题资格";
      } catch (error) {
        message = `登录有效；${safeMessage(error)}`;
      }
      const result = this.store.saveAccount({
        ...old,
        uid: identity.uid,
        nickname: identity.nickname,
        status: "connected",
        bulkPermission,
        checkedAt: now(),
        message,
      });
      await this.ports.zhidaoSession?.close(accountId);
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
  async removeAccount(accountId: string) {
    this.store.account(accountId);
    this.assertAccountIdle(accountId);
    this.accountPending.add(accountId);
    try {
      await this.ports.zhidaoSession?.clear(accountId);
      if (this.closed) return false;
      this.repo.db.run("DELETE FROM zhidao_accounts WHERE id=?", accountId);
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
    this.assertAvailable(v.kind, config);
    if (v.kind === "publish") {
      this.validatePublication(v.input.itemIds);
      this.assertNoDuplicatePublication(v.input.itemIds, v.input.accountId);
    }
    if (v.kind === "template")
      for (const copyId of v.input.copyIds) this.ownTarget(copyId);
    const total =
      "copyIds" in v.input
        ? v.input.copyIds.length
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
    if (run.kind === "publish")
      this.validatePublication(publishInput.parse(run.config).itemIds);
    this.launch(run);
    return this.store.run(runId);
  }
  private launch(run: OperationRun) {
    const controller = new AbortController();
    this.store.state(run.id, "running", "正在准备…");
    const promise = Promise.resolve()
      .then(() => this.execute(run, controller.signal))
      .catch((error) => {
        if (this.closed) return;
        const paused =
          controller.signal.aborted ||
          (error instanceof AppError &&
            [
              "SOURCE_VERIFICATION",
              "AUTH_EXPIRED",
              "ACCOUNT_UID_MISMATCH",
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
      assertNoDuplicatePublication: (ids, accountId, exceptRunId) =>
        this.assertNoDuplicatePublication(ids, accountId, exceptRunId),
    };
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
      `用中文${style}回答用户问题。第一段直接回答，提供具体依据、步骤和适用限制。仅使用输入中的事实，不伪称已经读过附件，不编造体验、数据或外链；资料不足明确说明。返回纯文本answer。`,
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
        !item.reviewed ||
        !item.question.trim() ||
        !item.answer.trim() ||
        item.question.length > 49
      )
        throw new AppError(
          "REVIEW_REQUIRED",
          "请选择已人工审核且标题不超过49字的问答。",
        );
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
  private assertNoDuplicatePublication(
    ids: string[],
    accountId: string,
    exceptRunId = "",
  ) {
    for (const itemId of ids) {
      const source = this.store.item(itemId);
      const rows = this.repo.db.all<{ data: string }>(
        "SELECT i.data FROM operation_items i JOIN operation_runs r ON r.id=i.run_id WHERE r.kind='publish' AND r.id<>? AND json_extract(r.config,'$.accountId')=? AND i.item_key=? AND i.status IN ('submitted','uncertain','submitting')",
        exceptRunId,
        accountId,
        itemId,
      );
      if (
        rows.some((row) => {
          const old = JSON.parse(row.data) as OperationItem;
          return (
            old.question === source.question && old.answer === source.answer
          );
        })
      )
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
    return this.store.put(item.runId, item.key, {
      name: input.name,
      question: input.question,
      answer: input.answer,
      reviewed: changed ? false : input.reviewed,
      status: item.answer || input.answer ? "ready" : item.status,
    });
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
    return this.store.put(item.runId, item.key, {
      status: outcome === "submitted" ? "submitted" : "ready",
      ...(kind === "publish" ? { taskId: remoteId } : { answerId: remoteId }),
      message:
        outcome === "submitted"
          ? "用户已核对平台结果并登记ID"
          : "用户确认平台未提交，下次继续时可重试",
    });
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
            ["资源名称", "网盘链接", "提取码", "来源", "状态"],
            ...items.map((i) => [
              i.name,
              i.link,
              i.code,
              i.sourceUrl,
              i.message,
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

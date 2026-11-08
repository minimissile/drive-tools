import type { z } from "zod";
import { id, type Database } from "../database";
import { AppError, safeMessage } from "../errors";
import type { Repository } from "../repository";
import type { SearchOperations } from "../search";
import type { SecretStore } from "../secrets";
import type { WebsiteAccounts } from "../website-accounts";
import type { BrowserEnvironments } from "../browser-environments";
import type { BrowserEnvironmentQueue } from "../browser-environment-queue";
import type { AppPorts } from "../ports";
import type { TiebaTopicPayload } from "../tieba/topic-types";
import type { TiebaTopicReceipt } from "../../shared/tieba-topics";
import type { TiebaPublicationRef } from "../../shared/tieba-insights";
import type {
  TiebaPublishingSnapshot,
  TiebaPublishingResource,
  tiebaPublishingSaveSchema,
  tiebaPublishingSubmitSchema,
} from "../../shared/tieba-publishing";
import { ContentSources, sameContentWord } from "../content-sources";
import { RuntimeLog } from "../runtime-log";
import {
  TiebaAutocareStore,
  tiebaFollowWriteState,
} from "../tieba-autocare/store";
import { parseShare } from "../links";
import {
  TiebaPublishingStore,
  tiebaPublishingWriteState,
  type TiebaPublishingRecord,
} from "./store";
import {
  checkResourcePost,
  topicHash,
  topicFingerprint,
  topicSurface,
} from "./policy";

type Dependencies = {
  db: Database;
  repo: Repository;
  search: Pick<SearchOperations, "assertTarget">;
  accounts: WebsiteAccounts;
  environments: BrowserEnvironments;
  queue: BrowserEnvironmentQueue;
  ports: AppPorts;
  secrets: SecretStore;
  dataPath: string;
  changed(): void;
  clock?(): number;
};
const ref = (id: string) => ({ kind: "website" as const, id });
const day = (time: number) =>
  new Date(time + 8 * 3600000).toISOString().slice(0, 10);
const hash = (draft: TiebaPublishingRecord) =>
  topicHash([
    draft.uid,
    draft.forumId,
    draft.keyword,
    draft.keywordSourceId,
    draft.title,
    draft.body,
    draft.resources,
    draft.ruleNote,
  ]);

/** Resource posting is a distinct workflow; warming topics retain their original no-link policy. */
export class TiebaPublishing {
  readonly store: TiebaPublishingStore;
  readonly logs: RuntimeLog;
  private sources: ContentSources;
  private targets: TiebaAutocareStore;
  private working = false;
  private closed = false;
  private controllers = new Set<AbortController>();
  constructor(private d: Dependencies) {
    this.store = new TiebaPublishingStore(d.db);
    this.logs = new RuntimeLog(d.db, d.dataPath, "tieba-publishing");
    this.sources = new ContentSources(d.repo, d.search);
    this.targets = new TiebaAutocareStore(d.db);
    for (const draft of this.store.drafts()) {
      if (!["ready", "submitting"].includes(draft.status)) continue;
      draft.status = draft.submittedAt ? "uncertain" : "draft";
      draft.version++;
      draft.updatedAt = this.now();
      draft.message = draft.submittedAt
        ? "上次发布中断，原结果待核对，不会重新提交。"
        : "应用已重新载入，请审阅并重新保存检查后发布。";
      this.store.save(draft);
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
      throw new AppError("TIEBA_PUBLISHING_CLOSED", "资源发帖已停止。");
  }
  private idle() {
    this.alive();
    if (this.working)
      throw new AppError(
        "TIEBA_PUBLISHING_BUSY",
        "请等待当前资源发帖操作完成。",
      );
  }
  private async operation<T>(action: () => Promise<T>) {
    this.idle();
    this.working = true;
    this.d.changed();
    try {
      return await action();
    } finally {
      this.working = false;
      if (!this.closed) this.d.changed();
    }
  }
  private account(accountId: string, uid: string) {
    const account = this.d.accounts.get(accountId);
    if (account.provider !== "tieba" || !account.uid || account.uid !== uid)
      throw new AppError(
        "TIEBA_PUBLISHING_IDENTITY",
        "原贴吧账号身份已变化，请使用原账号核实。",
      );
    if (this.d.environments.forAccount(ref(accountId)).engine !== "bitbrowser")
      throw new AppError(
        "TIEBA_PUBLISHING_ENVIRONMENT",
        "资源发帖需要账号关联的指纹浏览器环境。",
      );
    return account;
  }
  private target(targetId: string) {
    const target = this.targets.target(targetId);
    if (!target)
      throw new AppError(
        "TIEBA_PUBLISHING_TARGET",
        "目标贴吧已不存在，请先添加目标贴吧。",
      );
    const account = this.account(target.accountId, target.uid);
    this.d.environments.assertStamp(ref(account.id), target.stamp);
    if (target.paused)
      throw new AppError(
        "TIEBA_PUBLISHING_PAUSED",
        target.pauseReason || "该贴吧已暂停。",
      );
    return { target, account };
  }
  private draft(draftId: string, version?: number) {
    const draft = this.store.draft(draftId);
    if (!draft)
      throw new AppError("TIEBA_PUBLISHING_MISSING", "资源发帖草稿不存在。");
    if (version !== undefined && draft.version !== version)
      throw new AppError(
        "TIEBA_PUBLISHING_VERSION",
        "草稿已在其他窗口更新，请保留正文并重新读取。",
      );
    return draft;
  }
  private async resource(
    copyId: string,
    matchedTerms: string[] = [],
  ): Promise<TiebaPublishingResource> {
    const { copy, account } = this.d.search.assertTarget(copyId, null);
    const resource = this.d.repo.getResource(copy.resourceId);
    const parsed = parseShare(copy.shareUrl!);
    if (
      parsed.provider !== resource.provider ||
      parsed.provider !== account.provider
    )
      throw new AppError(
        "TIEBA_PUBLISHING_RESOURCE",
        "资源分享与所属网盘不一致。",
      );
    const code = await this.d.secrets.get(`share:${copy.id}`);
    this.alive();
    const fresh = this.d.search.assertTarget(copy.id, null);
    if (
      fresh.copy.shareVersion !== copy.shareVersion ||
      fresh.copy.shareUrl !== copy.shareUrl ||
      this.d.repo.getResource(resource.id).revision !== resource.revision ||
      fresh.account.uid !== account.uid
    )
      throw new AppError(
        "TIEBA_PUBLISHING_RESOURCE_CHANGED",
        "读取期间资源或分享版本已变化，请重新选择。",
      );
    if (code === null)
      throw new AppError(
        "TIEBA_PUBLISHING_RESOURCE_CODE",
        "分享提取码记录缺失，请先在资源库核实该分享。",
      );
    return {
      resourceId: resource.id,
      copyId: copy.id,
      title: resource.title,
      summary: resource.summary.slice(0, 400),
      provider: resource.provider,
      accountAlias: account.alias,
      url: parsed.url,
      code,
      resourceRevision: resource.revision,
      shareVersion: copy.shareVersion,
      matchedTerms,
    };
  }
  words(input: { query: string; source?: "all" | "history" | "pool" }) {
    this.alive();
    return this.sources.words(input);
  }
  async resources(input: { query: string }) {
    this.alive();
    const results: TiebaPublishingResource[] = [];
    const failures: string[] = [];
    for (const item of this.sources.matches({ keyword: input.query })) {
      try {
        results.push(await this.resource(item.copyId, item.matchedTerms));
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        if (error.code === "ENCRYPTION_UNAVAILABLE") throw error;
        failures.push(safeMessage(error));
      }
    }
    if (!results.length && failures.length)
      throw new AppError(
        "TIEBA_PUBLISHING_RESOURCE_UNAVAILABLE",
        `本地匹配的${failures.length}份资源暂不可用：${failures[0]}`,
      );
    return results;
  }
  snapshot(): TiebaPublishingSnapshot {
    this.alive();
    return {
      busy: this.working,
      accounts: this.d.db
        .all<{ id: string }>(
          "SELECT id FROM website_accounts WHERE provider='tieba' ORDER BY created_at",
        )
        .map((row) => this.d.accounts.get(row.id)),
      targets: this.targets
        .targets()
        .map(({ stamp: _stamp, ...target }) => target),
      drafts: this.store
        .drafts()
        .map(
          ({
            stamp: _stamp,
            payloadHash: _hash,
            lastMutationAt: _last,
            ...draft
          }) => draft,
        ),
      logs: this.logs.read({}),
      message: this.working
        ? "正在处理资源发帖"
        : "本地选词、选资源和编辑不会调用付费接口，发布由你明确触发。",
    };
  }
  private event(event: string, draft: TiebaPublishingRecord) {
    if (!this.closed)
      this.logs.record({
        event,
        message: draft.message,
        accountId: draft.accountId,
        taskId: draft.id,
        level: draft.status === "uncertain" ? "warning" : "info",
      });
  }
  async save(input: z.infer<typeof tiebaPublishingSaveSchema>) {
    return this.operation(async () => {
      const { target } = this.target(input.targetId);
      const old = input.id ? this.draft(input.id, input.version) : null;
      if (
        old &&
        (!input.version ||
          old.submittedAt ||
          !["draft", "ready"].includes(old.status))
      )
        throw new AppError(
          "TIEBA_PUBLISHING_NOT_EDITABLE",
          "已提交的原稿只能核对，不可修改后重新发出。",
        );
      if (
        old &&
        (old.targetId !== target.id ||
          old.accountId !== target.accountId ||
          old.uid !== target.uid ||
          old.forumId !== target.forumId)
      )
        throw new AppError(
          "TIEBA_PUBLISHING_TARGET_CHANGED",
          "编辑原稿不能切换账号或贴吧，请另建草稿。",
        );
      if (
        input.keywordSourceId !== "manual" &&
        !this.words({
          query: input.keyword,
          source: input.keywordSourceId.startsWith("pool:")
            ? "pool"
            : "history",
        }).some(
          (word) =>
            word.id === input.keywordSourceId &&
            sameContentWord(word.word) === sameContentWord(input.keyword),
        )
      )
        throw new AppError(
          "TIEBA_PUBLISHING_KEYWORD",
          "所选流量词来源已变化，请重新选择或明确使用手工词。",
        );
      const resources = [];
      for (const copyId of new Set(input.copyIds))
        resources.push(await this.resource(copyId));
      this.alive();
      this.target(target.id);
      if (old) this.draft(old.id, old.version);
      const draft: TiebaPublishingRecord = {
        id: old?.id ?? id("tiebapublishing"),
        targetId: target.id,
        accountId: target.accountId,
        uid: target.uid,
        forumId: target.forumId,
        forumName: target.name,
        keyword: input.keyword,
        keywordSourceId: input.keywordSourceId,
        resources,
        title: input.title,
        body: input.body,
        ruleNote: input.ruleNote,
        version: (old?.version ?? 0) + 1,
        status: "draft",
        checks: [],
        message: "草稿已保存。",
        submittedAt: null,
        receipt: null,
        createdAt: old?.createdAt ?? this.now(),
        updatedAt: this.now(),
        stamp: this.d.environments.stamp(ref(target.accountId)),
        payloadHash: "",
        lastMutationAt: null,
      };
      try {
        draft.checks = checkResourcePost(draft);
        draft.status = "ready";
        draft.message = "草稿已保存，可直接发布当前版本。";
      } catch (error) {
        draft.message = safeMessage(error);
      }
      draft.payloadHash = hash(draft);
      this.store.save(draft);
      this.event("resource-post.saved", draft);
      return { ...this.snapshot(), savedDraftId: draft.id };
    });
  }
  private context(draft: TiebaPublishingRecord) {
    const { target, account } = this.target(draft.targetId);
    if (
      target.uid !== draft.uid ||
      target.accountId !== draft.accountId ||
      target.forumId !== draft.forumId ||
      target.name !== draft.forumName
    )
      throw new AppError(
        "TIEBA_PUBLISHING_TARGET_CHANGED",
        "原稿账号或目标贴吧发生变化，请重新保存检查。",
      );
    this.d.environments.assertStamp(ref(account.id), draft.stamp);
    if (hash(draft) !== draft.payloadHash)
      throw new AppError(
        "TIEBA_PUBLISHING_CHANGED",
        "原稿内容已变化，请重新保存检查。",
      );
    checkResourcePost(draft);
    return account;
  }
  private async allowed(draft: TiebaPublishingRecord, afterCheckpoint = false) {
    const account = this.context(draft);
    const stored = this.draft(draft.id, draft.version);
    if (
      stored.payloadHash !== draft.payloadHash ||
      stored.status !== "submitting"
    )
      throw new AppError(
        "TIEBA_PUBLISHING_CHANGED",
        "发布版本已变化，未继续提交。",
      );
    for (const selected of draft.resources) {
      const current = await this.resource(selected.copyId);
      if (
        current.resourceRevision !== selected.resourceRevision ||
        current.shareVersion !== selected.shareVersion ||
        current.url !== selected.url ||
        current.code !== selected.code
      )
        throw new AppError(
          "TIEBA_PUBLISHING_RESOURCE_CHANGED",
          "资源或分享版本已变化，请重新插入链接并保存检查。",
        );
    }
    this.alive();
    this.context(draft);
    const state = tiebaPublishingWriteState(this.d.db, draft.uid, draft.id);
    const follow = tiebaFollowWriteState(this.d.db, draft.uid);
    if (
      state.uncertain ||
      follow.uncertain ||
      this.d.db.get(
        "SELECT id FROM tieba_topic_drafts WHERE uid=? AND status IN ('submitting','uncertain','pending_review') LIMIT 1",
        draft.uid,
      ) ||
      this.d.db.get(
        "SELECT id FROM tieba_reply_drafts WHERE uid=? AND status IN ('submitting','uncertain') LIMIT 1",
        draft.uid,
      ) ||
      this.d.db.get(
        "SELECT id FROM tieba_autocare_tasks WHERE json_extract(data,'$.accountId')=? AND day=? AND status IN ('submitting','uncertain') LIMIT 1",
        draft.accountId,
        day(this.time()),
      )
    )
      throw new AppError(
        "TIEBA_PUBLISHING_UNCERTAIN",
        "此账号仍有贴吧操作结果待核对，请先核对原结果。",
      );
    const fingerprint = topicFingerprint(draft.body);
    if (
      this.store
        .drafts()
        .some(
          (item) =>
            item.id !== draft.id &&
            item.submittedAt &&
            topicFingerprint(item.body) === fingerprint,
        ) ||
      this.d.db
        .all<{ data: string }>(
          "SELECT data FROM tieba_topic_drafts WHERE submitted_at IS NOT NULL",
        )
        .some(
          (row) =>
            topicFingerprint(
              (JSON.parse(row.data) as { body: string }).body,
            ) === fingerprint,
        )
    )
      throw new AppError(
        "TIEBA_PUBLISHING_DUPLICATE",
        "相同正文已有账号提交，不重复发布，请根据目标贴吧重新编辑内容。",
      );
    const latest = this.d.db.get<{ at: string | null }>(
      "SELECT MAX(at) at FROM (SELECT submitted_at at FROM tieba_autocare_tasks UNION ALL SELECT submitted_at at FROM tieba_reply_drafts UNION ALL SELECT submitted_at at FROM tieba_topic_drafts)",
    )?.at;
    const last = [latest, state.lastMutationAt, follow.lastMutationAt]
      .filter((value): value is string => !!value)
      .sort()
      .at(-1);
    if (last && Date.parse(last) + 60000 > this.time())
      throw new AppError(
        "TIEBA_PUBLISHING_INTERVAL",
        "距离上次贴吧提交不足60秒，请稍后明确发布。",
      );
    if (draft.submittedAt && !afterCheckpoint)
      throw new AppError(
        "TIEBA_PUBLISHING_CHECKPOINT",
        "原稿已有提交检查点，仅可核对，不能再次发布。",
      );
    return account;
  }
  private payload(draft: TiebaPublishingRecord): TiebaTopicPayload {
    return {
      forumId: draft.forumId,
      forumName: draft.forumName,
      title: draft.title,
      body: draft.body,
      aiGenerated: false,
      images: [],
    };
  }
  private browser() {
    if (!this.d.ports.tiebaTopics)
      throw new AppError(
        "TIEBA_PUBLISHING_UNAVAILABLE",
        "当前后台尚未加载资源发帖，请应用更新后继续。",
      );
    return this.d.ports.tiebaTopics;
  }
  private exact(draft: TiebaPublishingRecord, receipt: TiebaTopicReceipt) {
    try {
      const url = new URL(receipt.url ?? "");
      const at = Date.parse(receipt.checkedAt);
      return (
        !!draft.submittedAt &&
        receipt.status === "verified" &&
        receipt.forumId === draft.forumId &&
        /^[1-9]\d{0,19}$/.test(receipt.threadId ?? "") &&
        /^[1-9]\d{0,19}$/.test(receipt.postId ?? "") &&
        url.origin === "https://tieba.baidu.com" &&
        !url.username &&
        !url.password &&
        !url.port &&
        url.pathname === `/p/${receipt.threadId}` &&
        url.searchParams.getAll("pid").length === 1 &&
        url.searchParams.get("pid") === receipt.postId &&
        (!url.hash ||
          url.hash === `#${receipt.postId}` ||
          url.hash === `#post_${receipt.postId}`) &&
        receipt.authorUid === draft.uid &&
        topicSurface(receipt.title ?? "") === topicSurface(draft.title) &&
        topicSurface(receipt.body ?? "") === topicSurface(draft.body) &&
        receipt.images.length === 0 &&
        Number.isFinite(at) &&
        at >= Date.parse(draft.submittedAt) &&
        at <= this.time() + 5000
      );
    } catch {
      return false;
    }
  }
  private receipt(draft: TiebaPublishingRecord, receipt: TiebaTopicReceipt) {
    draft.receipt = receipt;
    const at = Date.parse(receipt.checkedAt);
    draft.status = this.exact(draft, receipt)
      ? "verified"
      : draft.submittedAt &&
          receipt.status === "pending_review" &&
          receipt.forumId === draft.forumId &&
          Number.isFinite(at) &&
          at >= Date.parse(draft.submittedAt) &&
          at <= this.time() + 5000
        ? "pending_review"
        : draft.submittedAt
          ? "uncertain"
          : "draft";
    draft.message =
      draft.status === "verified"
        ? "官网已核实本账号、主题和完整首帖正文，可在帖子统计中刷新官网数据。"
        : draft.status === "pending_review"
          ? "官网提示审核中，保留原记录，可只读核对。"
          : draft.submittedAt
            ? "原发布结果尚未核实，仅可只读核对，不会重复发布。"
            : "未取得官网提交检查点，未记作发布成功，请重新检查。";
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
        () => {
          this.alive();
          return action();
        },
        controller.signal,
      );
    } finally {
      this.controllers.delete(controller);
    }
  }
  private async verify(accountId: string, uid: string) {
    const result = await this.d.accounts.verify(accountId);
    this.alive();
    if (result.status !== "connected" || result.uid !== uid)
      throw new AppError(
        "TIEBA_PUBLISHING_LOGIN",
        result.message || "请先核实原贴吧账号登录。",
      );
    return this.account(accountId, uid);
  }
  async submit(input: z.infer<typeof tiebaPublishingSubmitSchema>) {
    return this.operation(async () => {
      let draft = this.draft(input.id, input.version);
      if (!input.confirmed || draft.status !== "ready" || draft.submittedAt)
        throw new AppError(
          "TIEBA_PUBLISHING_CONFIRM",
          "当前版本尚未就绪，请先检查稿件；已提交记录只能核对，不能重复发布。",
        );
      this.context(draft);
      this.browser();
      const previous = draft.version;
      draft = {
        ...draft,
        status: "submitting",
        version: previous + 1,
        updatedAt: this.now(),
        message: "等待账号环境，尚未提交官网。",
      };
      this.d.db.transaction(() => {
        const original = this.draft(draft.id, previous);
        if (original.status !== "ready" || original.submittedAt)
          throw new AppError(
            "TIEBA_PUBLISHING_VERSION",
            "原稿已被其他操作领取。",
          );
        this.store.save(draft);
      });
      try {
        await this.queued(
          draft.accountId,
          `发布资源 · ${draft.title}`,
          async () => {
            const account = await this.verify(draft.accountId, draft.uid);
            await this.allowed(draft);
            const result = await this.browser().publish(
              account,
              draft.uid,
              this.payload(draft),
              async () => {
                await this.allowed(draft);
                if (this.draft(draft.id, draft.version).submittedAt)
                  throw new AppError(
                    "TIEBA_PUBLISHING_CHECKPOINT",
                    "原稿已有提交检查点，禁止再次发布。",
                  );
                draft.submittedAt = this.now();
                draft.lastMutationAt = draft.submittedAt;
                draft.updatedAt = this.now();
                draft.message =
                  "已保存原发布检查点，等待官网回执；未知结果不会重复发出。";
                this.store.save(draft);
                this.event("resource-post.submitting", draft);
                this.d.changed();
              },
              async () => {
                await this.allowed(draft, true);
                const current = this.draft(draft.id, draft.version);
                if (
                  !current.submittedAt ||
                  current.submittedAt !== draft.submittedAt
                )
                  throw new AppError(
                    "TIEBA_PUBLISHING_CHECKPOINT",
                    "原发布检查点已变化，停止提交。",
                  );
                draft.lastMutationAt = this.now();
                draft.updatedAt = this.now();
                this.store.save(draft);
              },
            );
            this.alive();
            this.receipt(draft, result);
          },
        );
      } catch (error) {
        if (this.closed) throw error;
        draft.status = draft.submittedAt ? "uncertain" : "draft";
        draft.message = safeMessage(error);
      }
      this.alive();
      draft.updatedAt = this.now();
      this.store.save(draft);
      this.event("resource-post.submitted", draft);
      return this.snapshot();
    });
  }
  async reconcile(input: { id: string }) {
    return this.operation(async () => {
      const draft = this.draft(input.id);
      if (
        !draft.submittedAt ||
        !["uncertain", "pending_review"].includes(draft.status)
      )
        throw new AppError(
          "TIEBA_PUBLISHING_RECONCILE",
          "仅可核对已提交未知或审核中的原记录。",
        );
      this.account(draft.accountId, draft.uid);
      const stamp = this.d.environments.stamp(ref(draft.accountId));
      await this.queued(
        draft.accountId,
        `核对资源帖 · ${draft.title}`,
        async () => {
          this.d.environments.assertStamp(ref(draft.accountId), stamp);
          const account = await this.verify(draft.accountId, draft.uid);
          this.d.environments.assertStamp(ref(draft.accountId), stamp);
          const receipt = await this.browser().reconcile(
            account,
            draft.uid,
            this.payload(draft),
            draft.submittedAt!,
            draft.receipt,
          );
          this.alive();
          this.d.environments.assertStamp(ref(draft.accountId), stamp);
          this.receipt(draft, receipt);
          draft.version++;
          draft.updatedAt = this.now();
          this.store.save(draft);
          this.event("resource-post.reconciled", draft);
        },
      );
      return this.snapshot();
    });
  }
  publications(): TiebaPublicationRef[] {
    return this.store
      .drafts()
      .filter(
        (draft) =>
          !!draft.submittedAt &&
          ["verified", "uncertain", "pending_review"].includes(draft.status),
      )
      .map((draft) => ({
        id: draft.id,
        kind: "topic",
        accountId: draft.accountId,
        uid: draft.uid,
        forumId: draft.forumId,
        forumName: draft.forumName,
        threadId: draft.receipt?.threadId ?? null,
        postId: draft.receipt?.postId ?? null,
        title: draft.title,
        url: draft.receipt?.url ?? null,
        body: draft.body,
        submittedAt: draft.submittedAt!,
        submissionStatus: draft.status as
          "verified" | "uncertain" | "pending_review",
      }));
  }
  dispose() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
  }
}

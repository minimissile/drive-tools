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
import { saveContentImage, readContentImage } from "../content-assets";
import { TiebaAutocareStore } from "../tieba-autocare/store";
import { officialTiebaImage } from "../tieba/topic-page";
import type { WebsiteAccount } from "../../shared/website-accounts";
import type {
  TiebaTopicPayload,
  TiebaTopicPublisher,
} from "../tieba/topic-types";
import type {
  TiebaTopicsSnapshot,
  TiebaTopicReceipt,
  tiebaTopicSaveSchema,
  tiebaTopicRuleSchema,
  tiebaTopicGenerateSchema,
  tiebaTopicSubmitSchema,
  tiebaTopicImagePickSchema,
  tiebaTopicImageRemoveSchema,
} from "../../shared/tieba-topics";
import {
  TiebaTopicStore,
  type TopicRecord,
  type TopicGeneration,
} from "./store";
import {
  checkTopic,
  assertTopicSource,
  topicHash,
  topicSurface,
  topicFingerprint,
  generatedTopicSchema,
  topicInstruction,
} from "./policy";

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
  readImages?(): Promise<{ name: string; bytes: Buffer }[] | null>;
  clock?(): number;
};
const editable = (d: TopicRecord) =>
  !d.submittedAt && ["draft", "ready", "failed"].includes(d.status);
const payloadHash = (d: TopicRecord) =>
  topicHash({
    uid: d.uid,
    forumId: d.forumId,
    title: d.title,
    body: d.body,
    source: d.source,
    images: d.images.map((i) => i.sha256),
    ruleVersion: d.ruleVersion,
    aiGenerated: d.aiGenerated ?? !!d.model,
  });

/** Local drafting is separate from explicit, versioned paid work and publication. */
export class TiebaTopics {
  readonly store: TiebaTopicStore;
  readonly logs: RuntimeLog;
  private targets: TiebaAutocareStore;
  private working = false;
  private closed = false;
  private controllers = new Set<AbortController>();
  constructor(private d: Dependencies) {
    this.store = new TiebaTopicStore(d.db);
    this.targets = new TiebaAutocareStore(d.db);
    this.logs = new RuntimeLog(d.db, d.dataPath, "tieba-topics");
    for (const draft of this.store.drafts()) {
      if (draft.status === "generating") {
        draft.status = "attention";
        draft.message = "上次生成中断，费用与结果待核对，不自动重试。";
      } else if (draft.status === "submitting") {
        draft.status = draft.submittedAt ? "uncertain" : "draft";
        draft.message = draft.submittedAt
          ? "原主题可能已提交，仅可只读核对。"
          : "提交前中断，请重新检查原稿。";
      } else continue;
      draft.version++;
      draft.updatedAt = this.now();
      this.store.save(draft);
    }
    for (const g of this.store.generations())
      if (g.status === "reserved") {
        g.status = "uncertain";
        g.message = "生成可能已计费，不自动重试。";
        this.store.saveGeneration(g);
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
      throw new AppError("TIEBA_TOPICS_CLOSED", "主题工作已停止。");
  }
  private idle() {
    this.alive();
    if (this.working)
      throw new AppError("TIEBA_TOPICS_BUSY", "请等待当前主题操作完成后继续。");
  }
  private browser(): TiebaTopicPublisher {
    const browser = this.d.ports.tiebaTopics;
    if (!browser)
      throw new AppError(
        "TIEBA_TOPICS_UNAVAILABLE",
        "主题官网适配器尚未加载，请应用更新后重试。",
      );
    return browser;
  }
  private account(accountId: string, uid: string) {
    const a = this.d.accounts.get(accountId);
    if (a.provider !== "tieba" || !a.uid || a.uid !== uid)
      throw new AppError("TIEBA_TOPIC_IDENTITY", "原贴吧账号身份已变化。");
    if (this.d.environments.forAccount(ref(a.id)).engine !== "bitbrowser")
      throw new AppError(
        "TIEBA_TOPIC_ENVIRONMENT",
        "主题操作需要原账号的指纹浏览器环境。",
      );
    return a;
  }
  private target(targetId: string, writing = true) {
    const t = this.targets.target(targetId);
    if (!t) throw new AppError("TIEBA_TOPIC_TARGET", "目标贴吧已不存在。");
    const a = this.account(t.accountId, t.uid);
    this.d.environments.assertStamp(ref(a.id), t.stamp);
    if (writing && t.paused)
      throw new AppError(
        "TIEBA_TOPIC_PAUSED",
        t.pauseReason || "此目标贴吧已暂停。",
      );
    return { target: t, account: a };
  }
  private draft(id: string, version?: number) {
    const d = this.store.draft(id);
    if (!d) throw new AppError("TIEBA_TOPIC_MISSING", "主题草稿已不存在。");
    if (version !== undefined && d.version !== version)
      throw new AppError(
        "TIEBA_TOPIC_VERSION",
        "草稿已在其他窗口更新，请重新读取。",
      );
    return d;
  }
  private draftContext(d: TopicRecord) {
    const { target, account } = this.target(d.targetId);
    this.d.environments.assertStamp(ref(account.id), d.stamp);
    if (
      target.uid !== d.uid ||
      target.accountId !== d.accountId ||
      target.forumId !== d.forumId ||
      target.name !== d.forumName
    )
      throw new AppError(
        "TIEBA_TOPIC_TARGET_CHANGED",
        "原主题的账号或贴吧已变化。",
      );
    return { target, account };
  }
  private prepare(d: TopicRecord) {
    const rule = this.store.rule(d.targetId);
    d.ruleVersion = rule?.version ?? 0;
    d.contentHash = topicFingerprint(d.body);
    d.payloadHash = payloadHash(d);
    d.checks = [];
    try {
      d.checks = checkTopic(d, rule);
      d.status = "ready";
      d.message = "草稿已保存并通过程序检查，请审阅后明确发布。";
    } catch (e) {
      d.status = "draft";
      d.message = safeMessage(e);
    }
    return d;
  }
  private event(
    event: string,
    message: string,
    draft?: TopicRecord,
    warning = false,
  ) {
    if (!this.closed)
      this.logs.record({
        event,
        message,
        accountId: draft?.accountId,
        taskId: draft?.id,
        level: warning ? "warning" : "info",
      });
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
  private async queued<T>(
    a: WebsiteAccount,
    label: string,
    action: () => Promise<T>,
  ) {
    this.alive();
    const c = new AbortController();
    this.controllers.add(c);
    try {
      return await this.d.queue.schedule(
        [ref(a.id)],
        label,
        async () => {
          this.alive();
          return action();
        },
        c.signal,
      );
    } catch (e) {
      if (
        !this.closed &&
        e instanceof AppError &&
        /LIMIT|CAPTCHA|VERIF|FREQUENT|IDENTITY|LOGIN/.test(e.code)
      ) {
        for (const t of this.targets.targets())
          if (t.accountId === a.id)
            this.targets.saveTarget({
              ...t,
              paused: true,
              pauseReason: safeMessage(e),
            });
      }
      throw e;
    } finally {
      this.controllers.delete(c);
    }
  }
  private async verify(a: WebsiteAccount) {
    const result = await this.d.accounts.verify(a.id);
    this.alive();
    if (result.status !== "connected" || result.uid !== a.uid)
      throw new AppError("TIEBA_TOPIC_LOGIN", "原账号登录状态需要重新核验。");
    return this.account(a.id, a.uid!);
  }
  snapshot(): TiebaTopicsSnapshot {
    this.alive();
    return {
      busy: this.working,
      accounts: this.d.db
        .all<{ id: string }>(
          "SELECT id FROM website_accounts WHERE provider='tieba' ORDER BY created_at",
        )
        .map((r) => this.d.accounts.get(r.id)),
      targets: this.targets.targets().map(({ stamp: _s, ...t }) => t),
      rules: this.store.rules(),
      drafts: this.store
        .drafts()
        .map(
          ({
            stamp: _s,
            payloadHash: _p,
            contentHash: _c,
            ruleVersion: _r,
            lastMutationAt: _m,
            history: _h,
            ...d
          }) => d,
        ),
      logs: this.logs.read({}),
      message: this.working
        ? "正在处理主题"
        : "手动保存、AI创作和官网发布分别由明确操作触发。",
    };
  }
  save(input: z.infer<typeof tiebaTopicSaveSchema>) {
    this.idle();
    const { target } = this.target(input.targetId);
    let draft: TopicRecord;
    if (input.id) {
      draft = this.draft(input.id, input.version);
      if (!input.version || !editable(draft))
        throw new AppError(
          "TIEBA_TOPIC_NOT_EDITABLE",
          "此版本正在处理或已提交，仅可核对原结果。",
        );
      if (
        draft.targetId !== target.id ||
        draft.accountId !== target.accountId ||
        draft.uid !== target.uid ||
        draft.forumId !== target.forumId
      )
        throw new AppError(
          "TIEBA_TOPIC_TARGET_CHANGED",
          "已有草稿不能改换目标贴吧。",
        );
      draft.history.push({
        version: draft.version,
        title: draft.title,
        body: draft.body,
        at: draft.updatedAt,
      });
      draft.version++;
    } else {
      if (input.version)
        throw new AppError("TIEBA_TOPIC_VERSION", "新草稿不应携带旧版本。");
      draft = {
        id: id("tiebatopic"),
        targetId: target.id,
        accountId: target.accountId,
        uid: target.uid,
        forumId: target.forumId,
        forumName: target.name,
        title: "",
        body: "",
        source: input.source,
        images: [],
        version: 1,
        status: "draft",
        checks: [],
        model: null,
        generationAttempts: 0,
        aiGenerated: false,
        submittedAt: null,
        receipt: null,
        message: "",
        createdAt: this.now(),
        updatedAt: this.now(),
        stamp: target.stamp,
        payloadHash: "",
        contentHash: "",
        ruleVersion: 0,
        history: [],
      };
    }
    draft.title = input.title;
    draft.body = input.body;
    draft.source = input.source;
    draft.forumName = target.name;
    draft.stamp = target.stamp;
    draft.updatedAt = this.now();
    this.prepare(draft);
    this.store.save(draft);
    this.event("topic.saved", draft.message, draft);
    this.d.changed();
    return { ...this.snapshot(), savedDraftId: draft.id };
  }
  saveRule(input: z.infer<typeof tiebaTopicRuleSchema>) {
    this.idle();
    this.target(input.targetId);
    if (!input.confirmed)
      throw new AppError(
        "TIEBA_TOPIC_RULE_REQUIRED",
        "请明确确认已核对本吧发布规则。",
      );
    const old = this.store.rule(input.targetId);
    if ((old?.version ?? 0) !== input.version)
      throw new AppError(
        "TIEBA_TOPIC_RULE_VERSION",
        "本吧规则已在其他窗口更新。",
      );
    this.d.db.transaction(() => {
      this.store.saveRule({
        targetId: input.targetId,
        version: input.version + 1,
        note: input.note,
        allowImages: input.allowImages,
        checkedAt: this.now(),
      });
      for (const d of this.store.drafts())
        if (d.targetId === input.targetId && editable(d)) {
          d.status = "draft";
          d.version++;
          d.checks = [];
          d.message = "本吧发布规则已更新，请保存并重新检查原稿。";
          d.updatedAt = this.now();
          this.store.save(d);
        }
    });
    this.d.changed();
    return this.snapshot();
  }
  async pickImages(input: z.infer<typeof tiebaTopicImagePickSchema>) {
    return this.operation(async () => {
      const draft = this.draft(input.id, input.version);
      if (!editable(draft))
        throw new AppError("TIEBA_TOPIC_NOT_EDITABLE", "此主题不可修改配图。");
      this.draftContext(draft);
      if (!this.d.readImages)
        throw new AppError(
          "TIEBA_TOPIC_PICKER",
          "当前环境不支持选择本地图片。",
        );
      const chosen = await this.d.readImages();
      this.alive();
      if (!chosen) return this.snapshot();
      const current = this.draft(draft.id, draft.version);
      this.draftContext(current);
      if (!editable(current))
        throw new AppError("TIEBA_TOPIC_NOT_EDITABLE", "选择期间草稿已变化。");
      if (current.images.length + chosen.length > 6)
        throw new AppError("TIEBA_TOPIC_IMAGES", "每篇主题最多6张本地图片。");
      const images = [];
      for (const file of chosen) {
        if (!file.bytes.length || file.bytes.length >= 10 * 1024 * 1024)
          throw new AppError("TIEBA_TOPIC_IMAGES", "每张图片须小于10MB。");
        images.push({
          id: id("tiebatopicimage"),
          ...(await saveContentImage(this.d.dataPath, file.bytes, file.name)),
        });
        this.alive();
      }
      if (
        new Set([...current.images, ...images].map((i) => i.sha256)).size !==
        current.images.length + images.length
      )
        throw new AppError("TIEBA_TOPIC_IMAGES", "同一图片不能重复添加。");
      current.images.push(...images);
      current.version++;
      current.updatedAt = this.now();
      this.prepare(current);
      this.store.save(current);
      this.d.changed();
      return this.snapshot();
    });
  }
  removeImage(input: z.infer<typeof tiebaTopicImageRemoveSchema>) {
    this.idle();
    const d = this.draft(input.id, input.version);
    if (!editable(d))
      throw new AppError("TIEBA_TOPIC_NOT_EDITABLE", "此主题不可修改配图。");
    this.draftContext(d);
    if (!d.images.some((i) => i.id === input.imageId))
      throw new AppError("TIEBA_TOPIC_IMAGES", "原图片已不存在。");
    d.images = d.images.filter((i) => i.id !== input.imageId);
    d.version++;
    d.updatedAt = this.now();
    this.prepare(d);
    this.store.save(d);
    this.d.changed();
    return this.snapshot();
  }
  async image(input: { id: string; imageId: string }) {
    this.alive();
    const d = this.draft(input.id),
      i = d.images.find((i) => i.id === input.imageId);
    if (!i) throw new AppError("TIEBA_TOPIC_IMAGES", "图片已不存在。");
    const bytes = await readContentImage(this.d.dataPath, i);
    this.alive();
    return `data:${i.file.endsWith(".png") ? "image/png" : "image/jpeg"};base64,${bytes.toString("base64")}`;
  }
  async generate(input: z.infer<typeof tiebaTopicGenerateSchema>) {
    return this.operation(async () => {
      const d = this.draft(input.id, input.version);
      if (!input.confirmed || !input.rightsConfirmed || !editable(d))
        throw new AppError(
          "TIEBA_TOPIC_GENERATE_CONFIRM",
          "请确认资料与图片的使用权后明确生成。",
        );
      this.draftContext(d);
      assertTopicSource(d.source);
      const rule = this.store.rule(d.targetId);
      if (!rule)
        throw new AppError(
          "TIEBA_TOPIC_RULE_REQUIRED",
          "请先保存本吧发布规则。",
        );
      if (d.images.length && !rule.allowImages)
        throw new AppError("TIEBA_TOPIC_IMAGES", "本吧规则不允许当前配图。");
      if (
        d.generationAttempts >= 2 ||
        this.store
          .generations()
          .filter((g) => g.createdAt >= dayStart(this.time())).length >= 4
      )
        throw new AppError(
          "TIEBA_TOPIC_GENERATION_LIMIT",
          "主题生成已达到本稿2次或今日4次上限，未知请求也计入。",
        );
      this.d.ai.assertTextConfigured("copy");
      d.model = this.d.ai.modelFor("copy");
      d.ruleVersion = rule.version;
      d.payloadHash = payloadHash(d);
      const originalHash = d.payloadHash;
      d.status = "generating";
      d.version++;
      d.generationAttempts++;
      d.updatedAt = this.now();
      d.message = "正在生成可编辑草稿，尚未提交官网。";
      const g: TopicGeneration = {
        id: id("tiebatopicgen"),
        draftId: d.id,
        status: "reserved",
        createdAt: this.now(),
        message: d.message,
      };
      this.d.db.transaction(() => {
        this.store.save(d);
        this.store.saveGeneration(g);
      });
      this.d.changed();
      const phase = `tieba_topic:${g.id}`;
      let received = false;
      try {
        const result = await this.d.ai.resourceExport(
          phase,
          generatedTopicSchema,
          topicInstruction,
          {
            source: d.source,
            rule: rule.note,
            forumName: d.forumName,
            images: d.images.map((i) => ({ name: i.name })),
          },
          [],
          {
            maxTokens: 5000,
            schemaName: "tieba_topic",
            model: d.model!,
            retainResponse: true,
            beforeRequest: () => {
              this.alive();
              this.draftContext(d);
              if (
                this.draft(d.id, d.version).status !== "generating" ||
                this.store.rule(d.targetId)?.version !== rule.version ||
                payloadHash(d) !== originalHash
              )
                throw new AppError(
                  "TIEBA_TOPIC_CONTEXT_CHANGED",
                  "资料或吧规已变化，未发起新生成。",
                );
            },
          },
        );
        this.alive();
        received = true;
        d.aiGenerated = true;
        g.status = "success";
        d.history.push({
          version: d.version,
          title: d.title,
          body: d.body,
          at: d.updatedAt,
        });
        d.title = result.title;
        d.body = result.body;
        this.draftContext(d);
        if (this.store.rule(d.targetId)?.version !== rule.version)
          throw new AppError(
            "TIEBA_TOPIC_RULE_VERSION",
            "生成期间规则已变化，结果保留待检查。",
          );
        if (!result.publishable)
          throw new AppError(
            "TIEBA_TOPIC_GENERATION_REFUSED",
            result.reason || "资料不适合生成主题，结果保留供编辑。",
          );
        if (
          !result.evidence.length ||
          result.evidence.some(
            (q) => !topicSurface(d.source.body).includes(topicSurface(q)),
          )
        )
          throw new AppError(
            "TIEBA_TOPIC_EVIDENCE",
            "AI返回的引用无法在源资料逐字核对，正文保留供编辑。",
          );
        this.prepare(d);
      } catch (e) {
        if (this.closed) throw e;
        const call = this.d.db.get<{ status: string }>(
          "SELECT status FROM api_calls WHERE phase=? ORDER BY created_at DESC LIMIT 1",
          phase,
        );
        const unknown =
          !received &&
          (call?.status === "uncertain" ||
            call?.status === "reserved" ||
            (!(e instanceof AppError) && !call));
        g.status = received ? "success" : unknown ? "uncertain" : "failed";
        d.status = received ? "draft" : unknown ? "attention" : "failed";
        d.checks = [];
        d.message = `${safeMessage(e)}${received ? "；已生成内容已保留。" : unknown ? "；费用待核对，不自动重试。" : "；未发布官网。"}`;
      }
      this.alive();
      d.payloadHash = payloadHash(d);
      d.contentHash = topicFingerprint(d.body);
      d.updatedAt = this.now();
      g.message = d.message;
      this.d.db.transaction(() => {
        this.store.save(d);
        this.store.saveGeneration(g);
      });
      this.event("topic.generated", d.message, d, d.checks.length === 0);
      return this.snapshot();
    });
  }
  private allowed(d: TopicRecord, afterCheckpoint = false) {
    const { account } = this.draftContext(d);
    const rule = this.store.rule(d.targetId);
    checkTopic(d, rule);
    if (
      rule?.version !== d.ruleVersion ||
      payloadHash(d) !== d.payloadHash ||
      topicFingerprint(d.body) !== d.contentHash
    )
      throw new AppError(
        "TIEBA_TOPIC_CONTEXT_CHANGED",
        "原稿、资料或规则已变化，请重新保存检查。",
      );
    if (
      this.store
        .drafts()
        .some(
          (o) =>
            o.id !== d.id &&
            o.uid === d.uid &&
            ["submitting", "uncertain", "pending_review"].includes(o.status),
        )
    )
      throw new AppError(
        "TIEBA_TOPIC_UNCERTAIN_BLOCK",
        "此账号还有主题结果待核对。",
      );
    if (
      this.d.db.get(
        "SELECT id FROM tieba_reply_drafts WHERE uid=? AND status IN ('submitting','uncertain') LIMIT 1",
        d.uid,
      ) ||
      this.d.db.get(
        "SELECT id FROM tieba_autocare_tasks WHERE json_extract(data,'$.accountId')=? AND day=? AND status IN ('submitting','uncertain') LIMIT 1",
        d.accountId,
        businessDay(this.time()),
      )
    )
      throw new AppError(
        "TIEBA_TOPIC_UNCERTAIN_BLOCK",
        "此账号仍有签到或回帖结果未知，请先核对。",
      );
    if (
      this.store
        .drafts()
        .some(
          (o) =>
            o.id !== d.id &&
            o.contentHash === d.contentHash &&
            (!!o.submittedAt || o.status === "submitting"),
        )
    )
      throw new AppError(
        "TIEBA_TOPIC_DUPLICATE",
        "此正文已有账号提交或正在提交，不重复发布。",
      );
    const resourcePosting = tiebaPublishingWriteState(this.d.db, d.uid);
    const follow = tiebaFollowWriteState(this.d.db, d.uid);
    if (resourcePosting.uncertain || follow.uncertain)
      throw new AppError(
        "TIEBA_PUBLISHING_UNCERTAIN_BLOCK",
        "该账号仍有关注或资源发帖结果待核对，请先处理原记录。",
      );
    const latest = this.d.db.get<{ at: string | null }>(
      "SELECT MAX(at) at FROM (SELECT submitted_at at FROM tieba_autocare_tasks UNION ALL SELECT submitted_at at FROM tieba_reply_drafts UNION ALL SELECT submitted_at at FROM tieba_topic_drafts WHERE id<>?)",
      afterCheckpoint ? d.id : "",
    )?.at;
    const lastMutation = Math.max(
      Date.parse(latest ?? "") || 0,
      Date.parse(resourcePosting.lastMutationAt ?? "") || 0,
      Date.parse(follow.lastMutationAt ?? "") || 0,
    );
    if (lastMutation && lastMutation + 60000 > this.time())
      throw new AppError(
        "TIEBA_TOPIC_INTERVAL",
        "距离上次贴吧提交不足60秒，请稍后明确发布。",
      );
    if (
      this.store
        .drafts()
        .some(
          (o) =>
            o.id !== d.id &&
            o.uid === d.uid &&
            o.submittedAt &&
            (o.lastMutationAt ?? o.submittedAt) >= dayStart(this.time()),
        )
    )
      throw new AppError(
        "TIEBA_TOPIC_DAILY_LIMIT",
        "此账号今日已达1次主题提交上限，未知尝试也计入。",
      );
    return account;
  }
  private async payload(d: TopicRecord): Promise<TiebaTopicPayload> {
    const images = [];
    for (const i of d.images) {
      const bytes = await readContentImage(this.d.dataPath, i);
      this.alive();
      if (bytes.length >= 10 * 1024 * 1024)
        throw new AppError("TIEBA_TOPIC_IMAGES", "原图片超过10MB。");
      images.push({
        name: i.name,
        sha256: i.sha256,
        mime: i.file.endsWith(".png")
          ? ("image/png" as const)
          : ("image/jpeg" as const),
        bytes,
      });
    }
    return {
      forumId: d.forumId,
      forumName: d.forumName,
      title: d.title,
      body: d.body,
      aiGenerated: d.aiGenerated ?? !!d.model,
      images,
    };
  }
  private exact(d: TopicRecord, r: TiebaTopicReceipt) {
    try {
      const u = new URL(r.url ?? "");
      return (
        !!d.submittedAt &&
        r.status === "verified" &&
        r.forumId === d.forumId &&
        /^[1-9]\d{0,19}$/.test(r.threadId ?? "") &&
        /^[1-9]\d{0,19}$/.test(r.postId ?? "") &&
        u.origin === "https://tieba.baidu.com" &&
        !u.username &&
        !u.password &&
        !u.port &&
        u.pathname === `/p/${r.threadId}` &&
        u.searchParams.getAll("pid").length === 1 &&
        u.searchParams.get("pid") === r.postId &&
        (!u.hash ||
          u.hash === `#${r.postId}` ||
          u.hash === `#post_${r.postId}`) &&
        r.authorUid === d.uid &&
        topicSurface(r.title ?? "") === topicSurface(d.title) &&
        topicSurface(r.body ?? "") === topicSurface(d.body) &&
        r.images.length === d.images.length &&
        d.images.every(
          (i) =>
            r.images.filter(
              (v) => v.sha256 === i.sha256 && !!officialTiebaImage(v.url),
            ).length === 1,
        ) &&
        Number.isFinite(Date.parse(r.checkedAt)) &&
        Date.parse(r.checkedAt) >= Date.parse(d.submittedAt)
      );
    } catch {
      return false;
    }
  }
  async submit(input: z.infer<typeof tiebaTopicSubmitSchema>) {
    return this.operation(async () => {
      let d = this.draft(input.id, input.version);
      if (
        !input.confirmed ||
        !input.rightsConfirmed ||
        d.status !== "ready" ||
        d.submittedAt
      )
        throw new AppError(
          "TIEBA_TOPIC_NOT_READY",
          "请审阅准确版本并确认使用权，已提交记录只能核对。",
        );
      const account = this.allowed(d);
      this.browser();
      const previous = d.version;
      d = {
        ...d,
        status: "submitting",
        version: d.version + 1,
        message: "等待原账号环境，尚未提交。",
        updatedAt: this.now(),
      };
      this.d.db.transaction(() => {
        this.allowed(d);
        if (!this.store.claim(d, previous))
          throw new AppError("TIEBA_TOPIC_VERSION", "草稿已被其他操作领取。");
      });
      try {
        await this.queued(account, `发布主题 · ${d.title}`, async () => {
          const verified = await this.verify(account);
          this.allowed(d);
          const payload = await this.payload(d);
          this.alive();
          const receipt = await this.browser().publish(
            verified,
            d.uid,
            payload,
            async () => {
              this.alive();
              this.allowed(d);
              const stored = this.draft(d.id, d.version);
              if (stored.status !== "submitting" || stored.submittedAt)
                throw new AppError(
                  "TIEBA_TOPIC_ALREADY_SUBMITTED",
                  "已有提交检查点，禁止再次上传或点击。",
                );
              d.submittedAt = this.now();
              d.updatedAt = this.now();
              d.message =
                "已保存提交检查点，等待官网结果；结果未知时不会重放。";
              this.store.save(d);
              this.event("topic.submitting", d.message, d);
              this.d.changed();
            },
            async () => {
              this.alive();
              this.allowed(d, true);
              const stored = this.draft(d.id, d.version);
              if (
                stored.status !== "submitting" ||
                stored.submittedAt !== d.submittedAt ||
                !stored.submittedAt ||
                stored.payloadHash !== d.payloadHash
              )
                throw new AppError(
                  "TIEBA_TOPIC_SCOPE_CHANGED",
                  "上传期间原任务或授权已变化，未点击发布；保留原提交检查点。",
                );
              d.lastMutationAt = this.now();
              d.updatedAt = d.lastMutationAt;
              this.store.save(d);
            },
          );
          this.alive();
          d.receipt = receipt;
          d.status = this.exact(d, receipt)
            ? "verified"
            : d.submittedAt &&
                receipt.status === "pending_review" &&
                receipt.forumId === d.forumId
              ? "pending_review"
              : d.submittedAt
                ? "uncertain"
                : "draft";
          d.message =
            d.status === "verified"
              ? "官网已核实原账号、主题ID、首帖ID、正文与配图。"
              : receipt.message || "原结果待核对，不会重复上传或发布。";
        });
      } catch (e) {
        if (this.closed) throw e;
        d.status = d.submittedAt ? "uncertain" : "draft";
        d.message = safeMessage(e);
      }
      this.alive();
      d.updatedAt = this.now();
      this.store.save(d);
      this.event("topic.submitted", d.message, d, d.status !== "verified");
      return this.snapshot();
    });
  }
  async reconcile(input: { id: string }) {
    return this.operation(async () => {
      let d = this.draft(input.id);
      if (!d.submittedAt || !["uncertain", "pending_review"].includes(d.status))
        throw new AppError(
          "TIEBA_TOPIC_RECONCILE",
          "只有已提交未知或审核中的原主题可以只读核对。",
        );
      const a = this.account(d.accountId, d.uid);
      // A fresh login with the same UID may recover an old result read-only.
      // Capture the current environment; original write scope remains immutable.
      const currentStamp = this.d.environments.stamp(ref(a.id));
      await this.queued(a, `核对原主题 · ${d.title}`, async () => {
        this.d.environments.assertStamp(ref(a.id), currentStamp);
        const verified = await this.verify(a);
        this.d.environments.assertStamp(ref(a.id), currentStamp);
        d = this.draft(d.id);
        const receipt = await this.browser().reconcile(
          verified,
          d.uid,
          await this.payload(d),
          d.submittedAt!,
          d.receipt,
        );
        this.alive();
        this.d.environments.assertStamp(ref(a.id), currentStamp);
        d.receipt = receipt;
        d.status = this.exact(d, receipt)
          ? "verified"
          : receipt.status === "pending_review" && receipt.forumId === d.forumId
            ? "pending_review"
            : "uncertain";
        d.message =
          d.status === "verified"
            ? "官网补核确认原主题的身份、首帖和图文。"
            : receipt.message || "尚未查到可核实的原结果，保留原记录，不重发。";
        d.version++;
        d.updatedAt = this.now();
        this.store.save(d);
        this.event("topic.reconciled", d.message, d, d.status !== "verified");
      });
      return this.snapshot();
    });
  }
  publications() {
    return this.store
      .drafts()
      .filter(
        (d) =>
          d.submittedAt &&
          ["verified", "uncertain", "pending_review"].includes(d.status),
      )
      .map((d) => ({
        id: d.id,
        kind: "topic" as const,
        accountId: d.accountId,
        uid: d.uid,
        forumId: d.forumId,
        forumName: d.forumName,
        threadId: d.receipt?.threadId ?? null,
        postId: d.receipt?.postId ?? null,
        title: d.title,
        url: d.receipt?.url ?? null,
        body: d.body,
        submittedAt: d.submittedAt!,
        submissionStatus: d.status as
          "verified" | "uncertain" | "pending_review",
      }));
  }
  dispose() {
    this.closed = true;
    for (const c of this.controllers) c.abort();
  }
}

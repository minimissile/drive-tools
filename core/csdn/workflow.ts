import { ContentSources, sameContentWord as sameWord } from "../content-sources";
import { createHash } from "node:crypto";
import { z } from "zod";
import { id, now } from "../database";
import { AppError, safeMessage } from "../errors";
import { csdnHandoff } from "../../shared/csdn";
import { bindingEditorUrl } from "../../shared/channels";
import { validatePublicationUrl } from "../links";
import { recordEditorOpened } from "../publications";
import {
  csdnWorkflowInput,
  csdnPublicationOptions,
  csdnPublicationIssue,
} from "../../shared/csdn-workflow";
import type {
  CsdnWorkflow,
  CsdnWorkflowDetail,
  CsdnKeyword,
  CsdnEditorPayload,
  CsdnSubmitReceipt,
  CsdnResourceMatch,
} from "../../shared/csdn-workflow";
import type { Repository } from "../repository";
import type { SearchOperations } from "../search";
import type { AiService } from "../ai";
import type { PublicationPackage } from "../../shared/ipc-commands";
import type { BrowserBinding, Draft } from "../../shared/types";

export interface CsdnEditor {
  inspect(binding: BrowserBinding, pageKey: string): Promise<void>;
  prepare(binding: BrowserBinding, payload: CsdnEditorPayload): Promise<void>;
  submit(
    binding: BrowserBinding,
    payload: CsdnEditorPayload,
    beforeSubmit: () => Promise<void>,
  ): Promise<CsdnSubmitReceipt>;
}
interface Dependencies {
  environmentStamp?(bindingId: string): import("../../shared/browser-environments").EnvironmentStamp;
  withEnvironment?<T>(bindingId: string, action: () => Promise<T>): Promise<T>;
  repo: Repository;
  search: SearchOperations;
  ai: AiService;
  editor: CsdnEditor;
  verifyTarget(topicId: string): Promise<void>;
  contentPackage(
    draftId: string,
    bindingId: string,
    includeLink: boolean,
  ): Promise<PublicationPackage>;
  record(input: {
    draftId: string;
    bindingId: string;
    url: string;
    status: "submitted" | "published";
  }): Promise<unknown>;
  changed(): void;
}
const indexKey = "csdnWorkflow:index:v1";
const key = (id: string) => `csdnWorkflow:v1:${id}`;
const finalStages = new Set(["submitted", "published", "uncertain"]);

/** Durable single-article orchestration. Consent is supplied per command, never stored. */
export class CsdnWorkflows {
  private active = new Set<string>();
  private windows = new Set<string>();
  private closed = false;
  private sources: ContentSources;
  constructor(private deps: Dependencies) {
    this.sources = new ContentSources(deps.repo, deps.search);
    for (const run of this.history()) {
      if (
        ["generating", "preparing", "submitting", "ready"].includes(run.stage)
      ) {
        run.stage = run.stage === "submitting" ? "uncertain" : "attention";
        run.message =
          run.stage === "uncertain"
            ? "上次提交被中断，请在 CSDN 核对结果；不会自动重发。"
            : "上次操作被中断，请核对已保存内容后继续。";
        run.prepared = null;
        this.save(run);
      }
    }
  }
  get isBusy() {
    return this.active.size > 0;
  }
  close() {
    this.closed = true;
  }
  history(): CsdnWorkflow[] {
    return this.deps.repo.db
      .setting<string[]>(indexKey, [])
      .map((id) => this.load(id));
  }
  private load(runId: string) {
    const run = this.deps.repo.db.setting<CsdnWorkflow | null>(
      key(runId),
      null,
    );
    if (!run) throw new AppError("NOT_FOUND", "CSDN 创作任务不存在。");
    return run;
  }
  get(runId: string): CsdnWorkflowDetail {
    const run = this.load(runId);
    return {
      run,
      draft: run.draftId ? this.deps.repo.draft(run.draftId) : null,
      versions: this.deps.repo.db
        .all<{
          id: string;
          title: string;
          version: number;
          updated_at: string;
        }>(
          "SELECT id,title,version,updated_at FROM drafts WHERE topic_id=? AND copy_id=? AND platform='csdn' AND split_item_id IS ? ORDER BY updated_at DESC,rowid DESC",
          run.topicId,
          run.input.copyId,
          run.input.splitItemId,
        )
        .map((draft) => ({
          id: draft.id,
          title: draft.title,
          version: draft.version,
          updatedAt: draft.updated_at,
        })),
    };
  }
  private save(run: CsdnWorkflow) {
    if (this.closed) return;
    run.updatedAt = now();
    const previous = this.deps.repo.db.setting<CsdnWorkflow | null>(
      key(run.id),
      null,
    );
    if (previous?.stage !== run.stage || previous?.message !== run.message)
      run.events = [
        ...(run.events ?? []),
        { stage: run.stage, message: run.message, at: run.updatedAt },
      ].slice(-100);
    this.deps.repo.db.setSetting(key(run.id), run);
    this.deps.changed();
  }
  private editable(run: CsdnWorkflow) {
    if (this.closed || this.active.has(run.id))
      throw new AppError("CSDN_BUSY", "此任务正在处理，请等待当前操作完成。");
    if (finalStages.has(run.stage))
      throw new AppError(
        "CSDN_RESULT_EXISTS",
        "此任务已有提交记录或结果待核对，请先处理发布结果。",
      );
  }
  words(raw: unknown): CsdnKeyword[] {
    return this.sources.words(raw);
  }
  private source(sourceId: string, keyword: string): CsdnKeyword {
    if (sourceId === "manual")
      return {
        id: "manual",
        word: keyword,
        source: "手工选题 · 搜索量待核实",
        metrics: {},
        observedAt: null,
      };
    const source = this.words({ query: keyword }).find(
      (word) => word.id === sourceId && word.word === keyword,
    );
    if (!source)
      throw new AppError(
        "CSDN_WORD_CHANGED",
        "所选关键词来源已变化，请重新选择或改为手工选题。",
      );
    return source;
  }
  matches(raw: unknown): CsdnResourceMatch[] {
    return this.sources.matches(raw);
  }
  create(raw: unknown): CsdnWorkflowDetail {
    const input = csdnWorkflowInput.parse(raw),
      source = this.source(input.sourceId, input.keyword);
    this.deps.search.assertTarget(input.copyId, input.splitItemId);
    const history = this.history();
    const duplicate = history.find(
      (run) =>
        sameWord(run.input.keyword) === sameWord(input.keyword) &&
        run.input.copyId === input.copyId,
    );
    if (duplicate) return this.get(duplicate.id);
    const existing = this.deps.repo.db
      .all<{
        id: string;
        keyword: string;
        copy_id: string | null;
        split_item_id: string | null;
      }>(
        "SELECT id,keyword,copy_id,split_item_id FROM search_topics WHERE platform='csdn' AND archived=0",
      )
      .find((topic) => sameWord(topic.keyword) === sameWord(input.keyword));
    if (
      existing &&
      (existing.copy_id !== input.copyId ||
        existing.split_item_id !== input.splitItemId)
    )
      throw new AppError(
        "CSDN_TOPIC_EXISTS",
        "该关键词已有其他配套资料的 CSDN 选题，请在搜索运营中核对关联。",
      );
    const topic = existing
      ? this.deps.search.get(existing.id).topic
      : this.deps.search.create({ ...input, platform: "csdn" }, false);
    if (
      !existing ||
      topic.intent !== input.intent ||
      topic.evidence !== input.evidence ||
      topic.softwareVersion !== input.softwareVersion ||
      topic.operatingSystem !== input.operatingSystem
    )
      this.deps.search.facts({ id: topic.id, ...input });
    let run!: CsdnWorkflow;
    this.deps.repo.db.transaction(() => {
      const time = now();
      run = {
        id: id("csdn"),
        input,
        source,
        topicId: topic.id,
        draftId: topic.draftId,
        options: null,
        stage: topic.draftId ? "review" : "configured",
        message: "已关联本人资料，生成后请核对技术步骤和配套文件。",
        prepared: null,
        url: null,
        createdAt: time,
        updatedAt: time,
      };
      this.deps.repo.db.setSetting(key(run.id), run);
      this.deps.repo.db.setSetting(indexKey, [
        run.id,
        ...history.map((r) => r.id),
      ]);
    });
    this.deps.changed();
    return this.get(run.id);
  }
  private async work(
    runId: string,
    stage: CsdnWorkflow["stage"],
    action: (run: CsdnWorkflow) => Promise<void>,
  ) {
    const run = this.load(runId);
    this.editable(run);
    const windowId = run.options
      ? this.deps.repo.bindings().find((b) => b.id === run.options!.bindingId)
          ?.windowId
      : undefined;
    if (windowId && this.windows.has(windowId))
      throw new AppError(
        "CSDN_WINDOW_BUSY",
        "该比特窗口已有 CSDN 任务正在操作，请稍后重试。",
      );
    this.active.add(runId);
    if (windowId) this.windows.add(windowId);
    run.stage = stage;
    run.message =
      stage === "generating"
        ? "正在使用现有文案模型生成教程…"
        : "正在核验资料与发布窗口…";
    this.save(run);
    try {
      if (run.options && this.deps.withEnvironment) await this.deps.withEnvironment(run.options.bindingId, () => action(run)); else await action(run);
    } catch (error) {
      if (!this.closed) {
        if (run.stage === "submitting") run.stage = "uncertain";
        else if (!finalStages.has(run.stage)) run.stage = "attention";
        run.message =
          (run.stage === "submitted"
            ? "提交回执已保存，但发布记录同步失败；请同步待审核回执，无需重新提交。"
            : safeMessage(error)) +
          (run.stage === "uncertain"
            ? " 请先在 CSDN 核对，不会自动重发。"
            : "");
        if (run.stage !== "ready") run.prepared = null;
        this.save(run);
      }
    } finally {
      this.active.delete(runId);
      if (windowId) this.windows.delete(windowId);
    }
    return this.closed ? { run, draft: null, versions: [] } : this.get(runId);
  }
  generate(runId: string) {
    return this.work(runId, "generating", async (run) => {
      if (run.draftId) {
        run.stage = "review";
        run.message = "已有草稿已保留，请继续编辑与审阅。";
        this.save(run);
        return;
      }
      const context = this.deps.search.context(run.topicId);
      await this.deps.verifyTarget(run.topicId);
      if (this.closed) return;
      const draft = await this.deps.ai.draft(
        context.copy.id,
        "csdn",
        context.topic.poolId,
        context,
      );
      if (this.closed) return;
      run.draftId = draft.id;
      run.stage = "review";
      run.message =
        "教程已生成。请核对事实、代码、图片与资料，再完成当前版本审阅。";
      this.save(run);
    });
  }
  attachDraft(runId: string, draftId: string) {
    const run = this.load(runId);
    this.editable(run);
    const draft = this.deps.repo.draft(draftId);
    if (
      draft.platform !== "csdn" ||
      draft.copyId !== run.input.copyId ||
      draft.topicId !== run.topicId ||
      draft.splitItemId !== run.input.splitItemId
    )
      throw new AppError(
        "DRAFT_MISMATCH",
        "稿件与当前 CSDN 任务或配套资料不一致。",
      );
    run.draftId = draft.id;
    run.prepared = null;
    run.stage = "review";
    run.message = "已切换到新版本，请重新审阅并填写发布窗口。";
    this.save(run);
    return this.get(runId);
  }
  configure(runId: string, raw: unknown) {
    const run = this.load(runId);
    this.editable(run);
    run.options = csdnPublicationOptions.parse(raw);
    const binding = this.deps.repo
      .bindings()
      .find((b) => b.id === run.options!.bindingId);
    if (binding?.platform !== "csdn")
      throw new AppError("BINDING_MISMATCH", "请选择 CSDN 发布窗口。");
    run.prepared = null;
    run.stage = run.draftId ? "review" : "configured";
    run.message = "发布设置已保存，填写前会重新核验本人分享与账号。";
    this.save(run);
    return this.get(runId);
  }
  async inspect(runId: string) {
    const run = this.load(runId);
    if (!run.options)
      throw new AppError("CSDN_NOT_READY", "请先保存发布账号与窗口设置。");
    const binding = this.deps.repo
      .bindings()
      .find((b) => b.id === run.options!.bindingId);
    if (binding?.platform !== "csdn")
      throw new AppError("BINDING_MISMATCH", "CSDN 发布窗口已不存在。");
    await this.deps.editor.inspect(binding, `panxu:${run.id}:${run.draftId}`);
    return true;
  }
  private async payload(run: CsdnWorkflow) {
    if (!run.draftId || !run.options)
      throw new AppError(
        "CSDN_NOT_READY",
        "请先生成、审阅文章并保存发布设置。",
      );
    const draft = this.deps.repo.draft(run.draftId),
      issue = csdnPublicationIssue(draft);
    if (issue) throw new AppError("CSDN_CONTENT_REQUIRED", issue);
    const binding = this.deps.repo
      .bindings()
      .find((b) => b.id === run.options!.bindingId);
    if (!binding || binding.platform !== "csdn")
      throw new AppError("BINDING_MISMATCH", "CSDN 发布窗口已不存在。");
    const pack = await this.deps.contentPackage(
      draft.id,
      binding.id,
      run.options.includeLink,
    );
    if (!pack.includesOwnLink)
      throw new AppError(
        "CSDN_RESOURCE_ENTRY_REQUIRED",
        "本文尚无配套本人资料入口，请在获准场景勾选附加本人分享，或将本人链接保存到正文后重新审阅。",
      );
    const payload: CsdnEditorPayload = {
      pageKey: `panxu:${run.id}:${draft.id}`,
      author: run.options.author,
      title: pack.title,
      body: pack.body,
      tags: [...new Set(draft.tags)],
      summary: run.options.summary || csdnHandoff(draft).summary,
      aiAssisted: !["manual", "local-template"].includes(draft.model),
    };
    if (!payload.summary)
      throw new AppError("CSDN_SUMMARY_REQUIRED", "请在发布设置中填写摘要。");
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          environment: this.deps.environmentStamp?.(binding.id),
          payload,
          draftId: draft.id,
          revision: draft.resourceRevision,
          shareVersion: draft.splitShareVersion ?? draft.shareVersion,
          editor: bindingEditorUrl(binding, "article"),
          binding,
        }),
      )
      .digest("hex");
    return { binding, payload, fingerprint, draft };
  }
  prepare(runId: string) {
    return this.work(runId, "preparing", async (run) => {
      run.prepared = null;
      this.save(run);
      const prepared = await this.payload(run);
      await this.deps.editor.prepare(prepared.binding, prepared.payload);
      if (this.closed) return;
      const current = await this.payload(run);
      if (prepared.fingerprint !== current.fingerprint)
        throw new AppError(
          "CSDN_CONTENT_CHANGED",
          "填写期间内容、分享或账号设置发生变化，请重新填写。",
        );
      recordEditorOpened(
        this.deps.repo.db,
        prepared.draft,
        prepared.binding.id,
        true,
      );
      run.prepared = {
        fingerprint: prepared.fingerprint,
        pageKey: prepared.payload.pageKey,
        author: prepared.payload.author,
        preparedAt: now(),
      };
      run.stage = "ready";
      run.message =
        "标题、正文、标签、摘要、公开范围与创作声明已填写。核对比特窗口后可提交。";
      this.save(run);
    });
  }
  private assertNoSubmission(run: CsdnWorkflow) {
    const duplicate = this.history().find(
      (other) =>
        other.id !== run.id &&
        other.draftId === run.draftId &&
        other.options?.bindingId === run.options?.bindingId &&
        (finalStages.has(other.stage) || other.stage === "submitting"),
    );
    const recorded = this.deps.repo.db.get(
      "SELECT id FROM publications WHERE draft_id=? AND binding_id=? AND status IN ('submitted','published')",
      run.draftId!,
      run.options!.bindingId,
    );
    if (duplicate || recorded)
      throw new AppError(
        "CSDN_ALREADY_SUBMITTED",
        "当前稿件和账号已有提交记录或结果未知，请核对后处理，不能重复提交。",
      );
  }
  submit(runId: string) {
    const stored = this.load(runId);
    if (stored.stage !== "ready" || !stored.prepared)
      throw new AppError(
        "CSDN_PREPARE_REQUIRED",
        "请先完成自动填写并核对当前版本。",
      );
    return this.work(runId, "preparing", async (run) => {
      const current = await this.payload(run);
      if (
        !run.prepared ||
        current.fingerprint !== run.prepared.fingerprint ||
        Date.now() - Date.parse(run.prepared.preparedAt) > 15 * 60_000
      )
        throw new AppError(
          "CSDN_PREPARE_EXPIRED",
          "文章、分享或窗口设置已变化，或填写超过15分钟，请重新核验并填写。",
        );
      this.assertNoSubmission(run);
      const receipt = await this.deps.editor.submit(
        current.binding,
        current.payload,
        async () => {
          if (this.closed)
            throw new AppError("CSDN_CLOSED", "应用已关闭，提交已停止。");
          const latest = await this.payload(run);
          if (this.closed)
            throw new AppError("CSDN_CLOSED", "应用已关闭，提交已停止。");
          if (latest.fingerprint !== current.fingerprint)
            throw new AppError(
              "CSDN_CONTENT_CHANGED",
              "提交前内容、分享或账号设置已变化，请重新填写。",
            );
          this.assertNoSubmission(run);
          run.stage = "submitting";
          run.message = "已记录本次提交意图，正在等待 CSDN 回执…";
          this.save(run);
        },
      );
      if (this.closed) return;
      if (receipt.status === "rejected") {
        run.stage = "attention";
        run.message = receipt.message;
        run.prepared = null;
        this.save(run);
        return;
      }
      this.validateUrl(run, receipt.url);
      run.url = receipt.url;
      run.stage = "submitted";
      run.prepared = null;
      run.message = "CSDN 已返回文章地址，已记录待审核；公开状态仍需核对。";
      this.save(run); // Persist receipt before local publication synchronization.
      await this.sync(run, "submitted");
    });
  }
  private validateUrl(run: CsdnWorkflow, url: string) {
    validatePublicationUrl("csdn", url);
    const parts = new URL(url).pathname.match(
      /^\/([^/]+)\/article\/details\/(\d+)\/?$/,
    );
    if (!parts || parts[1].toLowerCase() !== run.options?.author.toLowerCase())
      throw new AppError(
        "CSDN_RECEIPT_MISMATCH",
        "文章地址与配置的 CSDN 用户名不一致，请人工核对。",
      );
  }
  private async sync(run: CsdnWorkflow, status: "submitted" | "published") {
    await this.deps.record({
      draftId: run.draftId!,
      bindingId: run.options!.bindingId,
      url: run.url!,
      status,
    });
  }
  async resolve(
    runId: string,
    result: "submitted" | "published" | "not_submitted",
    url: string,
  ) {
    const run = this.load(runId);
    if (
      this.active.has(runId) ||
      !["uncertain", "submitted", "published"].includes(run.stage)
    )
      throw new AppError(
        "CSDN_RESOLVE_REQUIRED",
        "请先等待提交结束，再核对平台结果。",
      );
    if (result === "not_submitted") {
      if (run.stage !== "uncertain")
        throw new AppError(
          "CSDN_RESULT_EXISTS",
          "已取得提交回执，不能清除记录后重发。",
        );
      run.stage = "review";
      run.prepared = null;
      run.message = "已人工确认未提交；重新填写并授权后才能再提交。";
      this.save(run);
    } else {
      this.validateUrl(run, url);
      if (run.url && run.url !== url)
        throw new AppError(
          "CSDN_RECEIPT_MISMATCH",
          "请使用本任务已取得的文章地址。",
        );
      await this.deps.record({
        draftId: run.draftId!,
        bindingId: run.options!.bindingId,
        url,
        status: result,
      });
      run.url = url;
      run.stage = result;
      run.message =
        result === "published"
          ? "已人工核对文章公开，发布记录已同步。"
          : "已登记文章回执，等待平台审核。";
      this.save(run);
    }
    return this.get(runId);
  }
}

import { randomUUID } from "node:crypto";
import type { DiscoveryQuestionImport } from "../shared/baidu-discovery";
import type { QuestionDraftInsertResult } from "../shared/zhidao-publishing";
import {
  zhidaoAnswerIssue,
  zhidaoQuestionIssue,
} from "../shared/zhidao-content";
import { AppError, safeMessage } from "./errors";
import { parseShare } from "./links";
import type { Repository } from "./repository";
import type { ShareCreation } from "./share-creation";
import type { OperationsStore } from "./zhidao/store";
import { questionDraftCandidates, shuffled } from "./zhidao/question-drafts";
import { safeHtmlAnswer } from "./zhidao/parsers";

type Question = { key: string; title: string; sourceUrl: string };

/** Explicit import: journal each word before building its standalone remote share. */
export class BaiduDiscoveryQuestions {
  private activeSource: string | null = null;
  private accounts = new Set<string>();
  private pauseRequested = false;
  get isBusy() {
    return this.activeSource !== null;
  }
  busyAccount(id: string) {
    return this.accounts.has(id);
  }
  constructor(
    private d: {
      repo: Repository;
      store: OperationsStore;
      shares: ShareCreation;
      changed(): void;
    },
  ) {}
  private run(sourceId: string) {
    const row = this.d.repo.db.get<{ id: string }>(
      "SELECT id FROM operation_runs WHERE kind='template' AND json_extract(config,'$.sourceKind')='discovery-independent' AND json_extract(config,'$.sourceId')=? ORDER BY rowid DESC LIMIT 1",
      sourceId,
    );
    return row ? this.d.store.run(row.id) : null;
  }
  pause(sourceId: string) {
    if (this.activeSource !== sourceId) return;
    this.pauseRequested = true;
    const run = this.run(sourceId);
    if (run)
      this.d.store.state(
        run.id,
        "running",
        "正在暂停，等待当前分享回执后保留进度。",
      );
    this.d.changed();
  }
  async progress(sourceId: string): Promise<DiscoveryQuestionImport> {
    const run = this.run(sourceId);
    const items = run ? this.d.store.items(run.id) : [];
    const issues: DiscoveryQuestionImport["issues"] = [];
    for (const item of items
      .filter((item) =>
        ["failed", "uncertain"].includes(item.independentShare?.state || ""),
      )
      .slice(0, 20)) {
      let returned = false;
      try {
        returned = !!(
          await this.d.shares.result(item.independentShare!.operationId)
        )?.hasReturnedShare;
      } catch {
        /* Keep the recoverable error visible. */
      }
      issues.push({
        question: item.question,
        message: item.message,
        operationId: item.independentShare!.operationId,
        uncertain: item.independentShare!.state === "uncertain",
        hasReturnedShare: returned,
      });
    }
    const count = (state: string) =>
      items.filter((item) => item.independentShare?.state === state).length;
    return {
      runId: run?.id || null,
      running: this.activeSource === sourceId,
      total: items.length,
      ready: count("ready"),
      pending: count("pending"),
      failed: count("failed"),
      uncertain: count("uncertain"),
      message: run?.message || "",
      issues,
    };
  }
  async insert(source: {
    id: string;
    questions: Question[];
    copyIds: string[];
    materials: string[];
  }): Promise<QuestionDraftInsertResult> {
    if (this.isBusy)
      throw new AppError(
        "QUESTION_IMPORT_BUSY",
        "正在为关键词创建分享，请等待本轮完成。",
      );
    const materials = shuffled(source.materials.map((entry) => entry.trim()));
    if (
      !materials.length ||
      materials.some(
        (entry) => zhidaoAnswerIssue(entry) || /https?:\/\//i.test(entry),
      )
    )
      throw new AppError(
        "QUESTION_MATERIALS",
        "请准备完整资料文案，并移除文案中的旧网址；新链接会逐词生成后填入。",
      );
    this.activeSource = source.id;
    try {
      const copyIds = shuffled([...new Set(source.copyIds)]);
      if (!copyIds.length)
        throw new AppError(
          "QUESTION_RESOURCE",
          "请先选择关联的本人百度网盘资源。",
        );
      for (const id of copyIds) {
        const copy = this.d.repo.getCopy(id);
        this.accounts.add(copy.accountId);
        const options = await this.d.shares.options(id);
        if (options.provider !== "baidu" || options.issue)
          throw new AppError(
            "QUESTION_RESOURCE",
            options.issue || "请选择本人百度网盘资源。",
          );
      }
      let run = this.run(source.id);
      const existing = run ? this.d.store.items(run.id) : [];
      const wantedKeys = new Set(
        source.questions.map((q) => `question-import:${source.id}:${q.key}`),
      );
      const retryItems = existing.filter(
        (item) =>
          wantedKeys.has(item.key) &&
          item.independentShare &&
          item.independentShare.state !== "ready" &&
          item.status !== "skipped",
      );
      const questions = questionDraftCandidates(
        this.d.store,
        source.id,
        source.questions,
      );
      if (questions.length + retryItems.length > 500)
        throw new AppError(
          "QUESTION_IMPORT_LIMIT",
          "每次最多为500个长尾词创建分享，请分批选择。",
        );
      const duplicates =
        source.questions.length - questions.length - retryItems.length;
      if (!questions.length && !retryItems.length)
        return { added: 0, duplicates, titleIssues: 0, runId: run?.id || null };
      this.d.repo.db.transaction(() => {
        run ||= this.d.store.create(
          "template",
          "百度扩词 · 独立链接问答",
          { sourceKind: "discovery-independent", sourceId: source.id },
          0,
        );
        for (const [index, q] of questions.entries()) {
          this.d.store.put(run.id, `question-import:${source.id}:${q.key}`, {
            name: q.title,
            question: q.title,
            answer: materials[index % materials.length],
            sourceUrl: q.sourceUrl,
            sourceName: "百度批量扩词",
            status: "pending",
            reviewed: false,
            independentShare: {
              copyId: copyIds[index % copyIds.length],
              operationId: randomUUID(),
              state: "pending",
            },
            message: "等待为此长尾词创建独立分享链接。",
          });
        }
        this.d.repo.db.run(
          "UPDATE operation_runs SET total=? WHERE id=?",
          existing.length + questions.length,
          run.id,
        );
        this.d.store.state(
          run.id,
          "running",
          "正在逐词创建独立分享，已完成的问答会出现在发布页。",
        );
      });
      const runId = run!.id;
      const items = this.d.store
        .items(runId)
        .filter(
          (item) =>
            wantedKeys.has(item.key) &&
            item.independentShare &&
            item.independentShare.state !== "ready" &&
            item.status !== "skipped",
        );
      for (const item of items)
        this.accounts.add(
          this.d.repo.getCopy(item.independentShare!.copyId).accountId,
        );
      const used = new Set(
        this.d.repo.db
          .all<{ url: string }>(
            "SELECT share_url url FROM copies WHERE share_url IS NOT NULL UNION SELECT json_extract(data,'$.link') url FROM operation_items WHERE json_extract(data,'$.independentShare.state')='ready'",
          )
          .map((row) => row.url)
          .filter(Boolean),
      );
      let added = 0,
        titleIssues = 0;
      for (const item of items) {
        if (this.pauseRequested) break;
        this.d.store.state(
          runId,
          "running",
          `正在为「${item.question}」创建独立分享链接。`,
        );
        this.d.changed();
        const metadata = item.independentShare!;
        try {
          let receipt = await this.d.shares.result(metadata.operationId);
          if (receipt?.state === "uncertain")
            receipt = await this.d.shares.recheck(metadata.operationId);
          if (
            receipt?.state === "failed" ||
            (receipt?.state === "success" && metadata.linkConflict)
          ) {
            metadata.operationId = randomUUID();
            metadata.state = "pending";
            delete metadata.linkConflict;
            this.d.store.put(runId, item.key, {
              independentShare: metadata,
              status: "pending",
            });
            receipt = null;
          }
          receipt ||= await this.d.shares.create({
            operationId: metadata.operationId,
            copyId: metadata.copyId,
            expiresInDays: 0,
          });
          if (receipt.state !== "success" || !receipt.url) {
            this.d.store.put(runId, item.key, {
              status: receipt.state === "failed" ? "failed" : "uncertain",
              independentShare: {
                ...metadata,
                state: receipt.state === "failed" ? "failed" : "uncertain",
              },
              message: receipt.message,
            });
            break;
          }
          const link = parseShare(receipt.url, receipt.code);
          if (link.provider !== "baidu" || used.has(link.url)) {
            this.d.store.put(runId, item.key, {
              status: "failed",
              independentShare: {
                ...metadata,
                state: "failed",
                linkConflict: true,
              },
              message:
                "网盘返回了已使用的链接，本词未入发布列表；请核对后重新生成。",
            });
            break;
          }
          used.add(link.url);
          // copyId stays empty: publication must use this standalone link, not compare it with the library share version.
          this.d.store.put(runId, item.key, {
            link: link.url,
            code: link.code,
            answer: safeHtmlAnswer(item.answer, link.url, link.code),
            status: "ready",
            reviewed: false,
            independentShare: { ...metadata, state: "ready" },
            message: "此长尾词的独立链接已生成，可在问答发布页核对并审核上传。",
          });
          added++;
          if (zhidaoQuestionIssue(item.question)) titleIssues++;
        } catch (error) {
          let uncertain = true;
          try {
            uncertain =
              (await this.d.shares.result(metadata.operationId))?.state ===
              "uncertain";
          } catch {
            /* An unreadable receipt cannot authorize another write. */
          }
          this.d.store.put(runId, item.key, {
            status: uncertain ? "uncertain" : "failed",
            independentShare: {
              ...metadata,
              state: uncertain ? "uncertain" : "failed",
            },
            message: safeMessage(error),
          });
          break;
        }
        this.d.changed();
      }
      const progress = await this.progress(source.id);
      const remaining = progress.pending + progress.failed + progress.uncertain;
      this.d.store.state(
        runId,
        remaining ? "paused" : "completed",
        `已有${progress.ready}条独立链接问答可审核发布${remaining ? `，${remaining}条未完成；已完成项会保留，重新点击可继续。` : "。"}`,
        progress.ready,
      );
      return {
        added,
        duplicates,
        titleIssues,
        runId,
        failed: progress.failed,
        uncertain: progress.uncertain,
        pending: progress.pending,
      };
    } catch (error) {
      const run = this.run(source.id);
      if (run)
        this.d.store.state(
          run.id,
          "paused",
          `建链已暂停：${safeMessage(error)} 已有结果保留，可处理后继续。`,
        );
      throw error;
    } finally {
      this.activeSource = null;
      this.pauseRequested = false;
      this.accounts.clear();
      this.d.changed();
    }
  }
}

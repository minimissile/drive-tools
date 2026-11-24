import { randomUUID } from "node:crypto";
import type {
  PublishingQuestion,
  PublishingRecord,
  PublishingResource,
  PublishingDestination,
  PublishingLinkType,
  PublishingPublicLinks,
} from "../../shared/zhidao-workflow";
import {
  publishingQuestionIssue,
  publishingQuestionLimit,
  publishingContentReviewed,
  publishingLinkIssue,
  publishingRowShare,
  publishingRowsWithLinks,
  publishingSelectionRevision,
} from "../../shared/zhidao-workflow";
import {
  defaultGenerationRules,
  generationHtml,
  generationQuestion,
  generationResource,
} from "../../shared/zhidao-generation";
import type { HandlerServices } from "../ipc/types";
import { AppError, safeMessage } from "../errors";
import { parseShare, shareUrlWithCode } from "../links";
import { now } from "../database";
import { hasVerifiedShare } from "../../shared/share-status";
import type { Job, ShareCheck } from "../../shared/types";
import type { AiService } from "../ai";
import type { OperationItem, OperationRun } from "../../shared/zhidao";
import { decodeHtml } from "./parsers";
import { publicationWorkbook } from "./publishing";
import {
  generatePublishingBatch,
  publishingGenerationBatchSize,
  publishingTextKey,
  planPublishingTopics,
  reviewPublishingDrafts,
} from "./publishing-generation";

type Dependencies = Pick<
  HandlerServices,
  | "repo"
  | "secrets"
  | "ports"
  | "saveResource"
  | "shareCreation"
  | "checkShare"
  | "changed"
> & {
  ai: Pick<AiService, "assertTextConfigured" | "resourceExport">;
  resourcePublishedUrls?: (resourceId: string) => PublishingPublicLinks;
  publication?: {
    get(id: string): OperationRun;
    start(
      records: PublishingRecord[],
      accountId: string,
      taskName: string,
      onCreated: (run: OperationRun) => void,
      destination?: PublishingDestination,
    ): OperationRun;
  };
};
const key = (id: string) => `zhidao-publishing-resource:${id}`;
const legacyShareCheckFailure = "本人分享检查未通过，请在资源库处理后继续。";
function shareCheckFailure(check: ShareCheck) {
  const detail =
    check.message === "fetch failed"
      ? "检查请求连接失败，请检查原账号的浏览器服务与网络。"
      : check.message;
  return check.status === "unavailable"
    ? `分享检查暂未完成：${detail} 可在此重新检查并继续，已有资源与分享进度保留。`
    : `入库分享检查未通过：${detail}`;
}
const activeTransferStages = [
  "queued",
  "preflight",
  "transferring",
  "verifying",
  "sharing",
  "archiving",
];
function canUpgradeLegacy(record: PublishingRecord) {
  if (
    record.stage !== "ready" ||
    record.linkedAnswerFormat ||
    !record.links.length ||
    !record.rows.length ||
    record.rows.length !== record.resource.keywords.length
  )
    return false;
  return record.rows.every((row, index) => {
    if (row.reviewed || row.keyword !== record.resource.keywords[index])
      return false;
    const { url, code } = record.links[index % record.links.length];
    const resource = {
      title: record.resource.title,
      summary: record.resource.summary,
      link: url,
      code,
      image: "",
    };
    return (
      row.question ===
        generationQuestion(
          { ...resource, title: row.keyword },
          defaultGenerationRules,
        ) && row.answer === generationHtml(resource, defaultGenerationRules)
    );
  });
}

const htmlEntities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => htmlEntities[char]);

function answerShares(answer: string) {
  const urls =
    decodeHtml(answer).match(/https?:\/\/[^\s<>"'，。；）)]+/gi) ?? [];
  return urls.flatMap((url) => {
    try {
      return [parseShare(url)];
    } catch {
      return [];
    }
  });
}

const hiddenHtml =
  /<!--[\s\S]*?(?:-->|$)|<(script|style|template|textarea|title|iframe|xmp|noembed|noframes|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const htmlTags = /<([a-z][\w:-]*)(\s(?:[^>"']|"[^"]*"|'[^']*')*)?>/gi;
const htmlAttributes =
  /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function answerAnchorTargets(visibleHtml: string) {
  return [...visibleHtml.matchAll(htmlTags)].flatMap((tag) => {
    if (tag[1].toLowerCase() !== "a") return [];
    const href = [...(tag[2] || "").matchAll(htmlAttributes)].find(
      (attribute) => attribute[1].toLowerCase() === "href",
    );
    const value = href && (href[2] ?? href[3] ?? href[4]);
    if (!value) return [];
    try {
      const url = new URL(decodeHtml(value));
      return url.protocol === "https:" ? [parseShare(url.href)] : [];
    } catch {
      return [];
    }
  });
}

function assignedShare(record: PublishingRecord, index: number) {
  const link = publishingRowShare(record, record.rows[index], index);
  if (!link)
    throw new AppError(
      "SHARE_MISSING",
      "这条问答没有可用独立链接，请返回第四步准备。",
    );
  return parseShare(link.url, link.code);
}

function checkAnswerShare(
  record: PublishingRecord,
  row: PublishingQuestion,
  index: number,
) {
  const visibleHtml = record.linkedAnswerFormat
    ? row.answer.replace(hiddenHtml, " ")
    : "";
  const shares = visibleHtml ? answerShares(visibleHtml) : [];
  const hasPreparedLink = record.linkedAnswerFormat
    ? shares.some((share) =>
        record.links.some((link) => parseShare(link.url).url === share.url),
      )
    : record.links.some((link) => row.answer.includes(link.url));
  if (!hasPreparedLink)
    throw new AppError(
      "SHARE_MISMATCH",
      "回答中缺少本资源已准备的分享链接，请核对后再审核。",
    );
  if (!record.linkedAnswerFormat) return;
  const expected = assignedShare(record, index);
  if (
    shares.some(
      (share) => share.url !== expected.url || share.code !== expected.code,
    )
  )
    throw new AppError(
      "SHARE_MISMATCH",
      "回答中的网盘链接或提取码与这条问答分配的分享不一致，请核对后再保存。",
    );
  if (
    !answerAnchorTargets(visibleHtml).some(
      (share) => share.url === expected.url && share.code === expected.code,
    )
  )
    throw new AppError(
      "SHARE_MISMATCH",
      "请使用 HTML 超链接填写这条问答分配的完整网盘链接。",
    );
}

function comparisonResource({ image = "", ...rest }: PublishingResource) {
  return JSON.stringify({ ...rest, image });
}

/** Remote receipts are durable; only the canonical copy share is kept in the resource library. */
export class ZhidaoPublishingWorkflow {
  private active = new Set<string>();
  private pauses = new Set<string>();
  get isBusy() {
    return this.active.size > 0;
  }
  constructor(private d: Dependencies) {}
  pause(id: string) {
    if (this.active.has(id)) this.pauses.add(id);
    return true;
  }
  resources(query: string) {
    const term = `%${query.trim().replace(/[\\%_]/g, "\\$&")}%`;
    return this.d.repo.db
      .all<{ id: string }>(
        "SELECT id FROM resources WHERE provider='baidu' AND title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 50",
        term,
      )
      .map((row) => this.d.repo.getResource(row.id));
  }
  private store(record: PublishingRecord) {
    record.updatedAt = now();
    this.d.repo.db.setSetting(key(record.id), record);
    this.d.changed();
    return record;
  }
  get(id: string) {
    const record = this.read(id);
    if (!record)
      throw new AppError(
        "NOT_FOUND",
        "此资源的处理记录不存在，请返回第三步准备资源。",
      );
    return record;
  }
  getMany(ids: string[]) {
    return ids.flatMap((id) => {
      const record = this.read(id);
      if (!record) return [];
      return [
        canUpgradeLegacy(record)
          ? { ...record, canUpgradeLegacy: true as const }
          : record,
      ];
    });
  }
  private read(id: string) {
    const record = this.d.repo.db.setting<PublishingRecord | null>(
      key(id),
      null,
    );
    if (!record) return null;
    if (record.generation?.status === "running" && !this.active.has(id)) {
      record.generation.status = "paused";
      record.generation.message =
        "上次 AI 生成中断，已完成批次保留。中断请求的结果与费用需核对，点击继续后只生成剩余问答。";
    }
    // Old failures replaced the read error with a generic invalid-share message.
    // Recover its explanation from the local check without issuing a remote request.
    if (
      record.stage === "failed" &&
      record.copyId &&
      record.message === legacyShareCheckFailure
    ) {
      const check = this.d.repo.db.get<{
        status: ShareCheck["status"];
        checked_at: string;
        message: string;
      }>(
        "SELECT status,checked_at,message FROM share_checks WHERE copy_id=?",
        record.copyId,
      );
      if (check && check.status !== "valid") {
        record.shareCheck = {
          copyId: record.copyId,
          status: check.status,
          checkedAt: check.checked_at,
          message: check.message,
        };
        record.message = shareCheckFailure(record.shareCheck);
      }
    }
    if (record.shareStartedAt) {
      if (this.active.has(id))
        record.message += ` 已等待${Math.max(0, Math.floor((Date.now() - Date.parse(record.shareStartedAt)) / 1000))}秒。`;
      else {
        record.stage = "uncertain";
        record.message =
          "上次建链中断，已完成链接保留；点击核对分享并继续，不会自动重发。";
      }
    }
    if (record.copyId && !record.links.length) this.refreshTransfer(record);
    return record;
  }
  private refreshTransfer(record: PublishingRecord) {
    const copy = this.d.repo.getCopy(record.copyId);
    if (copy.status === "ready") {
      if (record.stage === "transferring") {
        record.stage = "sharing";
        record.message = "转存完成，等待创建关键词分享。";
      }
      record.transferBlocked = false;
      return;
    }
    const job = this.d.repo.db.get<Pick<Job, "id" | "stage" | "error">>(
      "SELECT id,stage,error FROM jobs WHERE copy_id=? AND kind='transfer' ORDER BY created_at DESC,rowid DESC LIMIT 1",
      copy.id,
    );
    const stage = job?.stage ?? copy.status;
    // Recovery queues the job before its worker updates the copy.
    if (activeTransferStages.includes(stage)) {
      record.stage = "transferring";
      record.transferBlocked = false;
      record.message =
        stage === "queued"
          ? "原转存任务已排队，完成后可继续创建分享。"
          : "原转存任务正在处理，完成后可继续创建分享。";
      return;
    }
    record.stage = "failed";
    record.transferBlocked = true;
    if (
      job &&
      (job.stage === "waiting_login" ||
        job.stage === "needs_review" ||
        job.stage === "failed" ||
        job.stage === "cancelled")
    ) {
      record.transferRecovery = { jobId: job.id, stage: job.stage };
    }
    const error = job?.error || copy.error;
    const detail =
      error === "fetch failed" ? "百度网盘请求失败。" : error || "转存未完成。";
    const recovery = record.transferRecovery?.stage;
    const instruction =
      recovery === "waiting_login"
        ? "请登录任务绑定的百度网盘账号。"
        : recovery
          ? "可在此核对并恢复原转存任务。"
          : "请查看转存任务或资源详情。";
    record.message = `${detail} ${instruction}`;
  }
  private async locked<T>(id: string, action: () => Promise<T>) {
    if (this.active.has(id))
      throw new AppError("BUSY", "这份资源正在处理，请等待当前操作结束。");
    this.active.add(id);
    try {
      return await action();
    } finally {
      this.active.delete(id);
      this.d.changed();
    }
  }
  planMany(resources: PublishingResource[]) {
    return this.d.repo.db.transaction(() =>
      resources.map((input) => {
        let resource = input;
        let previous = this.read(resource.key);
        if (previous && !previous.contentFirst) {
          const alias = `zhidao-publishing-content-plan:${input.key}`;
          const id = this.d.repo.db.setting(alias, "") || randomUUID();
          resource = { ...input, key: id };
          previous = this.read(id);
          this.d.repo.db.setSetting(alias, id);
        }
        if (this.active.has(resource.key))
          throw new AppError("BUSY", "这份资源正在处理，请等待完成。");
        if (previous) {
          if (
            comparisonResource(previous.resource) !==
            comparisonResource(resource)
          )
            throw new AppError(
              "STALE_INPUT",
              "资源信息已变化，请返回录入步骤重新确认。",
            );
          return previous;
        }
        if (resource.resourceId) {
          const local = this.d.repo.getResource(resource.resourceId);
          if (
            local.provider !== "baidu" ||
            !local.copies.some((copy) => copy.id === resource.copyId)
          )
            throw new AppError(
              "RESOURCE_CHANGED",
              "资源或副本已变化，请重新选择。",
            );
        }
        return this.store({
          id: resource.key,
          resource,
          copyId: "",
          libraryResourceId: resource.resourceId,
          accountId: "",
          stage: "draft",
          message: "等待生成并检查问答，尚未转存或建链。",
          operations: [],
          links: [],
          rows: [],
          contentFirst: true,
          rowShares: {},
          updatedAt: now(),
        });
      }),
    );
  }
  private assertReviewed(record: PublishingRecord) {
    if (record.contentFirst && !publishingContentReviewed(record))
      throw new AppError(
        "REVIEW_REQUIRED",
        "请先生成并确认1–20条问答，再准备转存和独立链接。",
      );
  }
  private submittedUrls() {
    const rows = this.d.repo.db.all<{ data: string }>(
      "SELECT i.data FROM operation_items i JOIN operation_runs r ON r.id=i.run_id WHERE r.kind='publish' AND i.status IN ('submitted','submitting','uncertain')",
    );
    return new Set(
      rows.flatMap(({ data }) => {
        const item = JSON.parse(data);
        return (
          decodeHtml(`${item.link || ""} ${item.answer || ""}`).match(
            /https?:\/\/[^\s<>"'，。；）)]+/gi,
          ) ?? []
        ).flatMap((raw) => {
          try {
            return [parseShare(raw).url];
          } catch {
            try {
              const url = new URL(raw);
              return url.protocol === "https:" ? [url.href] : [];
            } catch {
              return [];
            }
          }
        });
      }),
    );
  }
  private bindLinks(record: PublishingRecord, historical: Set<string>) {
    if (!record.contentFirst) return record.links.length;
    record.rowShares ??= {};
    const used = new Set(
      Object.values(record.rowShares).map((share) => parseShare(share.url).url),
    );
    for (const row of record.rows) {
      if (!row.id || record.rowShares[row.id]) continue;
      const link = record.links.find(
        (link) =>
          !used.has(parseShare(link.url).url) &&
          !historical.has(parseShare(link.url).url),
      );
      if (link) {
        record.rowShares[row.id] = link;
        used.add(parseShare(link.url).url);
      }
    }
    return record.rows.filter((row) => row.id && record.rowShares?.[row.id])
      .length;
  }
  async prepare(resource: PublishingResource, accountId: string) {
    return this.locked(resource.key, async () => {
      const previous = this.d.repo.db.setting<PublishingRecord | null>(
        key(resource.key),
        null,
      );
      if (previous) {
        this.assertReviewed(previous);
        if (
          comparisonResource(previous.resource) !==
            comparisonResource(resource) ||
          (!resource.resourceId &&
            !!previous.copyId &&
            accountId !== previous.accountId)
        )
          throw new AppError(
            "STALE_INPUT",
            "资源信息已变化，请返回录入步骤重新确认后再处理。",
          );
        if (previous.copyId) return this.get(resource.key);
      }
      const record: PublishingRecord = previous ?? {
        id: resource.key,
        resource,
        copyId: "",
        libraryResourceId: "",
        accountId,
        stage: "preparing",
        message: "正在准备资源。",
        operations: [],
        links: [],
        rows: [],
        updatedAt: now(),
      };
      if (record.contentFirst) record.accountId = accountId;
      this.store(record);
      try {
        if (resource.resourceId) {
          const local = this.d.repo.getResource(resource.resourceId);
          let copy = local.copies.find((c) => c.id === resource.copyId);
          if (local.provider !== "baidu" || !copy)
            throw new AppError(
              "RESOURCE_CHANGED",
              "原资源或副本已移除，请重新选择。",
            );
          if (local.sourceKind === "owned" && copy.status === "recorded") {
            await this.checkShare(record, copy.id);
            copy = this.d.repo.getCopy(copy.id);
          }
          if (local.sourceKind !== "owned" && copy.status !== "ready") {
            const account = this.d.repo.getAccount(copy.accountId);
            if (!account.enabled || !account.uid)
              throw new AppError(
                "ACCOUNT_REQUIRED",
                "请先登录此资源原来的百度网盘账号，再准备资源。",
              );
            const priorJob = this.d.repo.db.get(
              "SELECT id FROM jobs WHERE copy_id=? LIMIT 1",
              copy.id,
            );
            if (copy.status === "draft" && !priorJob) {
              const source = parseShare(
                local.sourceUrl,
                (await this.d.secrets.get(`source:${local.id}`)) || "",
              );
              const selected = this.d.repo.selectedFiles(copy.id);
              await this.d.saveResource({
                id: local.id,
                copyId: copy.id,
                title: local.title,
                sourceText: local.sourceUrl,
                extractionCode: source.code,
                category: local.category,
                summary: local.summary,
                tags: local.tags,
                searchKeywords: resource.keywords,
                accountId: copy.accountId,
                directory: copy.directory,
                selectedFiles: selected.length
                  ? selected
                  : await this.inspectFiles(source),
                enqueue: true,
              });
            }
            record.stage = "transferring";
          } else {
            const options = await this.d.shareCreation.options(copy.id);
            if (options.issue)
              throw new AppError("RESOURCE_UNVERIFIED", options.issue);
            if (!hasVerifiedShare(copy, this.d.repo.getAccount(copy.accountId)))
              throw new AppError(
                "RESOURCE_UNVERIFIED",
                "这份库中资源的本人分享尚未核验，请先在资源库完成核验。",
              );
            record.stage = "sharing";
          }
          record.copyId = copy.id;
          record.accountId = copy.accountId;
        } else {
          const account = this.d.repo.getAccount(accountId);
          if (account.provider !== "baidu" || !account.enabled || !account.uid)
            throw new AppError(
              "ACCOUNT_REQUIRED",
              "请选择已登录的百度网盘账号。",
            );
          const source = parseShare(resource.link);
          // Recover an interrupted local save using its unique source and account; never enqueue it twice.
          const existing = this.d.repo.db.get<{ id: string }>(
            "SELECT id FROM resources WHERE source_url=?",
            source.url,
          );
          const recovered =
            existing &&
            this.d.repo
              .getResource(existing.id)
              .copies.find((c) => c.accountId === accountId);
          if (existing && !previous)
            throw new AppError(
              "RESOURCE_EXISTS",
              "此链接已经在资源库中，请返回第一步从库中选择，避免重复转存。",
            );
          if (recovered) record.copyId = recovered.id;
          else {
            const saved = await this.d.saveResource({
              title: resource.title,
              sourceText: resource.link,
              category: resource.category,
              summary: resource.summary,
              searchKeywords: resource.keywords,
              tags: [],
              accountId,
              directory: account.defaultDirectory,
              selectedFiles: await this.inspectFiles(source),
              enqueue: true,
            });
            record.copyId = saved.copyId;
          }
          record.stage = "transferring";
        }
        const copy = this.d.repo.getCopy(record.copyId);
        record.libraryResourceId = copy.resourceId;
        this.d.repo.db.run(
          "UPDATE resources SET search_keywords=?,updated_at=? WHERE id=?",
          JSON.stringify(resource.keywords),
          now(),
          copy.resourceId,
        );
        record.message =
          record.stage === "transferring"
            ? "转存任务已提交或已存在，关键词已保存。"
            : resource.resourceId
              ? "库中资源已复用，关键词已保存；等待创建分享。"
              : "转存任务已提交，关键词已保存。";
        this.store(record);
        return this.get(record.id);
      } catch (error) {
        record.stage = "failed";
        record.message = safeMessage(error);
        this.store(record);
        throw error;
      }
    });
  }
  private async checkShare(record: PublishingRecord, copyId: string) {
    const checked = await this.d.checkShare(copyId);
    record.shareCheck = checked;
    if (checked.status !== "valid")
      throw new AppError(
        checked.status === "unavailable"
          ? "SHARE_CHECK_UNAVAILABLE"
          : "SHARE_CHANGED",
        shareCheckFailure(checked),
      );
  }
  private async inspectFiles(source: ReturnType<typeof parseShare>) {
    if (!this.d.ports.baiduShareReader)
      throw new AppError("BROWSER_UNAVAILABLE", "请应用后端更新后重试。");
    const inspected = await this.d.ports.baiduShareReader.inspect(
      source,
      "0",
      1,
    );
    if (
      !inspected.files.length ||
      inspected.hasMore ||
      inspected.files.length > 100
    )
      throw new AppError(
        "FILE_SELECTION_REQUIRED",
        "此分享为空或超过一页，请先在资源录入中选择文件并完成转存，再从库中选择。",
      );
    return inspected.files;
  }
  async shares(id: string) {
    return this.locked(id, async () => {
      this.pauses.delete(id);
      const record = this.get(id);
      this.assertReviewed(record);
      if (
        !record.copyId ||
        record.stage === "transferring" ||
        record.transferBlocked
      )
        throw new AppError(
          "TRANSFER_PENDING",
          "请先等待转存完成，再创建分享。",
        );
      const count = record.contentFirst
        ? record.rows.length
        : Math.min(publishingQuestionLimit, record.resource.keywords.length);
      const historical = this.submittedUrls();
      const assigned = () => this.bindLinks(record, historical);
      if (record.stage === "ready" && assigned() >= count) {
        this.assertCurrent(record);
        return record;
      }
      while (record.operations.length < count)
        record.operations.push(randomUUID());
      this.store(record);
      try {
        const copy = this.d.repo.getCopy(record.copyId);
        const account = this.d.repo.getAccount(copy.accountId);
        if (!hasVerifiedShare(copy, account))
          throw new AppError(
            "SHARE_CHANGED",
            "本人分享或归属已变化，请先在资源库核验。",
          );
        await this.checkShare(record, copy.id);
        const current = this.d.repo.getCopy(copy.id);
        if (
          current.shareUrl !== copy.shareUrl ||
          current.shareVersion !== copy.shareVersion ||
          current.ownerUid !== copy.ownerUid
        )
          throw new AppError(
            "SHARE_CHANGED",
            "检查期间本人分享或文件归属已变化，请重新准备资源。",
          );
        if (record.contentFirst) {
          if (
            record.canonicalShare &&
            (record.canonicalShare.url !== copy.shareUrl ||
              record.canonicalShare.version !== copy.shareVersion)
          )
            throw new AppError(
              "SHARE_CHANGED",
              "原本人分享已变化，请重新核对资源。",
            );
          record.canonicalShare = {
            url: copy.shareUrl!,
            version: copy.shareVersion,
          };
        }
        if (
          !record.links.length &&
          (!record.contentFirst ||
            !historical.has(parseShare(copy.shareUrl!).url))
        ) {
          record.links.push({
            url: copy.shareUrl!,
            code: (await this.d.secrets.get(`share:${copy.id}`)) || "",
          });
          assigned();
          this.store(record);
        }
        const finish = () => {
          const issue = record.contentFirst
            ? publishingLinkIssue([record])
            : "";
          if (issue) throw new AppError("SHARE_MISMATCH", issue);
          record.stage = "ready";
          record.message = `已为 ${count} 条问答准备独立链接，可预览并下载。`;
          return this.store(record);
        };
        if (assigned() >= count) return finish();
        const started = Date.now();
        record.message = "正在连接账号并准备本批分享。";
        this.store(record);
        return await this.d.shareCreation.withIndependentSession(
          record.copyId,
          async () => {
            record.connectionMs = Date.now() - started;
            for (let i = record.links.length; assigned() < count; i++) {
              if (this.pauses.has(id)) {
                record.stage = "paused";
                record.message = `已暂停，保留${record.links.length}条分享；继续只处理剩余链接。`;
                return this.store(record);
              }
              record.stage = "sharing";
              record.shareStartedAt = now();
              record.message = `正在创建第${i + 1} / ${count}条分享。`;
              this.store(record);
              record.operations[i] ??= randomUUID();
              const operationId = record.operations[i];
              let receipt = await this.d.shareCreation.result(operationId);
              if (receipt?.state === "uncertain")
                receipt = await this.d.shareCreation.recheck(operationId);
              if (receipt?.state === "failed") {
                record.operations[i] = randomUUID();
                this.store(record);
                receipt = null;
              }
              receipt ??= await this.d.shareCreation.createIndependent({
                operationId: record.operations[i],
                copyId: record.copyId,
                expiresInDays: 0,
              });
              record.lastShareMs =
                Date.now() - Date.parse(record.shareStartedAt);
              delete record.shareStartedAt;
              if (receipt.state !== "success" || !receipt.url) {
                record.stage =
                  receipt.state === "failed" ? "failed" : "uncertain";
                record.message = receipt.message;
                return this.store(record);
              }
              const link = parseShare(receipt.url, receipt.code);
              if (
                record.contentFirst &&
                (record.links.some(
                  (existing) => parseShare(existing.url).url === link.url,
                ) ||
                  historical.has(link.url))
              )
                throw new AppError(
                  "DUPLICATE_URL",
                  "建链回执返回了重复或已提交的URL，未将它分配给问答，请核对后再继续。",
                );
              record.links.push({
                url: link.url,
                code: link.code,
                ...(receipt.expiresAt ? { expiresAt: receipt.expiresAt } : {}),
              });
              assigned();
              record.stage = "sharing";
              record.message = `已创建 ${record.links.length} / ${count} 条分享。`;
              this.store(record);
            }
            return finish();
          },
        );
      } catch (error) {
        delete record.shareStartedAt;
        record.stage = "failed";
        record.message = safeMessage(error);
        this.store(record);
        throw error;
      } finally {
        this.pauses.delete(id);
      }
    });
  }
  async generate(id: string, upgradeLegacy = false, optimize = false) {
    return this.locked(id, async () => {
      const record = this.get(id);
      if (!record.contentFirst && record.stage !== "ready")
        throw new AppError("NOT_READY", "请先完成本资源的转存与分享。");
      const copy = record.contentFirst
        ? record.resource.copyId
          ? this.d.repo.getCopy(record.resource.copyId)
          : undefined
        : this.assertCurrent(record);
      const resuming =
        record.generation &&
        record.generation.status !== "completed" &&
        !optimize;
      if (!resuming) {
        if (record.rows.length) {
          if (!optimize && (!upgradeLegacy || record.legacyUpgraded))
            return record;
          if (upgradeLegacy && !canUpgradeLegacy(record))
            throw new AppError(
              "REVIEW_CHANGED",
              "这份问答已有编辑或审核记录，请保留原稿并在问答检查步骤修改。",
            );
        }
        if (
          !record.contentFirst &&
          record.resource.keywords.length > publishingQuestionLimit
        )
          throw new AppError(
            "QUESTION_LIMIT",
            "旧稿超过20条，请按新流程重新生成并检查问答，旧稿保留。",
          );
        const targets = (
          record.contentFirst && record.rows.length
            ? record.rows
            : record.resource.keywords
        ).flatMap((_, index) => (record.rows[index]?.reviewed ? [] : [index]));
        if (!targets.length && record.rows.length) return record;
        this.d.ai.assertTextConfigured("copy");
        const previousGeneration = record.generation;
        record.generation = {
          id: randomUUID(),
          status: "running",
          targets: record.contentFirst && !record.rows.length ? [] : targets,
          drafts: [],
          ...(record.contentFirst && record.rows.length
            ? {
                topics: record.rows.map((row) => ({
                  id: row.id!,
                  keyword: row.keyword,
                  relatedKeywords: row.relatedKeywords ?? [],
                  intent: previousGeneration?.topics?.find(
                    (topic) => topic.id === row.id,
                  )?.intent,
                })),
                ...(previousGeneration?.planVersion === 2
                  ? {
                      planVersion: 2 as const,
                      excludedKeywords: previousGeneration.excludedKeywords,
                    }
                  : {}),
              }
            : {}),
          ...(upgradeLegacy ? { upgradeLegacy: true as const } : {}),
        };
      } else this.d.ai.assertTextConfigured("copy");
      const generation = record.generation!;
      generation.status = "running";
      delete generation.message;
      this.store(record);
      const assertCurrent = () => {
        if (!record.contentFirst) this.assertCurrent(record);
        const latest = this.get(id);
        if (
          latest.generation?.id !== generation.id ||
          JSON.stringify(latest.rows) !== JSON.stringify(record.rows) ||
          comparisonResource(latest.resource) !==
            comparisonResource(record.resource) ||
          JSON.stringify(latest.links) !== JSON.stringify(record.links)
        )
          throw new AppError(
            "STALE_ROWS",
            "生成期间资源或问答已变化，未覆盖当前内容。请刷新后核对。",
          );
      };
      try {
        if (record.contentFirst && !generation.topics) {
          const plan = await planPublishingTopics(
            this.d.ai,
            record,
            assertCurrent,
          );
          assertCurrent();
          generation.topics = plan.topics.map((topic) => ({
            ...topic,
            id: randomUUID(),
          }));
          generation.planVersion = 2;
          generation.excludedKeywords = plan.excludedKeywords;
          record.keywordPlan = {
            topics: generation.topics,
            excludedKeywords: plan.excludedKeywords,
          };
          generation.targets = plan.topics.map((_, index) => index);
          this.store(record);
        }
        if (record.contentFirst && !generation.topics?.length)
          throw new AppError(
            "NO_PUBLISHING_TOPICS",
            "没有适合生成资源获取问答的关键词。请展开关键词取舍明细，返回上一步调整关键词或补充资源事实。",
          );
        const remaining = generation.targets.filter(
          (index) => !generation.drafts.some((row) => row.index === index),
        );
        for (
          let offset = 0;
          offset < remaining.length;
          offset += publishingGenerationBatchSize
        ) {
          assertCurrent();
          const batch = await generatePublishingBatch(
            this.d.ai,
            record,
            copy?.files ?? [],
            remaining.slice(offset, offset + publishingGenerationBatchSize),
            assertCurrent,
          );
          assertCurrent();
          generation.drafts.push(...batch);
          this.store(record);
        }
        if (generation.planVersion === 2) {
          const issues = await reviewPublishingDrafts(
            this.d.ai,
            record,
            assertCurrent,
          );
          assertCurrent();
          generation.validation = {
            status: issues.length ? "failed" : "passed",
            issues,
          };
          this.store(record);
          if (issues.length)
            throw new AppError(
              "QUESTION_INTENT_REVIEW",
              `问答意图检查发现${issues.length}处问题：${issues.map((issue) => `第${issue.index + 1}条：${issue.reason}`).join("；")}。已生成内容保留，未确认或建链。请返回上一步调整关键词/资源说明后重新生成。`,
            );
        }
        const image = generationResource.shape.image.safeParse(
          record.resource.image,
        );
        const cover =
          image.success && image.data
            ? `<img src="${escapeHtml(image.data)}" alt="${escapeHtml(record.resource.title)}" />`
            : "";
        const previous = record.rows;
        const topics =
          generation.topics ??
          record.resource.keywords.map((keyword) => ({
            keyword,
            id: undefined,
            relatedKeywords: [],
          }));
        record.rows = topics.map((topic, index) => {
          if (previous[index]?.reviewed) return previous[index];
          const draft = generation.drafts.find((row) => row.index === index)!;
          const share = record.contentFirst
            ? undefined
            : assignedShare(record, index);
          const url = share
            ? escapeHtml(shareUrlWithCode(share.url, share.code))
            : "";
          const row = {
            ...(record.contentFirst
              ? { id: topic.id, relatedKeywords: topic.relatedKeywords }
              : {}),
            keyword: topic.keyword,
            question: draft.question,
            answer:
              (record.contentFirst
                ? ""
                : "<p><strong>点击链接获取网盘资源：</strong><br/></p>" +
                  `<p><a href="${url}">${url}</a><br/></p>`) +
              `<p>${escapeHtml(draft.introduction)}</p>${cover}`,
            reviewed: false,
          };
          const issue = publishingQuestionIssue(row, true);
          if (issue) throw new AppError("INVALID_AI_RESPONSE", issue);
          return row;
        });
        if (!previous.some((row) => row.reviewed))
          record.linkedAnswerFormat = true;
        if (generation.upgradeLegacy) record.legacyUpgraded = true;
        generation.status = "completed";
        if (record.contentFirst && !record.copyId)
          record.message = `已生成 ${record.rows.length} 条问答，请检查并确认后准备独立链接。`;
        return this.store(record);
      } catch (error) {
        const latest = this.get(id);
        if (latest.generation?.id === generation.id) {
          latest.generation.status = "failed";
          latest.generation.message = safeMessage(error);
          this.store(latest);
        }
        throw error;
      }
    });
  }
  async generateMany(ids: string[]) {
    const records: PublishingRecord[] = [];
    for (const id of ids) records.push(await this.generate(id));
    return records;
  }
  saveRows(id: string, rows: PublishingRecord["rows"], generationId?: string) {
    const record = this.get(id);
    if (this.active.has(id))
      throw new AppError(
        "BUSY",
        "这份资源正在处理，请完成或停止后再保存问答。",
      );
    if (
      generationId !== undefined &&
      generationId !== (record.generation?.id ?? "")
    )
      throw new AppError(
        "STALE_ROWS",
        "问答生成版本已更新，请重新读取后核对，未覆盖新版内容。",
      );
    if (record.generation && record.generation.status !== "completed")
      throw new AppError(
        "GENERATION_INCOMPLETE",
        "请先完成剩余问答的 AI 生成，再确认保存。",
      );
    if (record.contentFirst) {
      if (
        !rows.length ||
        rows.length > publishingQuestionLimit ||
        new Set(rows.map((row) => row.id)).size !== rows.length
      )
        throw new AppError(
          "QUESTION_LIMIT",
          "请保留1–20条问答，每条问答标识必须唯一。",
        );
      const originals = new Map(record.rows.map((row) => [row.id, row]));
      if (
        rows.some(
          (row) =>
            !row.id ||
            !originals.has(row.id) ||
            row.keyword !== originals.get(row.id)!.keyword ||
            JSON.stringify(row.relatedKeywords ?? []) !==
              JSON.stringify(originals.get(row.id)!.relatedKeywords ?? []),
        )
      )
        throw new AppError(
          "STALE_ROWS",
          "问答标识或关键词不一致，请重新读取。",
        );
      for (const row of rows) {
        if (!row.reviewed) continue;
        const issue = publishingQuestionIssue(row, true);
        if (issue) throw new AppError("CONTENT_REVIEW", issue);
        if (
          answerShares(row.answer).length ||
          /https?:\/\//i.test(row.answer.replace(/<img\b[^>]*>/gi, ""))
        )
          throw new AppError(
            "CONTENT_REVIEW",
            "此步只填写资源介绍，独立链接将在确认后自动准备，请移除正文中的链接。",
          );
      }
      const titles = rows.map((row) => publishingTextKey(row.question));
      if (new Set(titles).size !== titles.length)
        throw new AppError(
          "DUPLICATE_TITLE",
          "存在重复的问题标题，请修改后确认。",
        );
      record.rows = rows;
      if (!record.copyId) {
        record.stage = "draft";
        record.message = rows.every((row) => row.reviewed)
          ? `已确认 ${rows.length} 条问答，等待准备独立链接。`
          : "问答修改已保存，请确认后再准备独立链接。";
      } else if (record.stage === "ready")
        record.message = `已为 ${rows.length} 条问答准备独立链接，可预览并下载。`;
      return this.store(record);
    }
    if (
      !record.rows.length ||
      record.rows.length !== rows.length ||
      rows.some((row, i) => row.keyword !== record.rows[i].keyword)
    )
      throw new AppError(
        "STALE_ROWS",
        "问答行与原关键词不一致，请重新读取当前资源。",
      );
    rows.forEach((row, index) => {
      if (!row.reviewed) return;
      const issue = publishingQuestionIssue(row, record.linkedAnswerFormat);
      if (issue) throw new AppError("CONTENT_REVIEW", issue);
      checkAnswerShare(record, row, index);
    });
    record.rows = rows;
    return this.store(record);
  }
  linkOptions(ids: string[]): PublishingPublicLinks {
    const records = ids.map((id) => this.get(id));
    if (
      records.length !== 1 ||
      records.reduce((n, record) => n + record.rows.length, 0) !== 1
    )
      throw new AppError(
        "SINGLE_QUESTION_REQUIRED",
        "仅单个问答可使用资源落地页或直达链接，多条问答请使用网盘独立链接。",
      );
    if (!records[0].contentFirst)
      throw new AppError(
        "LEGACY_WORKFLOW",
        "旧稿请按新流程重新检查问答及链接，再选择资源入口。",
      );
    const id = records[0].libraryResourceId || records[0].resource.resourceId;
    if (!id || !this.d.resourcePublishedUrls)
      return {
        landingUrl: null,
        redirectUrl: null,
        landingIssue: "请先在资源库准备资源落地页。",
        redirectIssue: "请先在资源库准备固定直达链接。",
        revision: "",
      };
    return this.d.resourcePublishedUrls(id);
  }
  private destination(
    ids: string[],
    linkType: PublishingLinkType,
    revision?: string,
  ): PublishingDestination | undefined {
    if (linkType === "drive") return;
    const links = this.linkOptions(ids),
      url = linkType === "landing" ? links.landingUrl : links.redirectUrl;
    const issue =
      linkType === "landing" ? links.landingIssue : links.redirectIssue;
    if (issue || !url)
      throw new AppError(
        "PUBLIC_LINK_NOT_READY",
        issue || "资源入口尚未就绪，请在资源库维护后重试。",
      );
    if (revision !== links.revision)
      throw new AppError(
        "PUBLIC_LINK_CHANGED",
        "资源入口已变化，请刷新链接选项并重新预览后再提交。",
      );
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.search ||
      parsed.hash ||
      !new RegExp(
        `^/${linkType === "landing" ? "r" : "go"}/[A-Za-z0-9_-]+$`,
      ).test(parsed.pathname)
    )
      throw new AppError(
        "PUBLIC_LINK_NOT_READY",
        "资源入口地址无效，请在资源库核对。",
      );
    return { type: linkType, url: parsed.href, revision: links.revision };
  }
  private publicationRows(
    ids: string[],
    linkType: PublishingLinkType = "drive",
    revision?: string,
  ) {
    const records = ids.map((id) => this.get(id));
    if (
      records.some(
        (record) =>
          record.stage !== "ready" ||
          (record.generation && record.generation.status !== "completed") ||
          !record.rows.length ||
          record.rows.some(
            (row) =>
              !row.reviewed ||
              publishingQuestionIssue(row, record.linkedAnswerFormat),
          ),
      )
    )
      throw new AppError(
        "REVIEW_REQUIRED",
        "请先保存并审核全部问答，再下载表格。",
      );
    const linkIssue = publishingLinkIssue(records);
    if (linkIssue) throw new AppError("SHARE_MISMATCH", linkIssue);
    const destination = this.destination(ids, linkType, revision);
    const rows = records.flatMap((r) =>
      publishingRowsWithLinks(r, r.rows, destination),
    );
    for (const record of records) {
      this.assertCurrent(record);
      publishingRowsWithLinks(record).forEach((row, index) =>
        checkAnswerShare(record, row, index),
      );
    }
    const historical = this.submittedUrls();
    if (
      records.some((record) =>
        record.rows.some((row, index) =>
          historical.has(
            destination?.url ??
              parseShare(publishingRowShare(record, row, index)!.url).url,
          ),
        ),
      )
    )
      throw new AppError(
        "URL_ALREADY_SUBMITTED",
        "有分享URL已提交或结果待核对，请先核对发布记录，避免重复提交。",
      );
    const titles = rows.map((row) => publishingTextKey(row.question));
    if (new Set(titles).size !== titles.length)
      throw new AppError(
        "DUPLICATE_TITLE",
        "表格中存在重复标题，请返回第三步修改。",
      );
    return { records, rows, destination };
  }
  async export(
    ids: string[],
    linkType: PublishingLinkType = "drive",
    revision?: string,
  ) {
    const { rows } = this.publicationRows(ids, linkType, revision);
    return this.d.ports.saveFile(
      "百度知道问答.xlsx",
      publicationWorkbook(rows),
    );
  }
  publish(
    ids: string[],
    accountId: string,
    taskName: string,
    selectionRevision: string,
    linkType: PublishingLinkType = "drive",
    linkRevision?: string,
  ) {
    if (!this.d.publication)
      throw new AppError("UPDATE_REQUIRED", "请应用后端更新后上传。");
    if (ids.some((id) => this.active.has(id)))
      throw new AppError("BUSY", "问答或链接仍在处理，请等待完成后上传。");
    const existing = ids.map((id) => this.get(id));
    if (existing.some((record) => record.publicationRunId)) {
      const runId = existing[0].publicationRunId;
      const run = runId && this.d.publication.get(runId);
      if (
        run &&
        existing.every((record) => record.publicationRunId === runId) &&
        run.config.accountId === accountId &&
        (run.config.workflowLinkType ?? "drive") === linkType &&
        JSON.stringify([...(run.config.workflowIds as string[])].sort()) ===
          JSON.stringify([...ids].sort())
      )
        return run;
      throw new AppError(
        "ALREADY_SUBMITTED",
        "本批有问答已关联发布任务，请查看原发布记录，避免重复上传。",
      );
    }
    if (selectionRevision !== publishingSelectionRevision(existing))
      throw new AppError(
        "SELECTION_CHANGED",
        "本批问答或链接已更新，请刷新并预览后再上传。",
      );
    const { records, destination } = this.publicationRows(
      ids,
      linkType,
      linkRevision,
    );
    if (records.some((record) => !record.contentFirst))
      throw new AppError(
        "LEGACY_WORKFLOW",
        "请先按新流程检查问答及独立链接，旧稿仍可下载。",
      );
    return this.d.publication.start(
      records,
      accountId,
      taskName,
      (run) => {
        for (const record of records)
          this.store({ ...record, publicationRunId: run.id });
      },
      destination,
    );
  }
  validatePublicationItem(item: OperationItem) {
    const source = item.workflowSource!;
    const { records, rows, destination } = this.publicationRows(
      [source.recordId],
      source.linkType,
      source.linkRevision,
    );
    const record = records[0],
      index = record.rows.findIndex((row) => row.id === source.rowId);
    const row = rows[index],
      share =
        index >= 0 && publishingRowShare(record, record.rows[index], index);
    if (
      !row ||
      !share ||
      item.copyId !== record.copyId ||
      item.question !== row.question ||
      item.answer !== row.answer ||
      item.link !== (destination?.url ?? share.url) ||
      item.code !== (destination ? "" : share.code) ||
      this.d.repo.getCopy(record.copyId).shareVersion !== item.shareVersion
    )
      throw new AppError(
        "SELECTION_CHANGED",
        "问答或独立链接已变化，请核对原发布任务，不会上传旧内容。",
      );
  }
  private assertCurrent(record: PublishingRecord) {
    const copy = this.d.repo.getCopy(record.copyId);
    if (
      !hasVerifiedShare(copy, this.d.repo.getAccount(copy.accountId)) ||
      (record.contentFirst
        ? !record.canonicalShare ||
          copy.shareUrl !== record.canonicalShare.url ||
          copy.shareVersion !== record.canonicalShare.version
        : record.links.length && copy.shareUrl !== record.links[0].url)
    )
      throw new AppError(
        "SHARE_CHANGED",
        "本人分享或归属已变化，请在资源库核验，再返回第一步移除后重新选择该资源。",
      );
    if (
      record.links.some(
        (link) => link.expiresAt && Date.parse(link.expiresAt) <= Date.now(),
      )
    )
      throw new AppError(
        "SHARE_EXPIRED",
        "本资源已准备的分享中有已过期链接，请核对后重新准备。",
      );
    return copy;
  }
}

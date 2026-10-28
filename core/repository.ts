import type { PublicationDeliveryCheck } from "../shared/publication-checks";
import { defaultContentFormat } from "../shared/channels";
import type {
  Account,
  AppSnapshot,
  AppSettings,
  ApiCall,
  ApiPlan,
  ApiUsage,
  BrowserBinding,
  Draft,
  Job,
  Pool,
  Publication,
  Resource,
  ResourcePage,
  ResourceTotals,
  ResourceCopy,
  RemoteFile,
  SuggestionQuery,
  TrafficResult,
} from "../shared/types";
import { Database, now, parseJson } from "./database";
import { AppError } from "./errors";
import packageInfo from "../package.json" with { type: "json" };
import { resolveAiModels } from "../shared/ai-models";
import { accountCapacitySchema } from "../shared/drive-capacity";
import { resourceTags } from "./resource-tags";
export type Row = Record<string, any>;
export class Repository {
  constructor(readonly db: Database) {}
  account(row: Row): Account {
    const capacity = accountCapacitySchema.safeParse(
      this.db.setting(`account:capacity:${row.id}`, null),
    );
    return {
      id: row.id,
      provider: row.provider,
      alias: row.alias,
      uid: row.uid,
      status: row.status,
      enabled: !!row.enabled,
      isDefault: !!row.is_default,
      defaultDirectory: row.default_directory,
      lastVerifiedAt: row.verified_at,
      error: row.error,
      capacity:
        capacity.success && capacity.data.ownerUid === row.uid
          ? capacity.data
          : null,
      ...(row.copy_count == null
        ? {}
        : { resourceCopies: Number(row.copy_count) }),
    };
  }
  accounts() {
    return this.db
      .all<Row>(
        "SELECT a.*,(SELECT count(*) FROM copies c WHERE c.account_id=a.id) copy_count FROM accounts a ORDER BY provider,is_default DESC,created_at",
      )
      .map((r) => this.account(r));
  }
  getAccount(id: string) {
    const row = this.db.get<Row>("SELECT * FROM accounts WHERE id=?", id);
    if (!row) throw new AppError("NOT_FOUND", "账号不存在。");
    return this.account(row);
  }
  copy(row: Row): ResourceCopy {
    return {
      id: row.id,
      resourceId: row.resource_id,
      accountId: row.account_id,
      directory: row.directory,
      folderId: row.folder_id,
      files: parseJson(row.files, []),
      status: row.status,
      ownerUid: row.owner_uid,
      verifiedAt: row.verified_at,
      shareId: row.share_id,
      shareUrl: row.share_url,
      shareOwnerUid: row.share_owner_uid,
      shareVersion: row.share_version,
      shareVerifiedAt: row.share_verified_at,
      noteStatus: row.note_status,
      error: row.error,
    };
  }
  getCopy(id: string) {
    const row = this.db.get<Row>("SELECT * FROM copies WHERE id=?", id);
    if (!row) throw new AppError("NOT_FOUND", "资源副本不存在。");
    return this.copy(row);
  }
  resource(row: Row): Resource {
    return {
      id: row.id,
      title: row.title,
      sourceUrl: row.source_url,
      sourceKind: row.source_kind ?? "share",
      provider: row.provider,
      category: row.category,
      tags: resourceTags(parseJson<string[]>(row.tags, [])),
      summary: row.summary,
      coverId: row.cover_id,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      copies: this.db
        .all<Row>(
          "SELECT * FROM copies WHERE resource_id=? ORDER BY created_at",
          row.id,
        )
        .map((r) => this.copy(r)),
    };
  }
  resources(query = "") {
    const normalized = query.trim().slice(0, 200);
    let rows: Row[];
    if (normalized.length >= 3)
      rows = this.db.all<Row>(
        "SELECT r.* FROM resources r JOIN resource_search s ON r.rowid=s.rowid WHERE resource_search MATCH ? ORDER BY r.updated_at DESC LIMIT 500",
        `"${normalized.replace(/"/g, '""')}"`,
      );
    else if (normalized) {
      const term = `%${normalized.replace(/[\\%_]/g, "\\$&")}%`;
      rows = this.db.all<Row>(
        "SELECT * FROM resources WHERE title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 500",
        term,
        term,
        term,
      );
    } else
      rows = this.db.all<Row>(
        "SELECT * FROM resources ORDER BY updated_at DESC LIMIT 500",
      );
    return rows.map((r) => this.resource(r));
  }
  getResource(id: string) {
    const row = this.db.get<Row>("SELECT * FROM resources WHERE id=?", id);
    if (!row) throw new AppError("NOT_FOUND", "资源不存在。");
    return this.resource(row);
  }
  resourcePage(input: {
    query: string;
    category: string;
    accountId: string;
    page: number;
    pageSize: number;
  }): ResourcePage {
    const where: string[] = [],
      values: (string | number)[] = [];
    const query = input.query.trim();
    if (query.length >= 3) {
      where.push(
        "r.rowid IN (SELECT rowid FROM resource_search WHERE resource_search MATCH ?)",
      );
      values.push(`"${query.replace(/"/g, '""')}"`);
    } else if (query) {
      where.push(
        "(r.title LIKE ? ESCAPE '\\' OR r.summary LIKE ? ESCAPE '\\' OR r.tags LIKE ? ESCAPE '\\')",
      );
      const term = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
      values.push(term, term, term);
    }
    if (input.category !== "all") {
      where.push("r.category=?");
      values.push(input.category);
    }
    if (input.accountId !== "all") {
      where.push(
        "EXISTS(SELECT 1 FROM copies c WHERE c.resource_id=r.id AND c.account_id=?)",
      );
      values.push(input.accountId);
    }
    const filter = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const total = this.db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM resources r${filter}`,
      ...values,
    )!.n;
    const page = Math.max(
      1,
      Math.min(input.page, Math.max(1, Math.ceil(total / input.pageSize))),
    );
    return {
      items: this.db
        .all<Row>(
          `SELECT r.* FROM resources r${filter} ORDER BY r.updated_at DESC,r.id LIMIT ? OFFSET ?`,
          ...values,
          input.pageSize,
          (page - 1) * input.pageSize,
        )
        .map((r) => this.resource(r)),
      total,
      page,
      pageSize: input.pageSize,
    };
  }
  resourceTotals(): ResourceTotals {
    return {
      resources: this.db.get<{ n: number }>("SELECT COUNT(*) n FROM resources")!
        .n,
      readyCopies: this.db.get<{ n: number }>(
        "SELECT COUNT(*) n FROM copies WHERE status='ready'",
      )!.n,
      attentionJobs: this.db.get<{ n: number }>(
        "SELECT COUNT(*) n FROM jobs WHERE stage NOT IN ('completed','cancelled')",
      )!.n,
      categories: this.db
        .all<{ category: string }>(
          "SELECT DISTINCT category FROM resources ORDER BY category",
        )
        .map((r) => r.category),
    };
  }
  selectedFiles(copyId: string) {
    return parseJson<RemoteFile[]>(
      this.db.get<Row>("SELECT selected_files FROM copies WHERE id=?", copyId)
        ?.selected_files,
      [],
    );
  }
  jobs(activeOnly = false): Job[] {
    return this.db
      .all<Row>(
        `SELECT j.*,r.id resource_id,r.title,c.account_id FROM jobs j JOIN copies c ON c.id=j.copy_id JOIN resources r ON r.id=c.resource_id ${activeOnly ? "WHERE j.stage IN ('queued','preflight','transferring','verifying','sharing','archiving')" : ""} ORDER BY j.created_at DESC,j.rowid DESC ${activeOnly ? "" : "LIMIT 300"}`,
      )
      .map((r) => this.job(r));
  }
  private job(r: Row): Job {
    return {
      kind: r.kind ?? "transfer",
      targetId: r.target_id ?? null,
      batchId: r.batch_id ?? null,
      id: r.id,
      copyId: r.copy_id,
      resourceId: r.resource_id,
      title:
        r.kind === "split_share" && r.target_id
          ? (this.db.get<{ path: string }>(
              "SELECT path FROM split_items WHERE id=?",
              r.target_id,
            )?.path ?? r.title)
          : r.title,
      accountId: r.account_id,
      stage: r.stage,
      checkpoint: r.checkpoint,
      attempts: r.attempts,
      error: r.error,
      logs: parseJson(r.logs, []),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  getJob(id: string) {
    const row = this.db.get<Row>(
      "SELECT j.*,r.id resource_id,r.title,c.account_id FROM jobs j JOIN copies c ON c.id=j.copy_id JOIN resources r ON r.id=c.resource_id WHERE j.id=?",
      id,
    );
    if (!row) throw new AppError("NOT_FOUND", "任务不存在。");
    return this.job(row);
  }
  jobMetadata(id: string) {
    return parseJson<Row>(
      this.db.get<Row>("SELECT metadata FROM jobs WHERE id=?", id)?.metadata,
      {},
    );
  }
  log(id: string, message: string) {
    const job = this.getJob(id);
    const logs = [...job.logs, { at: now(), message }].slice(-150);
    this.db.run(
      "UPDATE jobs SET logs=?,updated_at=? WHERE id=?",
      JSON.stringify(logs),
      now(),
      id,
    );
  }
  drafts(resourceId?: string): Draft[] {
    return this.db
      .all<Row>(
        resourceId
          ? "SELECT * FROM drafts WHERE resource_id=? ORDER BY updated_at DESC"
          : "SELECT * FROM drafts ORDER BY updated_at DESC LIMIT 500",
        ...(resourceId ? [resourceId] : []),
      )
      .map((r) => this.draftRow(r));
  }
  private draftRow(r: Row): Draft {
    const creative = this.db.get<{ data: string }>(
      "SELECT data FROM studio_packages WHERE draft_id=?",
      r.id,
    );
    return {
      contentFormat: r.content_format || defaultContentFormat(r.platform),
      creative: creative ? parseJson(creative.data, null) : null,
      topicId: r.topic_id ?? null,
      splitItemId: r.split_item_id ?? null,
      splitShareVersion: r.split_share_version ?? null,
      id: r.id,
      resourceId: r.resource_id,
      copyId: r.copy_id,
      platform: r.platform,
      poolId: r.pool_id,
      title: r.title,
      body: r.body,
      tags: parseJson(r.tags, []),
      coverText: r.cover_text,
      version: r.version,
      resourceRevision: r.resource_revision,
      shareVersion: r.share_version,
      model: r.model,
      reviewed: !!r.reviewed,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  draft(id: string) {
    const item = this.db.get<Row>("SELECT * FROM drafts WHERE id=?", id);
    if (!item) throw new AppError("NOT_FOUND", "草稿不存在。");
    return this.draftRow(item);
  }
  pools(): Pool[] {
    return this.db
      .all<Row>("SELECT * FROM pools ORDER BY created_at DESC")
      .map((r) => ({
        id: r.id,
        name: r.name,
        resourceId: r.resource_id,
        keywords: parseJson(r.keywords, []),
        createdAt: r.created_at,
      }));
  }
  bindings(): BrowserBinding[] {
    return this.db
      .all<Row>("SELECT * FROM browser_bindings ORDER BY platform,alias")
      .map((r) => ({
        id: r.id,
        platform: r.platform,
        alias: r.alias,
        capabilities: parseJson(r.capabilities, {
          formats: [],
          linkPositions: [],
        }),
        windowId: r.window_id,
        websiteAccountId: r.website_account_id ?? null,
        editorUrl: r.editor_url,
        linkPermission: r.link_permission,
        ruleNote: r.rule_note,
        verifiedAt: r.verified_at,
        lastCheckedAt: r.last_checked_at,
        lastOpenedAt: r.last_opened_at,
        openError: r.open_error,
      }));
  }
  deliveryChecks(publicationId: string): PublicationDeliveryCheck[] {
    return this.db
      .all<{ data: string }>(
        "SELECT data FROM publication_delivery_checks WHERE publication_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100",
        publicationId,
      )
      .map((r) => parseJson<PublicationDeliveryCheck | null>(r.data, null))
      .filter((v): v is PublicationDeliveryCheck => v !== null);
  }
  calls(): ApiCall[] {
    return this.db
      .all<Row>("SELECT * FROM api_calls ORDER BY created_at DESC LIMIT 500")
      .map((r) => ({
        id: r.id,
        endpoint: r.endpoint,
        phase: r.phase,
        units: r.units,
        requestCount: r.request_count,
        estimatedMicros: r.estimated_micros,
        reservedMicros: r.reserved_micros,
        confirmedMicros: r.confirmed_micros,
        status: r.status,
        message: r.message,
        createdAt: r.created_at,
      }));
  }
  usage(currency: "CNY" | "USD"): ApiUsage {
    const row = this.db.get<Row>(
      `SELECT
        COALESCE(SUM(request_count),0) request_count,
        COALESCE(SUM(CASE WHEN status='cache' THEN 1 ELSE 0 END),0) cache_hits,
        COALESCE(SUM(CASE WHEN status='success' THEN estimated_micros ELSE 0 END),0) estimated_micros,
        COALESCE(SUM(CASE WHEN status='success' AND estimated_micros IS NULL THEN 1 ELSE 0 END),0) estimate_unknown,
        COALESCE(SUM(confirmed_micros),0) confirmed_micros,
        COALESCE(SUM(CASE WHEN request_count>0 AND confirmed_micros IS NULL THEN 1 ELSE 0 END),0) confirmed_unknown,
        COALESCE(SUM(CASE WHEN status IN ('reserved','uncertain') THEN COALESCE(reserved_micros,estimated_micros,0) ELSE 0 END),0) pending_micros,
        COALESCE(SUM(CASE WHEN status IN ('reserved','uncertain') AND reserved_micros IS NULL AND estimated_micros IS NULL THEN 1 ELSE 0 END),0) pending_unknown,
        COALESCE(SUM(CASE WHEN status IN ('reserved','uncertain') THEN 1 ELSE 0 END),0) pending_count
      FROM api_calls WHERE (endpoint='openrouter')=?`,
      currency === "USD" ? 1 : 0,
    )!;
    return {
      currency,
      requestCount: row.request_count,
      cacheHits: row.cache_hits,
      estimatedMicros: row.estimated_micros,
      estimateUnknownCount: row.estimate_unknown,
      confirmedMicros: row.confirmed_micros,
      confirmedUnknownCount: row.confirmed_unknown,
      pendingMicros: row.pending_micros,
      pendingUnknownCount: row.pending_unknown,
      pendingCount: row.pending_count,
    };
  }
  suggestions(): SuggestionQuery[] {
    const revision = this.db.setting("keyRevision:suggest", "");
    return this.db
      .all<Row>(
        "SELECT * FROM suggestion_queries ORDER BY last_requested_at DESC LIMIT 100",
      )
      .map((r) => ({
        id: r.id,
        seed: r.seed,
        platform: r.platform,
        status: r.status,
        message: r.message,
        createdAt: r.created_at,
        lastRequestedAt: r.last_requested_at,
        resultCount:
          parseJson<TrafficResult | null>(r.result, null)?.keywords.length ?? 0,
        canRequest: r.key_revision === revision,
      }));
  }
  plans(hasSecret: (key: string) => boolean): ApiPlan[] {
    return this.db.all<Row>("SELECT * FROM api_plans").map((r) => ({
      endpoint: r.endpoint,
      configured: hasSecret(`5118:${r.endpoint}`),
      unitPriceMicros: r.unit_price_micros,
      dailyUnits: r.daily_units,
      dailyBudgetMicros: r.daily_budget_micros,
      enabled: !!r.enabled,
    }));
  }
  snapshot(
    hasSecret: (key: string) => boolean,
    dataPath: string,
    resourceId?: string,
  ): AppSnapshot {
    const settings: AppSettings = {
      vaultPath: this.db.setting("vaultPath", null),
      exportCodes: this.db.setting("exportCodes", false),
      model: this.db.setting("model", ""),
      aiModels: resolveAiModels(
        this.db.setting("aiModels", null),
        this.db.setting("model", ""),
      ),
      openrouterConfigured: hasSecret("openrouter"),
      bitUrl: this.db.setting("bitUrl", ""),
      bitConfigured: hasSecret("bit"),
      dailyAiBudgetMicros: this.db.setting("dailyAiBudgetMicros", null),
      previousWorkspace: !!this.db.setting("restorePreviousDataPath", ""),
    };
    const resources = this.resources();
    if (resourceId && !resources.some((r) => r.id === resourceId)) {
      const row = this.db.get<Row>(
        "SELECT * FROM resources WHERE id=?",
        resourceId,
      );
      if (row) resources.push(this.resource(row));
    }
    const publications: Publication[] = this.db
      .all<Row>(
        resourceId
          ? "SELECT p.* FROM publications p JOIN drafts d ON p.draft_id=d.id WHERE d.resource_id=? ORDER BY p.created_at DESC"
          : "SELECT * FROM publications ORDER BY created_at DESC LIMIT 300",
        ...(resourceId ? [resourceId] : []),
      )
      .map((r) => ({
        id: r.id,
        draftId: r.draft_id,
        draftVersion: r.draft_version,
        bindingId: r.binding_id,
        status: r.status,
        url: r.url,
        createdAt: r.created_at,
      }));
    return {
      accounts: this.accounts(),
      resources,
      resourceTotals: this.resourceTotals(),
      shareChecks: this.db
        .all<Row>("SELECT * FROM share_checks ORDER BY checked_at DESC")
        .map((r) => ({
          copyId: r.copy_id,
          status: r.status,
          checkedAt: r.checked_at,
          message: r.message,
        })),
      jobs: this.jobs(),
      pools: this.pools(),
      drafts: this.drafts(resourceId),
      bindings: this.bindings(),
      publications,
      plans: this.plans(hasSecret),
      apiCalls: this.calls(),
      apiUsage: { cny: this.usage("CNY"), usd: this.usage("USD") },
      suggestionQueries: this.suggestions(),
      asyncQueries: this.db
        .all<Row>(
          "SELECT * FROM async_queries ORDER BY created_at DESC LIMIT 100",
        )
        .map((r) => ({
          taskId: r.task_id,
          seeds: parseJson(r.seeds, []),
          status: r.status,
          createdAt: r.created_at,
          lastPolledAt: r.last_polled_at,
        })),
      settings,
      appVersion: packageInfo.version,
      dataPath,
    };
  }
}

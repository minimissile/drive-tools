import { createHash } from "node:crypto";
import { id, now, parseJson } from "./database";
import type { Repository, Row } from "./repository";
import type { ResourceCopy, Provider } from "../shared/types";
import { resourceTags } from "./resource-tags";
import type { AppPorts } from "./ports";
import type { WebsiteAccounts } from "./website-accounts";
import { AppError } from "./errors";
import { parseShare } from "./links";
import { catalogPublicText as publicText } from "./catalog-content";
import { hasVerifiedShare } from "../shared/share-status";
import { providerSpecs } from "../shared/providers";
import {
  documentPlatformSpecs,
  documentPlatformUrl,
} from "../shared/document-platforms";
import {
  catalogSaveSchema,
  catalogPrepareSchema,
  catalogConfirmSchema,
  type ResourceCatalog,
  type CatalogSnapshot,
  type CatalogItem,
  type CatalogDiff,
  type CatalogPreparation,
  type CatalogReceipt,
  type CatalogDetail,
  type CatalogSummary,
  catalogResourcesSchema,
  catalogRemoveItemsSchema,
  type CatalogResourceOption,
} from "../shared/resource-catalog";
import { xlsx } from "./export-formats";
import { CatalogLandings } from "./catalog-landing";
import type { ResourceLinks } from "./resource-links";
import type { AiService } from "./ai";
import { CatalogAiDrafts } from "./catalog-ai";

const indexKey = "resourceCatalogs:index:v1";
const catalogKey = (catalogId: string) => `resourceCatalog:v1:${catalogId}`;
const snapshotKey = (catalogId: string, snapshotId: string) =>
  `${catalogKey(catalogId)}:snapshot:${snapshotId}`;
interface StoredCatalog {
  catalog: ResourceCatalog;
  preparations: CatalogPreparation[];
  publications: CatalogReceipt[];
  history: CatalogReceipt[];
  nextVersion: number;
}
interface CatalogResourceRow {
  id: string;
  title: string;
  category: string;
  summary: string;
  tags: string;
}
const resourceOption = (row: CatalogResourceRow): CatalogResourceOption => ({
  resourceId: row.id,
  title: publicText(row.title),
  category: publicText(row.category),
  summary: publicText(row.summary),
  tags: resourceTags(parseJson<string[]>(row.tags, [])).map(publicText),
});
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const markdown = (text: string) =>
  text.replace(/([\\`*{}\[\]<>#|])/g, "\\$1").replace(/\r?\n/g, " ");
const documentIdentity = (value: string) => {
  const url = new URL(value);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
};

export function catalogDiff(
  before: CatalogSnapshot,
  after: CatalogSnapshot,
): CatalogDiff {
  const oldItems = new Map(before.items.map((item) => [item.resourceId, item]));
  const newItems = new Map(after.items.map((item) => [item.resourceId, item]));
  return {
    added: after.items.filter((item) => !oldItems.has(item.resourceId)),
    changed: after.items.filter(
      (item) =>
        oldItems.has(item.resourceId) &&
        digest(oldItems.get(item.resourceId)) !== digest(item),
    ),
    removed: before.items.filter((item) => !newItems.has(item.resourceId)),
    metadataChanged:
      before.title !== after.title ||
      before.category !== after.category ||
      before.introduction !== after.introduction ||
      before.items
        .filter((item) => newItems.has(item.resourceId))
        .map((item) => item.resourceId)
        .join("\0") !==
        after.items
          .filter((item) => oldItems.has(item.resourceId))
          .map((item) => item.resourceId)
          .join("\0"),
  };
}

export function catalogDocument(snapshot: CatalogSnapshot) {
  const emptyMessage = snapshot.items.length
    ? ""
    : "此清单暂时没有可访问资源，请稍后查看更新。";
  const rows = snapshot.items.map((item) => [
    item.title,
    item.category,
    item.summary,
    item.tags.join("、"),
    item.links
      .map(
        (link) =>
          `${link.provider}：${link.url}${link.code ? ` 提取码：${link.code}` : ""}`,
      )
      .join("\n"),
  ]);
  const text = [
    snapshot.title,
    snapshot.introduction,
    emptyMessage,
    ...snapshot.items.map((item, index) =>
      [
        `${index + 1}. ${item.title}`,
        item.summary,
        item.tags.length ? `标签：${item.tags.join("、")}` : "",
        ...item.links.map(
          (link) =>
            `${link.provider}：${link.url}${link.code ? `\n提取码：${link.code}` : ""}`,
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
  const md =
    [
      `# ${markdown(snapshot.title)}`,
      markdown(snapshot.introduction),
      emptyMessage,
      ...snapshot.items.map((item, index) =>
        [
          `## ${index + 1}. ${markdown(item.title)}`,
          markdown(item.summary),
          item.tags.length ? `标签：${markdown(item.tags.join("、"))}` : "",
          ...item.links.map(
            (link) =>
              `[${markdown(link.provider)}](${link.url})${link.code ? ` · 提取码：${markdown(link.code)}` : ""}`,
          ),
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
    ]
      .filter(Boolean)
      .join("\n\n") + "\n";
  const html = `<article><h1>${escapeHtml(snapshot.title)}</h1>${snapshot.introduction ? `<p>${escapeHtml(snapshot.introduction).replace(/\n/g, "<br>")}</p>` : ""}${emptyMessage ? `<p>${emptyMessage}</p>` : ""}${snapshot.items
    .map(
      (item, index) =>
        `<section><h2>${index + 1}. ${escapeHtml(item.title)}</h2>${item.summary ? `<p>${escapeHtml(item.summary).replace(/\n/g, "<br>")}</p>` : ""}${item.tags.length ? `<p>标签：${escapeHtml(item.tags.join("、"))}</p>` : ""}${item.links.map((link) => `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.provider)} · 查看资源</a>${link.code ? `　提取码：${escapeHtml(link.code)}` : ""}</p>`).join("")}</section>`,
    )
    .join("")}</article>`;
  return {
    text,
    md,
    html,
    rows: [
      ["资源名称", "分类", "资源说明", "标签", "本人分享链接与提取码"],
      ...(emptyMessage ? [[emptyMessage, "", "", "", ""]] : []),
      ...rows,
    ],
  };
}

/** Local curation and explicit handoff. No cloud document is created or changed here. */
export class ResourceCatalogs {
  private aiDrafts?: CatalogAiDrafts;
  private site?: CatalogLandings;
  private active = new Set<string>();
  private readers = 0;
  private previewCache = new Map<
    string,
    { sourceRevision: string; snapshot: CatalogSnapshot }
  >();
  constructor(
    private repo: Repository,
    private ports: AppPorts,
    private accounts: WebsiteAccounts,
    private changed: () => void,
    private readSecret: (key: string) => Promise<string | null> = async () =>
      null,
    links?: ResourceLinks,
    ai?: AiService,
  ) {
    if (links) this.site = new CatalogLandings(repo, links, changed);
    if (ai) this.aiDrafts = new CatalogAiDrafts(repo, ai, changed);
  }
  get isBusy() {
    return this.active.size > 0 || this.readers > 0 || !!this.aiDrafts?.isBusy;
  }
  private get aiCatalogs() {
    if (!this.aiDrafts)
      throw new AppError(
        "CATALOG_AI_UNAVAILABLE",
        "请先应用当前后端更新，再使用AI清单。",
      );
    return this.aiDrafts;
  }
  aiStart(input: unknown) {
    return this.aiCatalogs.start(input);
  }
  aiGet(id: string) {
    return this.aiCatalogs.get(id);
  }
  aiStep(id: string, retryUncertain = false) {
    return this.aiCatalogs.step(id, retryUncertain);
  }
  resourceDetails(ids: string[]): CatalogResourceOption[] {
    return this.repo.db
      .all<{
        id: string;
        title: string;
        category: string;
        summary: string;
        tags: string;
      }>(
        "SELECT id,title,category,summary,tags FROM resources WHERE id IN (SELECT value FROM json_each(?))",
        JSON.stringify(ids),
      )
      .map(resourceOption);
  }
  resources(raw: unknown) {
    const input = catalogResourcesSchema.parse(raw);
    const where =
      "WHERE (?='all' OR category=?) AND (?='' OR instr(lower(title || char(10) || summary || char(10) || tags),lower(?))>0)";
    const values = [input.category, input.category, input.query, input.query];
    const total =
      this.repo.db.get<{ n: number }>(
        `SELECT COUNT(*) n FROM resources ${where}`,
        ...values,
      )?.n ?? 0;
    const rows = this.repo.db.all<{
      id: string;
      title: string;
      category: string;
      summary: string;
      tags: string;
    }>(
      `SELECT id,title,category,summary,tags FROM resources ${where} ORDER BY title COLLATE NOCASE,id LIMIT 30 OFFSET ?`,
      ...values,
      (input.page - 1) * 30,
    );
    return {
      total,
      items: rows.map(resourceOption),
    };
  }
  private async read<T>(action: () => Promise<T>): Promise<T> {
    this.readers++;
    try {
      return await action();
    } finally {
      this.readers--;
    }
  }
  private async exclusive<T>(
    catalogId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.active.has(catalogId))
      throw new AppError(
        "CATALOG_BUSY",
        "此清单正在处理，请等待当前操作完成。",
      );
    this.active.add(catalogId);
    try {
      return await action();
    } finally {
      this.active.delete(catalogId);
    }
  }
  private load(catalogId: string): StoredCatalog {
    const stored = this.repo.db.setting<StoredCatalog | null>(
      catalogKey(catalogId),
      null,
    );
    if (!stored)
      throw new AppError("CATALOG_NOT_FOUND", "清单已不存在，请刷新清单列表。");
    return stored;
  }
  private assertRevision(stored: StoredCatalog, revision?: number) {
    if (revision !== stored.catalog.revision)
      throw new AppError(
        "CATALOG_CONFLICT",
        "清单已被修改，请重新读取后再保存，避免覆盖已有内容。",
      );
  }
  private assertMutable(stored: StoredCatalog) {
    if (stored.catalog.archived)
      throw new AppError(
        "CATALOG_ARCHIVED",
        "此清单已归档，请恢复维护后再操作。",
      );
  }
  private persist(stored: StoredCatalog) {
    this.repo.db.setSetting(catalogKey(stored.catalog.id), stored);
    this.changed();
  }
  private sourceFingerprint(catalog: ResourceCatalog) {
    const where = catalog.category === "all" ? "" : "WHERE r.category=?";
    const values = catalog.category === "all" ? [] : [catalog.category];
    // Secret ciphertext participates only in this in-memory revision stamp. It is never exported.
    return digest([
      this.repo.db.all(
        `SELECT r.id,r.title,r.source_url,r.source_kind,r.provider,r.category,r.tags,r.summary,r.updated_at,
        c.id copy_id,c.status copy_status,c.owner_uid,c.verified_at,c.files,
        c.share_url,c.share_id,c.share_owner_uid,c.share_version,c.share_verified_at,
        a.uid account_uid,a.enabled,a.provider account_provider,sc.status check_status,sc.checked_at,
        secret.value code_revision
        FROM resources r LEFT JOIN copies c ON c.resource_id=r.id LEFT JOIN accounts a ON a.id=c.account_id
        LEFT JOIN share_checks sc ON sc.copy_id=c.id LEFT JOIN secrets secret ON secret.key='share:'||c.id
        ${where} ORDER BY r.id,c.id`,
        ...values,
      ),
      this.repo.db.all(
        `SELECT s.id,s.status,s.verified_at,s.share_id,s.share_url,s.owner_uid,s.file,s.path,
        c.status copy_status,c.owner_uid,c.verified_at,a.uid account_uid,a.enabled,a.provider,
        secret.value code_revision FROM split_items s JOIN copies c ON c.id=s.copy_id
        JOIN resources r ON r.id=c.resource_id JOIN accounts a ON a.id=c.account_id
        LEFT JOIN secrets secret ON secret.key='split:'||s.id ${where} ORDER BY s.id`,
        ...values,
      ),
    ]);
  }
  private async snapshot(
    catalog: ResourceCatalog,
    attempt = 0,
  ): Promise<CatalogSnapshot> {
    const selection =
      catalog.selectionMode === "manual"
        ? new Map(
            (catalog.entries ?? []).map((entry) => [entry.resourceId, entry]),
          )
        : null;
    const scope = selection ? { ...catalog, category: "all" } : catalog;
    const removed = new Set(
      selection ? [] : (catalog.excludedResourceIds ?? []),
    );
    const sourceRevision = this.sourceFingerprint(scope);
    const definitionKey = digest({
      title: catalog.title,
      category: catalog.category,
      introduction: catalog.introduction,
      includeSummary: catalog.includeSummary,
      includeTags: catalog.includeTags,
      sort: catalog.sort,
      selectionMode: catalog.selectionMode,
      entries: catalog.entries,
      excludedResourceIds: catalog.excludedResourceIds,
    });
    const cached = this.previewCache.get(definitionKey);
    if (cached?.sourceRevision === sourceRevision) return cached.snapshot;
    const items: CatalogItem[] = [],
      excluded: CatalogSnapshot["excluded"] = [];
    // Never use the renderer snapshot or resources(), both limited to 500 records.
    const resourceRows = this.repo.db.all<{
      id: string;
      title: string;
      source_url: string;
      source_kind: string;
      provider: Provider;
      category: string;
      tags: string;
      summary: string;
    }>(
      `SELECT id,title,source_url,source_kind,provider,category,tags,summary FROM resources ${scope.category === "all" ? "" : "WHERE category=?"} ORDER BY ${catalog.sort === "title" ? "title COLLATE NOCASE,id" : "updated_at DESC,id"}`,
      ...(scope.category === "all" ? [] : [scope.category]),
    );
    const accountMap = new Map(
      this.repo.accounts().map((account) => [account.id, account]),
    );
    const categoryFilter = scope.category === "all" ? "" : "WHERE r.category=?";
    const categoryValues = scope.category === "all" ? [] : [scope.category];
    const copiesByResource = new Map<string, ResourceCopy[]>();
    for (const row of this.repo.db.all<Row>(
      `SELECT c.* FROM copies c JOIN resources r ON r.id=c.resource_id ${categoryFilter} ORDER BY c.resource_id,c.created_at,c.id`,
      ...categoryValues,
    )) {
      const copy = this.repo.copy(row);
      const copies = copiesByResource.get(copy.resourceId) ?? [];
      copies.push(copy);
      copiesByResource.set(copy.resourceId, copies);
    }
    const checks = new Map(
      this.repo.db
        .all<{ copy_id: string; status: string; checked_at: string }>(
          `SELECT sc.* FROM share_checks sc JOIN copies c ON c.id=sc.copy_id JOIN resources r ON r.id=c.resource_id ${categoryFilter}`,
          ...categoryValues,
        )
        .map((check) => [check.copy_id, check]),
    );
    const splitByResource = new Map<
      string,
      { id: string; share_url: string; file: string }[]
    >();
    for (const split of this.repo.db.all<{
      id: string;
      resource_id: string;
      share_url: string;
      file: string;
    }>(
      `SELECT s.id,c.resource_id,s.share_url,s.file FROM split_items s JOIN copies c ON c.id=s.copy_id
       JOIN resources r ON r.id=c.resource_id JOIN accounts a ON a.id=c.account_id
       WHERE s.status='ready' AND s.verified_at IS NOT NULL AND s.share_url IS NOT NULL AND s.share_id IS NOT NULL
       AND c.status='ready' AND c.verified_at IS NOT NULL AND a.enabled=1 AND a.uid IS NOT NULL
       AND c.owner_uid=a.uid AND s.owner_uid=a.uid AND a.provider=r.provider
       ${scope.category === "all" ? "" : "AND r.category=?"} ORDER BY c.resource_id,s.path,s.id`,
      ...categoryValues,
    )) {
      const shares = splitByResource.get(split.resource_id) ?? [];
      shares.push(split);
      splitByResource.set(split.resource_id, shares);
    }
    for (const resource of resourceRows) {
      if (selection && !selection.has(resource.id)) continue;
      if (removed.has(resource.id)) continue;
      const entry = selection?.get(resource.id);
      const links: CatalogItem["links"] = [];
      for (const copy of copiesByResource.get(resource.id) ?? []) {
        const account = accountMap.get(copy.accountId);
        const check = checks.get(copy.id);
        if (
          !hasVerifiedShare(copy, account) ||
          account?.provider !== resource.provider ||
          (check &&
            check.status !== "valid" &&
            Date.parse(check.checked_at) >= Date.parse(copy.shareVerifiedAt!))
        )
          continue;
        let share: ReturnType<typeof parseShare>;
        try {
          share = parseShare(copy.shareUrl!);
        } catch {
          continue;
        }
        if (share.provider !== resource.provider) continue;
        if (resource.source_kind !== "owned") {
          try {
            if (share.url === parseShare(resource.source_url).url) continue;
          } catch {
            continue;
          }
        }
        // A decryption failure must surface as a recoverable read error, never an empty code.
        const code = (await this.readSecret(`share:${copy.id}`)) ?? share.code;
        if (!links.some((link) => link.url === share.url))
          links.push({
            provider: providerSpecs[share.provider].name,
            url: share.url,
            code,
          });
      }
      for (const split of splitByResource.get(resource.id) ?? []) {
        let share: ReturnType<typeof parseShare>;
        try {
          share = parseShare(split.share_url);
        } catch {
          continue;
        }
        if (share.provider !== resource.provider) continue;
        if (resource.source_kind !== "owned") {
          try {
            if (share.url === parseShare(resource.source_url).url) continue;
          } catch {
            continue;
          }
        }
        const code = (await this.readSecret(`split:${split.id}`)) ?? share.code;
        let name = "";
        try {
          name = publicText(String(JSON.parse(split.file).name ?? ""));
        } catch {
          /* The share remains usable without its label. */
        }
        if (!links.some((link) => link.url === share.url))
          links.push({
            provider: `${providerSpecs[share.provider].name}${name ? ` · ${name}` : ""}`,
            url: share.url,
            code,
          });
      }
      if (!links.length) {
        excluded.push({
          resourceId: resource.id,
          title: publicText(resource.title),
          reason: "暂无已核实且未标记失效的本人分享",
        });
        continue;
      }
      items.push({
        resourceId: resource.id,
        title: publicText(entry?.title ?? resource.title),
        category: publicText(entry?.category ?? resource.category),
        summary: catalog.includeSummary
          ? publicText(entry?.summary ?? resource.summary)
          : "",
        tags: catalog.includeTags
          ? resourceTags(
              entry?.tags ?? parseJson<string[]>(resource.tags, []),
            ).map(publicText)
          : [],
        links,
      });
    }
    if (selection) {
      const known = new Set(resourceRows.map((row) => row.id));
      for (const entry of selection.values())
        if (!known.has(entry.resourceId))
          excluded.push({
            resourceId: entry.resourceId,
            title: publicText(entry.title ?? "已删除的资源"),
            reason: "此资源已不在资源库中，请从清单移除或重新添加",
          });
      if (catalog.sort === "manual") {
        const order = new Map(
          [...selection.keys()].map((resourceId, index) => [resourceId, index]),
        );
        items.sort(
          (a, b) => order.get(a.resourceId)! - order.get(b.resourceId)!,
        );
      }
    }
    const content = {
      title: publicText(catalog.title),
      category: publicText(catalog.category),
      introduction: publicText(catalog.introduction),
      items,
    };
    if (sourceRevision !== this.sourceFingerprint(scope)) {
      if (attempt < 1) return this.snapshot(catalog, attempt + 1);
      throw new AppError(
        "CATALOG_RESOURCES_CHANGED",
        "资源资料或分享正在变化，请稍后重新读取清单。",
      );
    }
    const hash = digest(content);
    const snapshot = {
      id: `snapshot_${hash}`,
      hash,
      ...content,
      createdAt: now(),
      excluded,
    };
    this.previewCache.delete(definitionKey);
    this.previewCache.set(definitionKey, { sourceRevision, snapshot });
    let cachedItems = 0;
    for (const entry of this.previewCache.values())
      cachedItems +=
        entry.snapshot.items.length + entry.snapshot.excluded.length;
    while (
      this.previewCache.size > 6 ||
      (cachedItems > 50_000 && this.previewCache.size > 1)
    ) {
      const oldest = this.previewCache.keys().next().value!;
      const removed = this.previewCache.get(oldest)!;
      cachedItems -=
        removed.snapshot.items.length + removed.snapshot.excluded.length;
      this.previewCache.delete(oldest);
    }
    return snapshot;
  }
  private storedSnapshot(catalogId: string, snapshotId: string) {
    const snapshot = this.repo.db.setting<CatalogSnapshot | null>(
      snapshotKey(catalogId, snapshotId),
      null,
    );
    if (!snapshot)
      throw new AppError(
        "CATALOG_SNAPSHOT_MISSING",
        "交接快照不存在，请重新准备发布内容。",
      );
    return snapshot;
  }
  private preparation(stored: StoredCatalog, preparationId: string) {
    const preparation = stored.preparations.find(
      (item) => item.id === preparationId,
    );
    if (!preparation)
      throw new AppError(
        "CATALOG_PREPARATION_MISSING",
        "此发布交接已不存在，请重新准备。",
      );
    return preparation;
  }
  private async detail(
    stored: StoredCatalog,
    preparedCurrent?: CatalogSnapshot,
  ): Promise<CatalogDetail> {
    const current = preparedCurrent ?? (await this.snapshot(stored.catalog));
    return {
      catalog: stored.catalog,
      current,
      preparations: [...stored.preparations].reverse(),
      history: [...stored.history].reverse(),
      site: this.siteState(stored.catalog.id, current),
      publications: stored.publications.map((publication) => ({
        ...publication,
        needsUpdate: publication.hash !== current.hash,
        diff: catalogDiff(
          this.storedSnapshot(stored.catalog.id, publication.snapshotId),
          current,
        ),
      })),
    };
  }
  private siteState(catalogId: string, current: CatalogSnapshot) {
    const state = this.site?.state(catalogId, current) ?? {
      baseUrl: "",
      publication: null,
      needsUpdate: false,
      pending: null,
      error: null,
      checkedAt: null,
    };
    const previous = state.publication?.snapshot;
    const diff = previous
      ? catalogDiff(
          {
            ...previous,
            excluded: [],
            items: previous.items.map(
              ({ landingSlug: _slug, ...item }) => item,
            ),
          },
          current,
        )
      : null;
    if (
      diff &&
      state.needsUpdate &&
      !diff.added.length &&
      !diff.changed.length &&
      !diff.removed.length &&
      !diff.metadataChanged
    )
      diff.metadataChanged = true;
    return { ...state, diff };
  }
  sitePublish(input: {
    id: string;
    expectedRevision: number;
    expectedHash: string;
  }) {
    return this.exclusive(input.id, async () => {
      const stored = this.load(input.id);
      this.assertMutable(stored);
      this.assertRevision(stored, input.expectedRevision);
      const snapshot = await this.snapshot(stored.catalog);
      if (snapshot.hash !== input.expectedHash)
        throw new AppError(
          "CATALOG_RESOURCES_CHANGED",
          "资源或分享已变化，请刷新清单、核对内容后再发布。",
        );
      if (!this.site)
        throw new AppError(
          "CATALOG_SITE_CONFIG",
          "当前环境未接入清单站点发布。",
        );
      await this.site.publish(stored.catalog, snapshot);
      return this.siteState(input.id, snapshot);
    });
  }
  siteWithdraw(id: string, expectedVersion: number) {
    return this.exclusive(id, async () => {
      this.load(id);
      if (!this.site)
        throw new AppError(
          "CATALOG_SITE_CONFIG",
          "当前环境未接入清单站点发布。",
        );
      await this.site.withdraw(id, expectedVersion);
      // Withdrawal must remain possible even if current local shares cannot be read.
      return { ...this.site.state(id), diff: null };
    });
  }
  siteRead(id: string, retry = false) {
    return this.exclusive(id, async () => {
      const stored = this.load(id);
      if (!this.site)
        throw new AppError(
          "CATALOG_SITE_CONFIG",
          "当前环境未接入清单站点发布。",
        );
      if (retry) await this.site.retry(id);
      else await this.site.refresh(id);
      try {
        return this.siteState(id, await this.snapshot(stored.catalog));
      } catch {
        const state = this.site.state(id);
        return {
          ...state,
          diff: null,
          error:
            state.error ||
            "已读取站点状态，但当前资源预览读取失败，暂时无法核对内容差异。请刷新资源后重试读取。",
        };
      }
    });
  }
  async list(): Promise<CatalogSummary[]> {
    return this.read(async () => {
      const catalogIds = this.repo.db.setting<string[]>(indexKey, []);
      const result: CatalogSummary[] = [];
      for (const catalogId of catalogIds) {
        const stored = this.load(catalogId);
        const current = await this.snapshot(stored.catalog);
        const site = this.siteState(catalogId, current);
        result.push({
          ...stored.catalog,
          resourceCount: current.items.length,
          excludedCount: current.excluded.length,
          publicationCount:
            stored.publications.length + Number(!!site.publication?.active),
          pendingCount:
            stored.publications.filter((item) => item.hash !== current.hash)
              .length +
            Number(
              !!site.pending ||
                (!!site.publication?.active && site.needsUpdate),
            ),
        });
      }
      return result.sort(
        (a, b) =>
          Number(a.archived) - Number(b.archived) ||
          b.updatedAt.localeCompare(a.updatedAt),
      );
    });
  }
  get(catalogId: string) {
    return this.read(() => this.detail(this.load(catalogId)));
  }
  async save(raw: unknown) {
    const input = catalogSaveSchema.parse(raw);
    const catalogId = input.id ?? id("catalog");
    return this.exclusive(catalogId, async () => {
      const existing = input.id ? this.load(catalogId) : null;
      if (existing) {
        this.assertRevision(existing, input.expectedRevision);
        this.assertMutable(existing);
      }
      const time = now();
      const { id: _id, expectedRevision: _revision, ...definition } = input;
      definition.selectionMode ??=
        existing?.catalog.selectionMode ?? "category";
      definition.entries ??= existing?.catalog.entries ?? [];
      definition.excludedResourceIds = [
        ...new Set(
          definition.excludedResourceIds ??
            existing?.catalog.excludedResourceIds ??
            [],
        ),
      ];
      if (
        new Set(definition.entries.map((entry) => entry.resourceId)).size !==
        definition.entries.length
      )
        throw new AppError(
          "CATALOG_DUPLICATE_ENTRY",
          "清单中有重复资源，请移除重复项后保存。",
        );
      if (definition.selectionMode === "manual") {
        const previous = new Set(
          existing?.catalog.entries?.map((entry) => entry.resourceId),
        );
        for (const entry of definition.entries)
          if (
            !previous.has(entry.resourceId) &&
            !this.repo.db.get(
              "SELECT id FROM resources WHERE id=?",
              entry.resourceId,
            )
          )
            throw new AppError(
              "CATALOG_RESOURCE_MISSING",
              "部分所选资源已不存在，请重新检索并选择。",
            );
      }
      const stored: StoredCatalog = existing ?? {
        catalog: {} as ResourceCatalog,
        preparations: [],
        publications: [],
        history: [],
        nextVersion: 1,
      };
      stored.catalog = {
        ...definition,
        id: catalogId,
        revision: (existing?.catalog.revision ?? 0) + 1,
        archived: false,
        createdAt: existing?.catalog.createdAt ?? time,
        updatedAt: time,
      };
      const detail = await this.detail(stored);
      this.repo.db.transaction(() => {
        this.repo.db.setSetting(catalogKey(catalogId), stored);
        if (!existing)
          this.repo.db.setSetting(indexKey, [
            ...this.repo.db.setting<string[]>(indexKey, []),
            catalogId,
          ]);
      });
      this.changed();
      return detail;
    });
  }
  archive(catalogId: string, expectedRevision: number, archived: boolean) {
    return this.exclusive(catalogId, async () => {
      const stored = this.load(catalogId);
      this.assertRevision(stored, expectedRevision);
      stored.catalog = {
        ...stored.catalog,
        archived,
        revision: stored.catalog.revision + 1,
        updatedAt: now(),
      };
      const detail = await this.detail(stored);
      this.persist(stored);
      return detail;
    });
  }
  removeItems(raw: unknown) {
    const input = catalogRemoveItemsSchema.parse(raw);
    return this.exclusive(input.id, async () => {
      const stored = this.load(input.id);
      this.assertRevision(stored, input.expectedRevision);
      this.assertMutable(stored);
      const ids = new Set(input.resourceIds);
      const catalog = stored.catalog;
      const manual = catalog.selectionMode === "manual";
      const excluded = new Set(catalog.excludedResourceIds ?? []);
      const members = new Set(
        manual
          ? (catalog.entries ?? []).map((entry) => entry.resourceId)
          : this.repo.db
              .all<{ id: string }>(
                `SELECT id FROM resources ${catalog.category === "all" ? "" : "WHERE category=?"}`,
                ...(catalog.category === "all" ? [] : [catalog.category]),
              )
              .map((resource) => resource.id)
              .filter((id) => !excluded.has(id)),
      );
      if ([...ids].some((id) => !members.has(id)))
        throw new AppError(
          "CATALOG_ITEM_CHANGED",
          "部分条目已移出此清单或分类发生变化，请刷新资源后重试。",
        );
      if (!manual && excluded.size + ids.size > 100000)
        throw new AppError(
          "CATALOG_EXCLUSIONS_LIMIT",
          "此清单已排除过多资源，请改用手动选取维护条目。",
        );
      stored.catalog = {
        ...catalog,
        ...(manual
          ? {
              entries: (catalog.entries ?? []).filter(
                (entry) => !ids.has(entry.resourceId),
              ),
            }
          : { excludedResourceIds: [...new Set([...excluded, ...ids])] }),
        revision: catalog.revision + 1,
        updatedAt: now(),
      };
      // Build the new snapshot before committing, so a read failure cannot look like a failed deletion.
      const detail = await this.detail(stored);
      this.persist(stored);
      return detail;
    });
  }
  remove(catalogId: string, expectedRevision: number) {
    return this.exclusive(catalogId, async () => {
      const stored = this.load(catalogId);
      this.assertRevision(stored, expectedRevision);
      this.site?.assertRemovable(catalogId);
      this.repo.db.transaction(() => {
        this.site?.remove(catalogId);
        this.repo.db.run(
          "DELETE FROM settings WHERE key=? OR key GLOB ?",
          catalogKey(catalogId),
          `${catalogKey(catalogId)}:snapshot:*`,
        );
        this.repo.db.setSetting(
          indexKey,
          this.repo.db
            .setting<string[]>(indexKey, [])
            .filter((value) => value !== catalogId),
        );
      });
      this.changed();
      return true;
    });
  }
  prepare(raw: unknown) {
    const input = catalogPrepareSchema.parse(raw);
    return this.exclusive(input.id, async () => {
      const stored = this.load(input.id);
      this.assertMutable(stored);
      this.assertRevision(stored, input.expectedRevision);
      const account = this.accounts.get(input.accountId);
      if (account.provider !== input.provider)
        throw new AppError(
          "CATALOG_ACCOUNT_MISMATCH",
          "所选账号不属于此文档平台。",
        );
      const publication = input.publicationId
        ? stored.publications.find((item) => item.id === input.publicationId)
        : null;
      if (input.publicationId && !publication)
        throw new AppError(
          "CATALOG_PUBLICATION_MISSING",
          "发布记录已不存在，请刷新后重试。",
        );
      if (
        publication &&
        (publication.provider !== input.provider ||
          publication.accountId !== input.accountId)
      )
        throw new AppError(
          "CATALOG_ACCOUNT_MISMATCH",
          "更新必须使用原文档关联的平台账号。",
        );
      const snapshot = await this.snapshot(stored.catalog);
      if (!snapshot.items.length && !publication)
        throw new AppError(
          "CATALOG_EMPTY",
          "当前分类没有可公开的本人分享，请先在资源库完成分享核验。",
        );
      const preparation: CatalogPreparation = {
        id: id("handoff"),
        catalogId: input.id,
        provider: input.provider,
        accountId: account.id,
        accountAlias: account.alias,
        publicationId: publication?.id ?? null,
        snapshotId: snapshot.id,
        hash: snapshot.hash,
        version: stored.nextVersion++,
        createdAt: now(),
        confirmedAt: null,
      };
      stored.preparations.push(preparation);
      this.repo.db.transaction(() => {
        // The same public content has one immutable snapshot across handoffs.
        if (!this.repo.db.setting(snapshotKey(input.id, snapshot.id), null))
          this.repo.db.setSetting(snapshotKey(input.id, snapshot.id), snapshot);
        this.repo.db.setSetting(catalogKey(input.id), stored);
      });
      this.changed();
      return { preparation, snapshot };
    });
  }
  copy(catalogId: string, preparationId: string) {
    return this.exclusive(catalogId, async () => {
      const stored = this.load(catalogId);
      this.assertMutable(stored);
      const preparation = this.preparation(stored, preparationId);
      const document = catalogDocument(
        this.storedSnapshot(catalogId, preparation.snapshotId),
      );
      if (this.ports.copyRichText) {
        await this.ports.copyRichText(document.html, document.text);
        return { copied: true as const, format: "rich" as const };
      }
      await this.ports.copyText(document.text);
      return { copied: true as const, format: "text" as const };
    });
  }
  open(catalogId: string, preparationId: string) {
    return this.exclusive(catalogId, async () => {
      const stored = this.load(catalogId);
      this.assertMutable(stored);
      const preparation = this.preparation(stored, preparationId);
      const publication = stored.publications.find(
        (item) => item.id === preparation.publicationId,
      );
      if (preparation.publicationId && !publication)
        throw new AppError(
          "CATALOG_PUBLICATION_MISSING",
          "原发布记录不存在，请重新准备更新。",
        );
      const account = this.accounts.get(preparation.accountId);
      if (account.provider !== preparation.provider)
        throw new AppError(
          "CATALOG_ACCOUNT_MISMATCH",
          "交接账号的平台已经变化，请重新选择。",
        );
      return this.accounts.openDocument(
        account.id,
        publication?.url ?? documentPlatformSpecs[preparation.provider].home,
      );
    });
  }
  confirm(raw: unknown) {
    const input = catalogConfirmSchema.parse(raw);
    return this.exclusive(input.id, async () => {
      const stored = this.load(input.id);
      this.assertMutable(stored);
      const preparation = this.preparation(stored, input.preparationId);
      const url = documentPlatformUrl(preparation.provider, input.url);
      const path = url ? new URL(url).pathname : "";
      const allowedPath =
        preparation.provider === "feishu"
          ? /^\/(?:docx|docs|sheets|wiki|base)\/[\w-]+/
          : preparation.provider === "tencent-docs"
            ? /^\/(?:doc|sheet|slide|form|mind|pdf|document)\/[\w-]+/
            : /^\/(?:docs|sheets|doc|sheet|forms)\/[\w-]+/;
      if (!url || !allowedPath.test(path))
        throw new AppError(
          "CATALOG_DOCUMENT_URL",
          "请填写此平台的完整文档分享链接，不能使用登录页或工作台地址。",
        );
      const existingReceipt = stored.history.find(
        (item) => item.preparationId === preparation.id,
      );
      if (existingReceipt) {
        if (documentIdentity(existingReceipt.url) !== documentIdentity(url))
          throw new AppError(
            "CATALOG_ALREADY_CONFIRMED",
            "此交接版本已经登记，请重新准备后登记新的变更。",
          );
        return this.detail(stored);
      }
      const account = this.accounts.get(preparation.accountId);
      if (account.provider !== preparation.provider)
        throw new AppError(
          "CATALOG_ACCOUNT_MISMATCH",
          "交接账号已变化，请重新准备发布。",
        );
      const previous = preparation.publicationId
        ? stored.publications.find(
            (item) => item.id === preparation.publicationId,
          )
        : null;
      if (preparation.publicationId && !previous)
        throw new AppError(
          "CATALOG_PUBLICATION_MISSING",
          "原发布记录不存在，请重新准备。",
        );
      if (previous && previous.version >= preparation.version)
        throw new AppError(
          "CATALOG_OLD_PREPARATION",
          "原文档已登记更新版本，此旧交接不能覆盖最新记录。",
        );
      if (previous && documentIdentity(previous.url) !== documentIdentity(url))
        throw new AppError(
          "CATALOG_DOCUMENT_CHANGED",
          "更新交接应登记原文档链接；发布到另一文档请新建交接。",
        );
      if (
        !previous &&
        stored.publications.some(
          (item) => documentIdentity(item.url) === documentIdentity(url),
        )
      )
        throw new AppError(
          "CATALOG_DUPLICATE_DOCUMENT",
          "此文档已经有发布记录，请从原记录准备更新。",
        );
      this.storedSnapshot(input.id, preparation.snapshotId);
      const confirmedAt = now();
      const receipt: CatalogReceipt = {
        id: previous?.id ?? id("document"),
        provider: preparation.provider,
        accountId: preparation.accountId,
        accountAlias: preparation.accountAlias,
        url,
        snapshotId: preparation.snapshotId,
        hash: preparation.hash,
        version: preparation.version,
        confirmedAt,
        preparationId: preparation.id,
      };
      preparation.confirmedAt = confirmedAt;
      stored.publications = [
        ...stored.publications.filter((item) => item.id !== receipt.id),
        receipt,
      ];
      stored.history.push(receipt);
      stored.catalog.updatedAt = confirmedAt;
      const detail = await this.detail(stored);
      this.persist(stored);
      return detail;
    });
  }
  export(
    catalogId: string,
    preparationId: string | undefined,
    format: "xlsx" | "md",
  ) {
    return this.exclusive(catalogId, async () => {
      const stored = this.load(catalogId);
      const preparation = preparationId
        ? this.preparation(stored, preparationId)
        : null;
      const snapshot = preparation
        ? this.storedSnapshot(catalogId, preparation.snapshotId)
        : await this.snapshot(stored.catalog);
      if (!snapshot.items.length && !preparation?.publicationId)
        throw new AppError(
          "CATALOG_EMPTY",
          "清单尚无可公开资源，请先完成本人分享核验。",
        );
      const document = catalogDocument(snapshot);
      const name =
        snapshot.title.replace(/[\x00-\x1f<>:"/\\|?*]/g, "_").slice(0, 100) ||
        "资源清单";
      return this.ports.saveFile(
        `${name}.${format}`,
        format === "xlsx" ? xlsx(document.rows) : Buffer.from(document.md),
      );
    });
  }
}

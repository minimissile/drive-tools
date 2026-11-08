import { randomUUID } from "node:crypto";
import {
  catalogLandingMaxBodyBytes,
  catalogLandingSnapshotSchema,
  catalogLandingWriteSchema,
  remoteCatalogLandingSchema,
  type CatalogLandingSnapshot,
  type CatalogLandingWrite,
  type CatalogLandingWithdraw,
  type RemoteCatalogLanding,
} from "../shared/catalog-landing";
import type {
  CatalogSnapshot,
  CatalogSiteState,
  ResourceCatalog,
} from "../shared/resource-catalog";
import type { Repository } from "./repository";
import type { ResourceLinks } from "./resource-links";
import { AppError, safeMessage } from "./errors";
import { now } from "./database";

type Pending =
  | { method: "PUT"; input: CatalogLandingWrite }
  | { method: "DELETE"; input: CatalogLandingWithdraw };
interface SiteRecord {
  baseUrl: string;
  publication: RemoteCatalogLanding | null;
  pending: Pending | null;
  error: string | null;
  checkedAt: string | null;
}
const key = (id: string) => `resourceCatalog:site:v1:${id}`;

/** Explicit cloud publication, isolated from local preview and document handoffs. */
export class CatalogLandings {
  constructor(
    private repo: Repository,
    private links: ResourceLinks,
    private changed: () => void,
  ) {}
  private record(id: string): SiteRecord {
    return this.repo.db.setting(key(id), {
      baseUrl: "",
      publication: null,
      pending: null,
      error: null,
      checkedAt: null,
    });
  }
  private store(id: string, record: SiteRecord) {
    this.repo.db.setSetting(key(id), record);
    this.changed();
  }
  private project(
    snapshot: CatalogSnapshot,
    baseUrl: string,
  ): CatalogLandingSnapshot {
    return {
      id: snapshot.id,
      hash: snapshot.hash,
      title: snapshot.title,
      category: snapshot.category,
      introduction: snapshot.introduction,
      createdAt: snapshot.createdAt,
      items: snapshot.items.map((item) => ({
        resourceId: item.resourceId,
        title: item.title,
        category: item.category,
        summary: item.summary,
        tags: [...item.tags],
        links: item.links.map(({ provider, url, code }) => ({
          provider,
          url,
          code,
        })),
        landingSlug:
          this.links.catalogResourceSlug(item.resourceId, baseUrl) ?? null,
      })),
    };
  }
  state(
    id: string,
    snapshot?: CatalogSnapshot,
  ): Omit<CatalogSiteState, "diff"> {
    const record = this.record(id),
      remote = record.publication;
    const slugs = new Map(
      remote?.snapshot.items.map((item) => [
        item.resourceId,
        item.landingSlug ?? null,
      ]),
    );
    return {
      baseUrl: record.baseUrl,
      publication: remote,
      needsUpdate:
        !!remote &&
        (!snapshot ||
          remote.snapshot.hash !== snapshot.hash ||
          snapshot.items.some(
            (item) =>
              (this.links.catalogResourceSlug(
                item.resourceId,
                record.baseUrl,
              ) ?? null) !== slugs.get(item.resourceId),
          )),
      pending: record.pending
        ? record.pending.method === "PUT"
          ? "publish"
          : "withdraw"
        : null,
      error: record.error,
      checkedAt: record.checkedAt,
    };
  }
  assertRemovable(id: string) {
    const record = this.record(id);
    if (record.pending || record.publication?.active)
      throw new AppError(
        "CATALOG_SITE_ACTIVE",
        "此清单仍有站点发布或待核对请求。请先读取站点状态并撤下，再删除本地维护记录。",
      );
  }
  remove(id: string) {
    this.repo.db.run("DELETE FROM settings WHERE key=?", key(id));
  }
  private adopt(
    id: string,
    record: SiteRecord,
    value: unknown,
  ): RemoteCatalogLanding | null {
    if (value === null) return null;
    const parsed = remoteCatalogLandingSchema.safeParse(value);
    if (!parsed.success)
      throw new AppError(
        "CATALOG_SITE_RESPONSE",
        "站点返回的清单回执无效，请保留原操作并重新读取状态。",
      );
    const remote = parsed.data;
    // Management can use a Pages/Workers alias while the public URL uses the canonical domain.
    // This URL is only opened as a public page; all credential-bearing requests keep record.baseUrl.
    const publicUrl = new URL(remote.url);
    if (
      remote.id !== id ||
      publicUrl.protocol !== "https:" ||
      publicUrl.username ||
      publicUrl.password ||
      publicUrl.port ||
      remote.url !== `${publicUrl.origin}/c/${remote.slug}` ||
      (record.publication &&
        (remote.slug !== record.publication.slug ||
          remote.version < record.publication.version))
    )
      throw new AppError(
        "CATALOG_SITE_RESPONSE",
        "站点清单标识、地址或版本不匹配，未采用此回执。",
      );
    return remote;
  }
  private sameWrite(remote: RemoteCatalogLanding, pending: Pending) {
    return (
      remote.lastOperationId === pending.input.operationId &&
      remote.version === pending.input.expectedVersion + 1 &&
      (pending.method === "DELETE"
        ? !remote.active
        : remote.active &&
          remote.sourceRevision === pending.input.sourceRevision &&
          JSON.stringify(remote.snapshot) ===
            JSON.stringify(pending.input.snapshot))
    );
  }
  private async send(id: string, record: SiteRecord, firstAttempt: boolean) {
    const pending = record.pending!;
    let accepted = false;
    try {
      const value = await this.links.catalogCloud(
        record.baseUrl,
        id,
        pending.method,
        pending.input,
      );
      accepted = true;
      const receipt = this.adopt(id, record, value);
      if (!receipt || !this.sameWrite(receipt, pending))
        throw new AppError(
          "CATALOG_SITE_RESPONSE",
          "站点回执与原发布请求不一致，请读取站点状态核对。",
        );
      const latest = this.adopt(
        id,
        record,
        await this.links.catalogCloud(record.baseUrl, id, "GET"),
      );
      if (!latest || !this.sameWrite(latest, pending))
        throw new AppError(
          "CATALOG_SITE_CONFLICT",
          "站点已有其他版本，请读取站点状态后再维护。",
        );
      this.store(id, {
        ...record,
        publication: latest,
        pending: null,
        error: null,
        checkedAt: now(),
      });
    } catch (error) {
      const rejected =
        firstAttempt &&
        !accepted &&
        error instanceof AppError &&
        error.code === "RESOURCE_LINK_REJECTED";
      this.store(id, {
        ...record,
        pending: rejected ? null : pending,
        error: `${safeMessage(error)}${rejected ? " 本次请求已明确拒绝，请刷新站点状态后再操作。" : " 结果待核对，请读取站点状态或重试原操作。"}`,
      });
    }
  }
  async publish(catalog: ResourceCatalog, snapshot: CatalogSnapshot) {
    const record = this.record(catalog.id);
    if (record.pending)
      throw new AppError(
        "CATALOG_SITE_PENDING",
        "上次站点操作尚待核对，请先读取状态或重试原操作。",
      );
    const settings = await this.links.settings();
    if (!settings.configured)
      throw new AppError(
        "CATALOG_SITE_CONFIG",
        "请先在连接与设置中配置固定入口服务，清单发布复用同一服务和管理令牌。",
      );
    if (record.baseUrl && record.baseUrl !== settings.baseUrl)
      throw new AppError(
        "CATALOG_SITE_SERVICE_CHANGED",
        "此清单绑定原站点服务，请恢复原服务配置后维护，避免产生重复地址。",
      );
    if (!snapshot.items.length && !record.publication)
      throw new AppError(
        "CATALOG_EMPTY",
        "当前清单没有可公开的本人分享，请先在资源库完成分享核验。",
      );
    const raw = this.project(snapshot, settings.baseUrl);
    const checked = catalogLandingSnapshotSchema.safeParse(raw);
    if (!checked.success)
      throw new AppError(
        "CATALOG_SITE_LIMIT",
        "清单超出站点内容限制或包含无效字段（最多2000项资源、每项200个分享）。请拆分分类或检查过长内容后重试；不会截断发布。",
      );
    const input = catalogLandingWriteSchema.parse({
      operationId: randomUUID(),
      expectedVersion: record.publication?.version ?? 0,
      sourceRevision: catalog.revision,
      snapshot: checked.data,
    });
    if (
      Buffer.byteLength(JSON.stringify(input), "utf8") >
      catalogLandingMaxBodyBytes
    )
      throw new AppError(
        "CATALOG_SITE_LIMIT",
        "清单公开内容超过1 MiB，请拆分为多个分类清单后发布；不会截断内容。",
      );
    const queued: SiteRecord = {
      ...record,
      baseUrl: settings.baseUrl,
      pending: { method: "PUT", input },
      error: null,
    };
    this.store(catalog.id, queued);
    await this.send(catalog.id, queued, true);
  }
  async withdraw(id: string, expectedVersion: number) {
    const record = this.record(id);
    if (record.pending)
      throw new AppError(
        "CATALOG_SITE_PENDING",
        "上次站点操作尚待核对，请先读取状态或重试原操作。",
      );
    if (
      !record.publication?.active ||
      record.publication.version !== expectedVersion
    )
      throw new AppError(
        "CATALOG_SITE_CONFLICT",
        "站点发布版本已变化，请刷新状态后再撤下。",
      );
    const queued: SiteRecord = {
      ...record,
      pending: {
        method: "DELETE",
        input: { operationId: randomUUID(), expectedVersion },
      },
      error: null,
    };
    this.store(id, queued);
    await this.send(id, queued, true);
  }
  async retry(id: string) {
    const record = this.record(id);
    if (!record.pending)
      throw new AppError(
        "CATALOG_SITE_NO_PENDING",
        "没有待重试的站点请求，请刷新站点状态。",
      );
    await this.send(id, record, false);
  }
  async refresh(id: string) {
    let record = this.record(id);
    try {
      if (!record.baseUrl) {
        const settings = await this.links.settings();
        if (!settings.configured)
          throw new AppError(
            "CATALOG_SITE_CONFIG",
            "请先配置固定入口服务连接。",
          );
        record = { ...record, baseUrl: settings.baseUrl };
      }
      const remote = this.adopt(
        id,
        record,
        await this.links.catalogCloud(record.baseUrl, id, "GET"),
      );
      if (!remote && (record.pending || record.publication))
        throw new AppError(
          "CATALOG_SITE_MISSING",
          "站点尚未读到原清单，不能据此判断上次发布失败或已撤下。请保留记录，核对原服务后重试原操作。",
        );
      if (
        record.pending &&
        remote &&
        !this.sameWrite(remote, record.pending) &&
        remote.version <= record.pending.input.expectedVersion
      )
        throw new AppError(
          "CATALOG_SITE_PENDING",
          "站点仍是原请求之前的版本，请重试原操作；未清除待核对请求。",
        );
      if (
        record.pending &&
        remote?.lastOperationId === record.pending.input.operationId &&
        !this.sameWrite(remote, record.pending)
      )
        throw new AppError(
          "CATALOG_SITE_RESPONSE",
          "站点回执与原操作内容不符，待核对请求已保留。",
        );
      this.store(id, {
        ...record,
        publication: remote,
        pending: null,
        error: null,
        checkedAt: now(),
      });
    } catch (error) {
      this.store(id, { ...record, error: safeMessage(error) });
    }
  }
}

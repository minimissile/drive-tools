import {
  tiebaDiscoveryFilterAuditLimit as limit,
  tiebaDiscoveryPageSize as pageSize,
  type TiebaDiscoveryFilterSample,
  type TiebaFilterAuditSort,
  type TiebaTrafficSortDirection,
} from "../../shared/tieba-resource-discovery";
import type { Database } from "../database";

const storageKey = "tieba.resourceDiscovery.filterAudit";
type Store = Pick<Database, "setting" | "setSetting">;
type Audit = {
  batch: number;
  startedAt: number;
  samples: TiebaDiscoveryFilterSample[];
};
export type FilterRejection = Omit<TiebaDiscoveryFilterSample, "number" | "sampledAt">;

const sortValue = {
  sampledAt: (sample) => sample.sampledAt,
  publishedAt: (sample) => Date.parse(sample.post.publishedAt),
  views: (sample) => sample.post.views,
} satisfies Record<TiebaFilterAuditSort, (sample: TiebaDiscoveryFilterSample) => number | null>;

export class TiebaFilterAudit {
  constructor(private db: Store) {}

  private current() {
    return this.db.setting<Audit | null>(storageKey, null);
  }

  start(at: number) {
    const current = this.current();
    if (current && current.samples.length < limit) return false;
    this.db.setSetting(storageKey, {
      batch: (current?.batch ?? 0) + 1,
      startedAt: at,
      samples: [],
    } satisfies Audit);
    return true;
  }

  summary() {
    const audit = this.current();
    return audit && { batch: audit.batch, startedAt: audit.startedAt, count: audit.samples.length };
  }

  page(requestedPage: number, sort: TiebaFilterAuditSort = "sampledAt", direction: TiebaTrafficSortDirection = "asc") {
    const audit = this.current();
    const value = sortValue[sort];
    const multiplier = direction === "asc" ? 1 : -1;
    const ordered = (audit?.samples ?? []).toSorted((a, b) => {
      const left = value(a);
      const right = value(b);
      if (left === null || !Number.isFinite(left)) return right === null || !Number.isFinite(right) ? 0 : 1;
      if (right === null || !Number.isFinite(right)) return -1;
      return (left - right) * multiplier;
    });
    const total = ordered.length;
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
    return {
      batch: audit?.batch ?? null,
      page,
      total,
      items: ordered.slice((page - 1) * pageSize, page * pageSize),
    };
  }

  record(rejections: FilterRejection[], at: number) {
    if (!rejections.length) return;
    const audit = this.current();
    if (!audit || audit.samples.length >= limit) return;
    const before = audit.samples.length;
    const seen = new Set(audit.samples.map(({ post }) => post.id));
    for (const { post, reason } of rejections) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      const { id, title, url, forum, publishedAt, views } = post;
      const sequence = String(audit.samples.length + 1).padStart(3, "0");
      audit.samples.push({
        number: `SC-${audit.batch}-${sequence}`,
        sampledAt: at,
        post: { id, title, url, forum, publishedAt, views },
        reason,
      });
      if (audit.samples.length === limit) break;
    }
    if (audit.samples.length !== before) this.db.setSetting(storageKey, audit);
  }
}

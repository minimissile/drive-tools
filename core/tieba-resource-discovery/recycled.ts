import type { Database } from "../database";
import {
  tiebaDiscoveryPageSize as pageSize,
  tiebaDiscoveryRecycleLimit as limit,
  type TiebaDiscoveryRecycledPost,
  type TiebaRecycledFilters,
} from "../../shared/tieba-resource-discovery";

const key = "tieba.resourceDiscovery.recycled";
type Store = Pick<Database, "setting" | "setSetting">;
export type RecycledPost = Omit<TiebaDiscoveryRecycledPost, "recycledAt">;

export function recycledPosts(db: Store) {
  return db.setting<TiebaDiscoveryRecycledPost[]>(key, []);
}

export function recycledPage(db: Store, requestedPage: number, { source = "all", reason = "all", minViews, sort }: TiebaRecycledFilters = {}) {
  const posts = recycledPosts(db).filter((item) =>
    (source === "all" || item.source === source) && (reason === "all" || item.reason === reason) &&
    (minViews === undefined || (item.post.views !== null && item.post.views >= minViews)));
  if (sort === "views") posts.sort((a, b) => (b.post.views ?? -1) - (a.post.views ?? -1));
  const total = posts.length;
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
  return { total, page, items: posts.slice((page - 1) * pageSize, page * pageSize) };
}

export function updateRecycledPost(db: Store, id: string, views: number, checkedAt: number, reason: RecycledPost["reason"]) {
  const previous = recycledPosts(db);
  const index = previous.findIndex(({ post }) => post.id === id);
  if (index < 0) return;
  const item = previous[index];
  if ((item.post.checkedAt ?? 0) > checkedAt) return;
  previous[index] = { ...item, reason, post: { ...item.post, views, checkedAt } };
  db.setSetting(key, previous);
}

export function recordRecycledPosts(db: Store, rejected: RecycledPost[], at: number, admitted: Iterable<string> = []) {
  const previous = recycledPosts(db);
  const excluded = new Set(admitted);
  const latest = new Map<string, TiebaDiscoveryRecycledPost>();
  for (const { post: { id, title, url, forum, publishedAt, views, checkedAt }, source, reason } of rejected) {
    if (!excluded.has(id))
      latest.set(id, { post: { id, title, url, forum, publishedAt, views, checkedAt }, source, reason, recycledAt: at });
  }
  const survivors = previous.filter(({ post }) => !excluded.has(post.id) && !latest.has(post.id));
  if (latest.size || survivors.length !== previous.length) {
    const ordered = [...latest.values()].reverse().concat(survivors);
    ordered.sort((a, b) => b.recycledAt - a.recycledAt);
    db.setSetting(key, ordered.slice(0, limit));
  }
}

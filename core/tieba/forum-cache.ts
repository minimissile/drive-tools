import type { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";
import {
  tiebaForumCachePageSize,
  type TiebaAnalysisForumPage,
  type TiebaForumCachePage,
  type TiebaForumCacheSort,
} from "../../shared/tieba-analysis";
import type { Database } from "../database";
import { AppError, safeMessage } from "../errors";
import { queryTiebaAnalysisForumPosts } from "./analysis";

export function migrateTiebaForumCache(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE tieba_forum_cache (
      name_key TEXT PRIMARY KEY,
      forum_id TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      next_page INTEGER NOT NULL DEFAULT 1,
      list TEXT NOT NULL DEFAULT 'published',
      scanned_pages INTEGER NOT NULL DEFAULT 0,
      last_page_ids TEXT,
      complete INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tieba_forum_cache_posts (
      name_key TEXT NOT NULL REFERENCES tieba_forum_cache(name_key) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      published_at INTEGER,
      replied_at INTEGER,
      views INTEGER,
      thread TEXT NOT NULL,
      PRIMARY KEY (name_key, thread_id)
    );
    CREATE INDEX tieba_forum_cache_published ON tieba_forum_cache_posts (name_key, published_at DESC, thread_id DESC);
    CREATE INDEX tieba_forum_cache_replied ON tieba_forum_cache_posts (name_key, replied_at DESC, thread_id DESC);
    CREATE INDEX tieba_forum_cache_views ON tieba_forum_cache_posts (name_key, views DESC, thread_id DESC);
  `);
}

type Cursor = {
  forum_id: string;
  name: string;
  url: string;
  next_page: number;
  list: "published" | "replied";
  scanned_pages: number;
  last_page_ids: string | null;
  complete: number;
};

const nameKey = (name: string) => name.toLowerCase();
const time = (iso: string | null | undefined) => {
  const ms = Date.parse(iso ?? "");
  return Number.isFinite(ms) ? ms : null;
};
const orderBy: Record<TiebaForumCacheSort, string> = {
  published: "published_at DESC",
  replied: "replied_at DESC",
  views: "views DESC",
  exposure:
    "CASE WHEN published_at <= ? THEN views * 3600000.0 / max(? - published_at, 1800000) END DESC",
};

type CachedThread = TiebaAnalysisForumPage["threads"][number];

export class TiebaForumCache {
  private active?: { key: string; controller: AbortController };
  private errors = new Map<string, string>();
  private disposed = false;

  constructor(
    private db: Pick<Database, "db" | "get" | "all" | "run" | "transaction">,
    private changed: () => void,
    private read = queryTiebaAnalysisForumPosts,
    private pauseBetweenPages = (signal: AbortSignal) =>
      wait(3000 + Math.floor(Math.random() * 3001), undefined, {
        signal,
        ref: false,
      }),
    private now = Date.now,
  ) {}

  page(
    name: string,
    requestedPage: number,
    sort: TiebaForumCacheSort,
  ): TiebaForumCachePage {
    const key = nameKey(name);
    const cursor = this.cursor(key);
    const total = cursor
      ? this.db.get<{ total: number }>(
          "SELECT count(*) AS total FROM tieba_forum_cache_posts WHERE name_key = ?",
          key,
        )!.total
      : 0;
    const page = Math.min(
      requestedPage,
      Math.max(1, Math.ceil(total / tiebaForumCachePageSize)),
    );
    const observedAt = this.now();
    const error = this.errors.get(key);
    const status =
      this.active?.key === key && !this.active.controller.signal.aborted
        ? "reading"
        : error
          ? "error"
          : cursor?.complete
            ? "complete"
            : cursor
              ? "paused"
              : "idle";
    return {
      forum: cursor
        ? { id: cursor.forum_id, name: cursor.name, url: cursor.url }
        : null,
      status,
      error,
      page,
      total,
      observedAt,
      scannedPages: cursor?.scanned_pages ?? 0,
      threads: total
        ? this.db
            .all<{ thread: string }>(
              `SELECT thread FROM tieba_forum_cache_posts WHERE name_key = ?
           ORDER BY ${orderBy[sort]}, thread_id DESC LIMIT ? OFFSET ?`,
              key,
              ...(sort === "exposure" ? [observedAt, observedAt] : []),
              tiebaForumCachePageSize,
              (page - 1) * tiebaForumCachePageSize,
            )
            .map(({ thread }): CachedThread => ({
              author: "",
              publishedAt: null,
              views: null,
              replies: null,
              likes: null,
              shares: null,
              ...(JSON.parse(thread) as Partial<CachedThread> &
                Pick<CachedThread, "id" | "title" | "forum" | "url">),
            }))
        : [],
    };
  }

  control(name: string, action: "start" | "pause" | "restart") {
    const key = nameKey(name);
    if (action === "pause") {
      if (this.active?.key === key) {
        this.active.controller.abort();
        this.changed();
      }
      return;
    }
    if (this.disposed)
      throw new AppError("TIEBA_FORUM_CACHE_CLOSED", "工作空间正在关闭。");
    if (this.active && !this.active.controller.signal.aborted) {
      if (this.active.key === key) return;
      this.active.controller.abort();
    }
    if (action === "restart")
      this.db.run(
        `UPDATE tieba_forum_cache SET list = 'published', next_page = 1,
       scanned_pages = 0, last_page_ids = NULL, complete = 0 WHERE name_key = ?`,
        key,
      );
    if (this.cursor(key)?.complete) return;
    this.errors.delete(key);
    const controller = new AbortController();
    const job = { key, controller };
    this.active = job;
    this.changed();
    void this.scan(key, name, controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          this.errors.set(key, safeMessage(error));
      })
      .finally(() => {
        if (this.active === job) {
          this.active = undefined;
          if (!this.disposed) this.changed();
        }
      });
  }

  dispose() {
    this.disposed = true;
    this.active?.controller.abort();
  }

  private cursor(key: string) {
    return this.db.get<Cursor>(
      "SELECT * FROM tieba_forum_cache WHERE name_key = ?",
      key,
    );
  }

  private async scan(key: string, name: string, signal: AbortSignal) {
    const send: typeof fetch = (url, options) =>
      fetch(url, {
        ...options,
        signal: options?.signal
          ? AbortSignal.any([signal, options.signal])
          : signal,
      });
    while (true) {
      signal.throwIfAborted();
      const cursor = this.cursor(key);
      const list = cursor?.list ?? "published";
      const page = cursor?.next_page ?? 1;
      const result = await this.read(
        { name, page, list, pageSize: 50, allowEmptyPage: true },
        send,
      );
      signal.throwIfAborted();
      const ids = result.threads
        .map(({ id }) => id)
        .sort()
        .join(",");
      if (result.page !== page || (cursor && result.id !== cursor.forum_id))
        throw new AppError(
          "TIEBA_FORUM_CACHE_IDENTITY",
          "贴吧返回的吧或页码不一致，已暂停读取。",
        );
      if (ids && ids === cursor?.last_page_ids)
        throw new AppError(
          "TIEBA_FORUM_CACHE_REPEAT",
          "贴吧返回了重复页，已保存进度。",
        );
      const complete = !result.hasMore && list === "replied";
      this.db.transaction(() => {
        this.db.run(
          `INSERT INTO tieba_forum_cache (name_key, forum_id, name, url)
           VALUES (?, ?, ?, ?) ON CONFLICT(name_key) DO UPDATE SET name = excluded.name, url = excluded.url`,
          key,
          result.id,
          result.name,
          result.url,
        );
        const save = this.db.db.prepare(`
          INSERT INTO tieba_forum_cache_posts (name_key, thread_id, published_at, replied_at, views, thread)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(name_key, thread_id) DO UPDATE SET
            published_at = coalesce(excluded.published_at, published_at),
            replied_at = coalesce(excluded.replied_at, replied_at),
            views = coalesce(excluded.views, views),
            thread = json_patch(thread, excluded.thread)
        `);
        for (const post of result.threads) {
          const fields = Object.fromEntries(
            Object.entries(post).filter(
              ([, value]) => value !== null && value !== "",
            ),
          );
          // json_patch retains values omitted by a later list response.
          save.run(
            key,
            post.id,
            time(post.publishedAt),
            time(post.repliedAt),
            post.views,
            JSON.stringify(fields),
          );
        }
        this.db.run(
          `UPDATE tieba_forum_cache SET next_page = ?, list = ?, last_page_ids = ?,
           scanned_pages = scanned_pages + 1, complete = ? WHERE name_key = ?`,
          result.hasMore ? page + 1 : 1,
          result.hasMore ? list : "replied",
          result.hasMore && ids ? ids : null,
          Number(complete),
          key,
        );
      });
      if (complete) return;
      await this.pauseBetweenPages(signal);
    }
  }
}

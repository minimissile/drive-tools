import type { DatabaseSync } from "node:sqlite";
import type { TiebaAnalysisThread } from "../../shared/tieba-analysis";
import {
  defaultTiebaDiscoveryRules,
  oldTrafficMinimumAgeDays,
  oldTrafficObservationDays,
  tiebaDiscoveryPageSize as pageSize,
  type TiebaDiscoveryRules,
  type TiebaOldTrafficPost,
  type TiebaOldTrafficView,
  type TiebaOldResourceEvidence,
  type TiebaOldResourceFilter,
  type TiebaTrafficPost,
  type TiebaTrafficPostsView,
  type TiebaDiscoveryTrafficPost,
} from "../../shared/tieba-resource-discovery";
import type { Database } from "../database";
import { tiebaDiscoveryStateKey } from "./migration";
import { discoveryInterval as hour, type ViewReading } from "./rules";
import { admitOldResource, saveOldResource } from "./old-resource";
import { trafficPage, visibleHighTraffic } from "./archive";

const day = 24 * hour;
const observationGap = oldTrafficObservationDays * day;
const retryGap = 6 * hour;

export type OldTrafficCandidate = Pick<
  TiebaAnalysisThread,
  "id" | "title" | "url" | "forum" | "authorId"
> & { publishedAt: string; author?: string };

export type OldTrafficReading = {
  post: OldTrafficCandidate;
  at: number;
  views: number | null;
  resource?: TiebaOldResourceEvidence;
};

type Row = {
  post: string;
  last_at: number | null;
  last_views: number | null;
  baseline_at: number | null;
  added_views: number | null;
  daily_added: number | null;
  previous_daily: number | null;
  evidence?: string | null;
  checked_at?: number | null;
};

type Store = Pick<Database, "all" | "db" | "get">;

export const oldTrafficAge = (publishedAt: string, at: number) =>
  (at - Date.parse(publishedAt)) / day;

export function passesOldTrafficScreen(
  reading: OldTrafficReading,
  rules: Pick<
    TiebaDiscoveryRules,
    "oldTrafficMinTotalViews" | "oldTrafficMinLifetimeDailyViews"
  >,
): reading is OldTrafficReading & { views: number } {
  const { post, at, views } = reading;
  const age = oldTrafficAge(post.publishedAt, at);
  return (
    age >= oldTrafficMinimumAgeDays &&
    views !== null &&
    views >= rules.oldTrafficMinTotalViews &&
    views / age >= rules.oldTrafficMinLifetimeDailyViews
  );
}

export function migrateTiebaOldTraffic(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tieba_discovery_old_traffic (
      thread_id TEXT PRIMARY KEY,
      post TEXT NOT NULL,
      last_at INTEGER,
      last_views INTEGER,
      next_check_at INTEGER NOT NULL,
      baseline_at INTEGER,
      added_views INTEGER,
      daily_added REAL,
      previous_daily REAL
    );
    CREATE INDEX IF NOT EXISTS tieba_discovery_old_traffic_due
      ON tieba_discovery_old_traffic(next_check_at, thread_id);
    CREATE INDEX IF NOT EXISTS tieba_discovery_old_traffic_rate
      ON tieba_discovery_old_traffic(daily_added DESC, last_at DESC, thread_id);
  `);
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ? AND json_valid(value)")
    .get(tiebaDiscoveryStateKey);
  if (typeof row?.value !== "string") return;
  const state = JSON.parse(row.value) as {
    oldTraffic?: { post: OldTrafficCandidate; readings: ViewReading[] }[];
  } | null;
  if (!Array.isArray(state?.oldTraffic)) return;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO tieba_discovery_old_traffic
      (thread_id, post, last_at, last_views, next_check_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const track of state.oldTraffic) {
    const reading = track.readings?.at(-1);
    if (!track.post?.id || !reading) continue;
    if (
      !passesOldTrafficScreen(
        { post: track.post, ...reading },
        defaultTiebaDiscoveryRules,
      )
    )
      continue;
    insert.run(
      track.post.id,
      JSON.stringify(track.post),
      reading.at,
      reading.views,
      reading.at + observationGap,
    );
  }
  delete state.oldTraffic;
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
    JSON.stringify(state),
    tiebaDiscoveryStateKey,
  );
}

export function oldTrafficSummary(db: Store, rules: TiebaDiscoveryRules) {
  const admission = rules.oldResourceCheckEnabled ? "AND r.admitted = 1" : "";
  return {
    tracked: db.get<{ count: number }>(
      `SELECT count(*) AS count FROM tieba_discovery_old_traffic t
       LEFT JOIN tieba_discovery_old_resource r USING (thread_id)
       WHERE t.last_at IS NOT NULL ${admission}`,
    )!.count,
    total: db.get<{ count: number }>(
      `SELECT count(*) AS count FROM tieba_discovery_old_traffic t
       LEFT JOIN tieba_discovery_old_resource r USING (thread_id)
       WHERE t.daily_added > ? ${admission}`,
      rules.oldTrafficMinViews,
    )!.count,
  };
}

function oldTrafficQuery(
  rules: TiebaDiscoveryRules,
  view: TiebaOldTrafficView,
  resource: TiebaOldResourceFilter,
) {
  const screened = view === "screened";
  const admission = rules.oldResourceCheckEnabled ? "AND r.admitted = 1" : "";
  const scope = screened ? "t.last_at IS NOT NULL" : "t.daily_added > ?";
  const filters = {
    all: "",
    linked: " AND r.status = 'linked'",
    keywords: " AND r.status = 'keywords'",
    pending: " AND r.checked_at IS NULL AND coalesce(r.status, '') <> 'linked'",
    none: " AND r.status = 'none'",
  };
  const from = `FROM tieba_discovery_old_traffic t
    LEFT JOIN tieba_discovery_old_resource r USING (thread_id)
    WHERE ${scope} ${admission}${filters[resource]}`;
  return { from, args: screened ? [] : [rules.oldTrafficMinViews] };
}

const oldReadingColumns =
  "post, last_at, last_views, baseline_at, added_views, daily_added, previous_daily, evidence, checked_at";

export function oldTrafficPage(
  db: Store,
  requestedPage: number,
  rules: TiebaDiscoveryRules,
  view: TiebaOldTrafficView,
  resource: TiebaOldResourceFilter,
) {
  const { from, args } = oldTrafficQuery(rules, view, resource);
  const total = db.get<{ count: number }>(
    `SELECT count(*) AS count ${from}`,
    ...args,
  )!.count;
  const page = Math.min(
    requestedPage,
    Math.max(1, Math.ceil(total / pageSize)),
  );
  const items = db
    .all<Row>(
      `
    SELECT ${oldReadingColumns}
    ${from}
    ORDER BY ${view === "screened" ? "last_at DESC, last_views DESC" : "daily_added DESC, last_at DESC"}, thread_id
    LIMIT ? OFFSET ?
  `,
      ...args,
      pageSize,
      (page - 1) * pageSize,
    )
    .map((row) => oldTrafficReading(row, rules.oldTrafficMinViews));
  return { page, total, items };
}

function oldTrafficReading(row: Row, threshold: number): TiebaOldTrafficPost {
  const { id, title, url, forum, publishedAt, latestReading } = JSON.parse(
    row.post,
  ) as OldTrafficCandidate & { latestReading?: ViewReading };
  const latest =
    latestReading && latestReading.at >= row.last_at!
      ? latestReading
      : { at: row.last_at!, views: row.last_views! };
  return {
    id,
    title,
    url,
    forum,
    publishedAt,
    views: latest.views,
    checkedAt: latest.at,
    lifetimeDailyViews:
      latest.views / oldTrafficAge(publishedAt, latest.at),
    observationAt: row.last_at!,
    baselineAt: row.baseline_at,
    addedViews: row.added_views,
    dailyAddedViews: row.daily_added,
    ...(row.evidence
      ? {
          resource: {
            ...(JSON.parse(row.evidence) as TiebaOldResourceEvidence),
            checked: row.checked_at != null,
          },
        }
      : {}),
    sustained:
      row.daily_added !== null &&
      row.daily_added > threshold &&
      row.previous_daily !== null &&
      row.previous_daily > threshold,
  };
}

export function trafficPostsPage(
  db: Store,
  requestedPage: number,
  rules: TiebaDiscoveryRules,
  view: TiebaTrafficPostsView,
  resource: TiebaOldResourceFilter,
): { page: number; total: number; items: TiebaTrafficPost[] } {
  if (view === "high") {
    const { page, total, items } = trafficPage(db, requestedPage, rules);
    return { page, total, items: items.map((post) => ({
      ...post, kind: "high", archivedAt: post.archivedAt ?? post.checkedAt,
    })) };
  }
  if (view !== "all") {
    const { page, total, items } = oldTrafficPage(db, requestedPage, rules, view, resource);
    return { page, total, items: items.map((post) => ({ ...post, kind: "old" })) };
  }
  const { from } = oldTrafficQuery(rules, "screened", "all");
  const high = `FROM tieba_discovery_traffic h
    WHERE ${visibleHighTraffic("h.thread_id", rules.oldResourceCheckEnabled)}`;
  const total = db.get<{ count: number }>(
    `SELECT (SELECT count(*) ${from}) + (SELECT count(*) ${high}) AS count`,
  )!.count;
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
  const items = db.all<Row & { kind: "old" | "high"; sorted_at: number }>(
    `SELECT 'old' AS kind, t.thread_id AS id, t.last_at AS sorted_at, t.last_views AS sorted_views,
      ${oldReadingColumns} ${from}
    UNION ALL
    SELECT 'high', h.thread_id, h.archived_at, h.views,
      h.reading, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL ${high}
    ORDER BY sorted_at DESC, sorted_views DESC, id DESC LIMIT ? OFFSET ?`,
    pageSize, (page - 1) * pageSize,
  ).map((row): TiebaTrafficPost => row.kind === "old"
    ? { ...oldTrafficReading(row, rules.oldTrafficMinViews), kind: "old" }
    : { ...(JSON.parse(row.post) as TiebaDiscoveryTrafficPost), kind: "high", archivedAt: row.sorted_at });
  return { page, total, items };
}

export function dueOldTraffic(
  db: Store,
  at: number,
  limit: number,
  resourceCheckEnabled: boolean,
) {
  return db
    .all<Pick<Row, "post">>(
      `
    SELECT post FROM tieba_discovery_old_traffic t
    LEFT JOIN tieba_discovery_old_resource r USING (thread_id)
    WHERE t.next_check_at <= ? AND t.last_at IS NOT NULL
      ${resourceCheckEnabled ? "AND r.admitted = 1" : ""}
    ORDER BY t.next_check_at, t.thread_id LIMIT ?
  `,
      at,
      limit,
    )
    .map(({ post }) => JSON.parse(post) as OldTrafficCandidate);
}

export function saveOldTraffic(
  db: Store,
  readings: Iterable<OldTrafficReading>,
  retries: string[],
  at: number,
  rules: TiebaDiscoveryRules,
  verified?: TiebaOldResourceEvidence,
  refresh = false,
) {
  const read = db.db.prepare(
    `SELECT t.* FROM tieba_discovery_old_traffic t
     LEFT JOIN tieba_discovery_old_resource r USING (thread_id)
     WHERE t.thread_id = ? AND t.last_at IS NOT NULL
       ${rules.oldResourceCheckEnabled && !refresh ? "AND r.admitted = 1" : ""}`,
  );
  const write = db.db.prepare(`
    INSERT INTO tieba_discovery_old_traffic
      (thread_id, post, last_at, last_views, next_check_at, baseline_at, added_views, daily_added, previous_daily)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET post = excluded.post,
      last_at = excluded.last_at, last_views = excluded.last_views,
      next_check_at = excluded.next_check_at, baseline_at = excluded.baseline_at,
      added_views = excluded.added_views, daily_added = excluded.daily_added,
      previous_daily = excluded.previous_daily
  `);
  const defer = db.db.prepare(
    "UPDATE tieba_discovery_old_traffic SET next_check_at = max(next_check_at, ?) WHERE thread_id = ?",
  );
  let updated = 0;
  for (const reading of readings) {
    const { post, at, views } = reading;
    const current = read.get(post.id) as Row | undefined;
    if (
      views === null ||
      (!current &&
        ((rules.oldResourceCheckEnabled && !verified) ||
          !passesOldTrafficScreen(reading, rules)))
    )
      continue;
    const previousAt = current?.last_at ?? null;
    const savedPost = current
      ? (JSON.parse(current.post) as OldTrafficCandidate & {
          latestReading?: ViewReading;
        })
      : undefined;
    if (savedPost?.latestReading && savedPost.latestReading.at > at) continue;
    if (previousAt !== null && at < previousAt) continue;
    if (previousAt !== null && at === previousAt && !refresh) continue;
    if (
      previousAt !== null &&
      at - previousAt < observationGap &&
      !(refresh && views < current!.last_views!)
    ) {
      if (refresh) {
        db.db
          .prepare(
            "UPDATE tieba_discovery_old_traffic SET post = ? WHERE thread_id = ?",
          )
          .run(
            JSON.stringify({ ...post, latestReading: { at, views } }),
            post.id,
          );
        updated++;
      }
      if (reading.resource) saveOldResource(db, post.id, reading.resource);
      continue;
    }
    const previousViews = current?.last_views ?? views;
    const reset = views < previousViews;
    const baseline = reset ? null : previousAt;
    const added = baseline === null ? null : views - previousViews;
    const daily =
      baseline === null
        ? null
        : (views - previousViews) / ((at - baseline) / day);
    write.run(
      post.id,
      JSON.stringify(post),
      at,
      views,
      at + observationGap,
      baseline,
      added,
      daily,
      baseline === null ? null : (current?.daily_added ?? null),
    );
    if (verified) {
      saveOldResource(db, post.id, verified, at);
      admitOldResource(db, post.id);
    }
    if (reading.resource) saveOldResource(db, post.id, reading.resource);
    updated++;
  }
  for (const id of retries) defer.run(at + retryGap, id);
  return updated;
}

export function refreshOldTrafficReading(
  db: Store,
  id: string,
  at: number,
  views: number,
  rules: TiebaDiscoveryRules,
) {
  const row = db.get<Pick<Row, "post">>(
    "SELECT post FROM tieba_discovery_old_traffic WHERE thread_id = ? AND last_at IS NOT NULL",
    id,
  );
  if (!row) return false;
  saveOldTraffic(
    db,
    [{ post: JSON.parse(row.post), at, views }],
    [],
    at,
    rules,
    undefined,
    true,
  );
  return true;
}

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
  type TiebaTrafficSort,
  type TiebaTrafficSortDirection,
  type TiebaDiscoveryTrafficPost,
} from "../../shared/tieba-resource-discovery";
import type { Database } from "../database";
import { tiebaDiscoveryStateKey } from "./migration";
import { discoveryInterval as hour, type ViewReading } from "./rules";
import { admitOldResource, oldResourceAdmission, saveOldResource } from "./old-resource";
import { visibleHighTraffic } from "./archive";

const day = 24 * hour;
const observationGap = oldTrafficObservationDays * day;
const retryGap = 6 * hour;

export type OldTrafficCandidate = Pick<
  TiebaAnalysisThread,
  "id" | "title" | "url" | "forum" | "authorId"
> & { publishedAt: string; author?: string };

type StoredOldPost = OldTrafficCandidate & {
  archivedAt?: number;
  latestReading?: ViewReading;
};

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
      JSON.stringify({ ...track.post, archivedAt: track.readings[0].at }),
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
  const admission = rules.oldResourceCheckEnabled ? `AND ${oldResourceAdmission}` : "";
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
  const admission = rules.oldResourceCheckEnabled ? `AND ${oldResourceAdmission}` : "";
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
  ) as StoredOldPost;
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
  sort: TiebaTrafficSort,
  direction: TiebaTrafficSortDirection,
): { page: number; total: number; items: TiebaTrafficPost[] } {
  const old = view === "high" ? null : oldTrafficQuery(
    rules, view === "qualified" ? "qualified" : "screened",
    view === "all" ? "all" : resource,
  );
  const high = `FROM tieba_discovery_traffic h
    WHERE ${visibleHighTraffic("h.thread_id", rules.oldResourceCheckEnabled)}`;
  const includeHigh = view === "all" || view === "high";
  const sources = [old?.from, includeHigh ? high : null].filter(Boolean);
  const args = old?.args ?? [];
  const total = db.get<{ count: number }>(
    `SELECT ${sources.map((from) => `(SELECT count(*) ${from})`).join(" + ")} AS count`,
    ...args,
  )!.count;
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
  const latest = "json_extract(t.post, '$.latestReading.at') >= t.last_at";
  const selections = [
    old && `SELECT 'old' AS kind, t.thread_id AS id,
      coalesce(json_extract(t.post, '$.archivedAt'), t.baseline_at, t.last_at) AS archived_at,
      CASE WHEN ${latest} THEN json_extract(t.post, '$.latestReading.views') ELSE t.last_views END AS sorted_views,
      CASE WHEN ${latest} THEN json_extract(t.post, '$.latestReading.at') ELSE t.last_at END AS observed_at,
      unixepoch(json_extract(t.post, '$.publishedAt'), 'subsec') * 1000 AS published_at,
      ${oldReadingColumns} ${old.from}`,
    includeHigh && `SELECT 'high' AS kind, h.thread_id AS id, h.archived_at, h.views AS sorted_views,
      json_extract(h.reading, '$.checkedAt') AS observed_at,
      unixepoch(json_extract(h.reading, '$.publishedAt'), 'subsec') * 1000 AS published_at,
      h.reading AS post, NULL AS last_at, NULL AS last_views, NULL AS baseline_at, NULL AS added_views,
      NULL AS daily_added, NULL AS previous_daily, NULL AS evidence, NULL AS checked_at ${high}`,
  ].filter(Boolean);
  const order = {
    archivedAt: "archived_at",
    views: "sorted_views",
    lifetimeDailyViews: `CASE WHEN observed_at >= published_at
      THEN sorted_views * ${day}.0 / CASE WHEN kind = 'high'
        THEN max(observed_at - published_at, ${hour / 2})
        ELSE nullif(observed_at - published_at, 0) END END`,
    dailyAddedViews: "daily_added",
  };
  const items = db.all<Row & { kind: "old" | "high"; archived_at: number }>(
    `WITH posts AS (${selections.join(" UNION ALL ")})
     SELECT * FROM posts
     ORDER BY ${order[sort]} ${direction === "asc" ? "ASC" : "DESC"} NULLS LAST,
       archived_at DESC, sorted_views DESC, id DESC LIMIT ? OFFSET ?`,
    ...args, pageSize, (page - 1) * pageSize,
  ).map((row): TiebaTrafficPost => row.kind === "old"
    ? { ...oldTrafficReading(row, rules.oldTrafficMinViews), kind: "old", archivedAt: row.archived_at }
    : { ...(JSON.parse(row.post) as TiebaDiscoveryTrafficPost), kind: "high", archivedAt: row.archived_at });
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
      ${resourceCheckEnabled ? `AND ${oldResourceAdmission}` : ""}
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
       ${rules.oldResourceCheckEnabled && !refresh ? `AND ${oldResourceAdmission}` : ""}`,
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
    const savedPost = current ? (JSON.parse(current.post) as StoredOldPost) : undefined;
    if (savedPost?.latestReading && savedPost.latestReading.at > at) continue;
    if (previousAt !== null && at < previousAt) continue;
    if (previousAt !== null && at === previousAt && !refresh) continue;
    const archivedAt = savedPost?.archivedAt ?? current?.baseline_at ?? previousAt ?? at;
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
            JSON.stringify({ ...post, archivedAt, latestReading: { at, views } }),
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
      JSON.stringify({ ...post, archivedAt }),
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

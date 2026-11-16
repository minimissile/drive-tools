import { createHash } from "node:crypto";
import {
  tiebaForumExposureHours,
  tiebaForumExposureSampleLimit,
  tiebaPostExposure,
} from "../../shared/tieba-analysis";
import type {
  TiebaDiscoveryEvidence,
  TiebaDiscoveryGrowth,
  TiebaDiscoveryMetrics,
  TiebaDiscoveryPotentialEvidence,
  TiebaDiscoveryRules,
} from "../../shared/tieba-resource-discovery";
import { defaultTiebaDiscoveryRules, oldTrafficMinimumAgeDays, pendingObservationMultiplier, recentGrowthMaxReadingHours } from "../../shared/tieba-resource-discovery";
import { tiebaBodyDriveLinks } from "../tieba-post-stats/links";

const hour = 60 * 60 * 1000;
export const discoveryInterval = hour;
export const trafficLookback = 30 * 24 * hour;
export const minReadingGap = hour / 2;
const maxReadingGap = 3 * hour;
const recentGrowthMaxReadingGap = recentGrowthMaxReadingHours * hour;
const provider =
  /网盘|云盘|百度盘|夸克盘|阿里盘|迅雷盘|115盘|pan\.baidu\.com|pan\.quark\.cn/iu;
const sharing = /分享|合集|整理|完整版|全集|高清|下载|资源|打包|附链|自取/iu;
const seeking =
  /^(?:【[^】]{1,16}】\s*)?(?:求(?:个|一份|分享|资源|链接|补链|助|片|盘|大佬|\s|[^，。]{1,20}(?:资源|链接|网盘))|跪求|蹲(?:个|资源|链接|更新)|有(?:人|谁).{0,14}(?:吗|么|？|\?))/iu;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function resourceEvidence(
  title: string,
  body: string,
  hrefs: string[],
): TiebaDiscoveryEvidence | undefined {
  const normalized = title.normalize("NFKC").trim();
  if (seeking.test(normalized)) return;
  const links = tiebaBodyDriveLinks(body, hrefs);
  const text = normalized + "\n" + body;
  if (!links.length && !(provider.test(text) && sharing.test(text))) return;
  // Conservative title matching keeps editions, seasons and other qualifiers.
  const name = normalized
    .replace(
      /\s*[|｜·-]?\s*(?:百度网盘|夸克网盘|阿里云盘|迅雷网盘)(?:分享|自取)?\s*$/u,
      "",
    )
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\s]/gu, "");
  return {
    keys: [
      ...links.map((link) => `link:${hash(link.split("?")[0])}`),
      ...(name.length >= 5 ? [`title:${hash(name)}`] : []),
    ],
    linked: links.length > 0,
  };
}

export interface ViewReading {
  at: number;
  views: number;
}
export interface ViewState {
  baseline: ViewReading | null;
  growth: TiebaDiscoveryGrowth | null;
  streak: number;
}

export function observeViews(
  previous: ViewState,
  at: number,
  views: number | null,
  maxGap = maxReadingGap,
): ViewState {
  if (views === null) return { baseline: null, growth: null, streak: 0 };
  const baseline = previous.baseline;
  if (!baseline || views < baseline.views || at - baseline.at > maxGap)
    return { baseline: { at, views }, growth: null, streak: 0 };
  const span = at - baseline.at;
  if (span < minReadingGap) return previous;
  const delta = views - baseline.views;
  return {
    baseline: { at, views },
    growth: { from: baseline.at, to: at, delta, hourly: (delta * hour) / span },
    streak: previous.streak,
  };
}

function ageBand(age: number) {
  if (age < 2 * hour) return 0;
  if (age < 8 * hour) return 1;
  if (age < 24 * hour) return 2;
  if (age < 48 * hour) return 3;
  if (age < 72 * hour) return 4;
  if (age < 7 * 24 * hour) return 5;
  if (age < 14 * 24 * hour) return 6;
  return 7;
}

export function groupResources<T extends { id: string; keys: string[] }>(
  posts: readonly T[],
) {
  const parents = new Map<string, string>();
  const find = (id: string): string => {
    const parent = parents.get(id);
    if (!parent || parent === id) return id;
    const root = find(parent);
    parents.set(id, root);
    return root;
  };
  const resourceOwners = new Map<string, string>();
  for (const post of posts) {
    for (const resource of post.keys) {
      const owner = resourceOwners.get(resource);
      if (owner) parents.set(find(post.id), find(owner));
      else resourceOwners.set(resource, post.id);
    }
  }
  const groups = new Map<string, T[]>();
  for (const post of posts) {
    const root = find(post.id);
    const group = groups.get(root) ?? [];
    group.push(post);
    groups.set(root, group);
  }
  return [...groups.values()];
}

const cohortKey = (forum: string, age: number) =>
  `${forum.normalize("NFKC").trim().toLowerCase()}:${ageBand(age)}`;

type PublicReading = {
  id: string;
  forum: string;
  publishedAt: string | null;
  views: number | null;
};

function viewVelocity(post: PublicReading, at: number, lookback: number) {
  const age = at - Date.parse(post.publishedAt ?? "");
  if (!(age >= 0 && age <= lookback)) return null;
  const speed = tiebaPostExposure(post.views, post.publishedAt, at);
  if (speed === null) return null;
  return {
    age,
    speed,
  };
}

export function forumExposure(posts: readonly PublicReading[], at: number) {
  const eligible = new Map<string, { age: number; speed: number }>();
  for (const post of posts) {
    if (eligible.has(post.id)) continue;
    const reading = viewVelocity(post, at, tiebaForumExposureHours * hour);
    if (reading) eligible.set(post.id, reading);
  }
  const speeds = [...eligible.values()]
    .sort((a, b) => a.age - b.age)
    .slice(0, tiebaForumExposureSampleLimit)
    .map(({ speed }) => speed)
    .sort((a, b) => a - b);
  if (speeds.length < 4) return null;
  const center = Math.floor(speeds.length / 2);
  const hourly =
    speeds.length % 2
      ? speeds[center]
      : (speeds[center - 1] + speeds[center]) / 2;
  return { hourly, sample: speeds.length, observedAt: at };
}

type PotentialReading = Pick<TiebaDiscoveryMetrics, "views"> & {
  publishedAt: string;
  checkedAt: number;
};

export function pendingObservationDueAt(
  post: Pick<PotentialReading, "publishedAt">,
  rules: TiebaDiscoveryRules,
) {
  return Date.parse(post.publishedAt) + rules.pendingObservationHours * hour;
}

export function awaitsMaturePotentialReading(
  post: Pick<PotentialReading, "publishedAt" | "checkedAt">,
  rules: TiebaDiscoveryRules,
) {
  return post.checkedAt < pendingObservationDueAt(post, rules);
}

export function qualifyingHourlyViews(
  post: PotentialReading,
  now: number,
  rules: TiebaDiscoveryRules,
) {
  const age = now - Date.parse(post.publishedAt);
  if (
    !(age >= 0 && age <= rules.lookbackHours * hour) ||
    post.checkedAt > now ||
    post.views === null ||
    post.views >= rules.trafficThreshold
  )
    return null;
  const hourly = tiebaPostExposure(post.views, post.publishedAt, post.checkedAt);
  return hourly !== null && hourly >= rules.minHourlyViews ? hourly : null;
}

export function inRecentGrowthWindow(
  post: Pick<PotentialReading, "publishedAt">,
  at: number,
  rules: TiebaDiscoveryRules,
) {
  const age = at - Date.parse(post.publishedAt);
  return age > rules.lookbackHours * hour && age < oldTrafficMinimumAgeDays * 24 * hour;
}

export function observePostViews(
  post: Pick<PotentialReading, "publishedAt"> & ViewState,
  at: number,
  views: number,
  rules: TiebaDiscoveryRules,
) {
  return observeViews(post, at, views,
    inRecentGrowthWindow(post, at, rules) ? recentGrowthMaxReadingGap : maxReadingGap);
}

export function potentialSignals<
  T extends TiebaDiscoveryMetrics & PotentialReading & {
    id: string;
    keys: string[];
    forum: string;
    growth?: TiebaDiscoveryGrowth | null;
  },
>(
  posts: readonly T[],
  at: number,
  rules: TiebaDiscoveryRules = defaultTiebaDiscoveryRules,
) {
  type Stage = "pending" | "potential";
  const groups = new Map<string, (T & { hourlyViews: number; stage: Stage; recentGrowth?: TiebaDiscoveryGrowth })[]>();
  for (const post of posts) {
    const growth = post.growth;
    const recentGrowth = inRecentGrowthWindow(post, post.checkedAt, rules) &&
      post.views !== null && post.views < rules.trafficThreshold &&
      growth && growth.to === post.checkedAt && growth.to <= at &&
      growth.to - growth.from >= minReadingGap && growth.to - growth.from <= recentGrowthMaxReadingGap &&
      growth.hourly * 24 >= rules.recentGrowthMinDailyViews ? growth : undefined;
    const hourlyViews = recentGrowth?.hourly ?? qualifyingHourlyViews(post, at, rules);
    if (hourlyViews === null) continue;
    const stage = post.checkedAt < pendingObservationDueAt(post, rules)
      ? "pending" : "potential";
    if (stage === "pending" && hourlyViews < rules.minHourlyViews * pendingObservationMultiplier)
      continue;
    const key = recentGrowth
      ? `growth:${post.id}`
      : `${stage}:${cohortKey(post.forum, at - Date.parse(post.publishedAt))}`;
    const cohort = groups.get(key) ?? [];
    cohort.push({ ...post, hourlyViews, stage, recentGrowth });
    groups.set(key, cohort);
  }

  const selected = new Map<string, TiebaDiscoveryPotentialEvidence & {
    stage: Stage;
  }>();
  for (const cohort of groups.values()) {
    for (const copies of groupResources(cohort)) {
      const [post] = copies.sort(
        (a, b) => b.hourlyViews - a.hourlyViews || a.id.localeCompare(b.id),
      );
      const { checkedAt, hourlyViews, views, replies, likes, shares, stage, recentGrowth } = post;
      selected.set(post.id, {
        at: checkedAt,
        hourlyViews,
        views,
        replies,
        likes,
        shares,
        stage,
        ...(recentGrowth ? { recentGrowth } : {}),
      });
    }
  }
  return selected;
}

export function resourceRanks<
  T extends {
    id: string;
    forum: string;
    publishedAt: string;
    growth: TiebaDiscoveryGrowth | null;
  },
>(posts: readonly T[], now: number, lookback: number) {
  const groups = new Map<string, (T & { growth: TiebaDiscoveryGrowth })[]>();
  for (const post of posts) {
    if (!post.growth || now - post.growth.to > 2 * hour ||
        post.growth.to - post.growth.from > maxReadingGap) continue;
    const age = post.growth.to - Date.parse(post.publishedAt);
    if (age < 0 || age > lookback) continue;
    const key = cohortKey(post.forum, age);
    const list = groups.get(key) ?? [];
    list.push({ ...post, growth: post.growth });
    groups.set(key, list);
  }
  const ranks = new Map<string, { place: number; sample: number }>();
  for (const list of groups.values()) {
    if (list.length < 4) continue;
    for (const post of list)
      ranks.set(post.id, {
        place: list.filter((peer) => peer.growth.hourly >= post.growth.hourly)
          .length,
        sample: list.length,
      });
  }
  return ranks;
}

export function meetsDiscoveryRule(
  growth: TiebaDiscoveryGrowth | null,
  rank: { place: number; sample: number } | undefined,
) {
  return (
    !!growth &&
    growth.delta >= 10 &&
    !!rank &&
    rank.place <= Math.floor(rank.sample / 4)
  );
}

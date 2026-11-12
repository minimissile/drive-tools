import { createHash } from "node:crypto";
import type {
  TiebaDiscoveryEvidence,
  TiebaDiscoveryGrowth,
  TiebaDiscoveryMetrics,
  TiebaDiscoveryPotentialEvidence,
  TiebaDiscoveryRules,
} from "../../shared/tieba-resource-discovery";
import { defaultTiebaDiscoveryRules } from "../../shared/tieba-resource-discovery";
import { tiebaBodyDriveLinks } from "../tieba-post-stats/links";

const hour = 60 * 60 * 1000;
export const discoveryInterval = hour;
export const trafficLookback = 30 * 24 * hour;
export const minReadingGap = hour / 2;
const maxReadingGap = 3 * hour;
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
): ViewState {
  if (views === null) return { baseline: null, growth: null, streak: 0 };
  const baseline = previous.baseline;
  if (!baseline || views < baseline.views || at - baseline.at > maxReadingGap)
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
  if (post.views === null || !(age >= 0 && age <= lookback)) return null;
  return {
    key: cohortKey(post.forum, age),
    speed: (post.views * hour) / Math.max(minReadingGap, age),
  };
}

function velocityRank(speed: number, peers: readonly number[]) {
  const sample = peers.length;
  const place = peers.filter((peer) => peer >= speed).length;
  return {
    place,
    sample,
    score: Math.floor((100 * (sample - place)) / (sample - 1)),
  };
}

export function publicPostPotential(
  post: PublicReading,
  peers: readonly PublicReading[],
  at: number,
  lookback = 48 * hour,
) {
  const current = viewVelocity(post, at, lookback);
  if (!current) return null;
  const speeds = [current.speed];
  for (const peer of peers) {
    if (peer.id === post.id) continue;
    const reading = viewVelocity(peer, at, lookback);
    if (reading?.key === current.key) speeds.push(reading.speed);
  }
  return speeds.length >= 4 ? velocityRank(current.speed, speeds) : null;
}

export function forumExposure(posts: readonly PublicReading[], at: number) {
  const speeds = posts
    .flatMap((post) => viewVelocity(post, at, 48 * hour)?.speed ?? [])
    .sort((a, b) => a - b);
  if (speeds.length < 4) return null;
  const center = Math.floor(speeds.length / 2);
  const hourly =
    speeds.length % 2
      ? speeds[center]
      : (speeds[center - 1] + speeds[center]) / 2;
  return { hourly, sample: speeds.length, observedAt: at };
}

export function potentialSignals<
  T extends TiebaDiscoveryMetrics & {
    id: string;
    keys: string[];
    forum: string;
    publishedAt: string;
  },
>(
  posts: readonly T[],
  at: number,
  rules: TiebaDiscoveryRules = defaultTiebaDiscoveryRules,
) {
  const groups = new Map<string, (T & { views: number; velocity: number })[]>();
  const lookback = rules.lookbackHours * hour;
  for (const post of posts) {
    const reading = viewVelocity(post, at, lookback);
    if (post.views === null || post.views >= rules.trafficThreshold || !reading)
      continue;
    const key = reading.key;
    const cohort = groups.get(key) ?? [];
    cohort.push({
      ...post,
      views: post.views,
      velocity: reading.speed,
    });
    groups.set(key, cohort);
  }

  const selected = new Map<string, TiebaDiscoveryPotentialEvidence>();
  for (const cohort of groups.values()) {
    const peers = groupResources(cohort).map(
      (copies) =>
        copies.sort(
          (a, b) => b.velocity - a.velocity || a.id.localeCompare(b.id),
        )[0],
    );
    const sample = peers.length;
    if (sample < 4) continue;
    const speeds = peers.map((peer) => peer.velocity);
    for (const post of peers) {
      const { place, score } = velocityRank(post.velocity, speeds);
      if (post.views < 10 || score < rules.potentialThreshold) continue;
      const { views, replies, likes, shares } = post;
      selected.set(post.id, {
        at,
        score,
        views,
        replies,
        likes,
        shares,
        comparedInteractions: false,
        rank: { place, sample },
        viewRank: { place, sample },
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
    if (!post.growth || now - post.growth.to > 2 * hour) continue;
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

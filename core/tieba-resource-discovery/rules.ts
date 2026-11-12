import { createHash } from "node:crypto";
import type {
  TiebaDiscoveryEvidence,
  TiebaDiscoveryGrowth,
  TiebaDiscoveryMetrics,
  TiebaDiscoveryPotentialEvidence,
} from "../../shared/tieba-resource-discovery";
import { tiebaBodyDriveLinks } from "../tieba-post-stats/links";

const hour = 60 * 60 * 1000;
export const discoveryInterval = hour;
export const discoveryLookback = 48 * hour;
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
  return 3;
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

const interactionFields = ["replies", "likes", "shares"] as const;

export function potentialSignals<
  T extends TiebaDiscoveryMetrics & {
    id: string;
    keys: string[];
    forum: string;
    publishedAt: string;
  },
>(posts: readonly T[], at: number) {
  const groups = new Map<string, (T & { views: number })[]>();
  for (const post of posts) {
    const age = at - Date.parse(post.publishedAt);
    if (post.views === null || !(age >= 0 && age <= discoveryLookback))
      continue;
    const key = cohortKey(post.forum, age);
    const cohort = groups.get(key) ?? [];
    cohort.push({ ...post, views: post.views });
    groups.set(key, cohort);
  }

  const selected = new Map<string, TiebaDiscoveryPotentialEvidence>();
  for (const cohort of groups.values()) {
    const peers = groupResources(cohort).map(
      (copies) =>
        copies.sort((a, b) => b.views - a.views || a.id.localeCompare(b.id))[0],
    );
    const sample = peers.length;
    if (sample < 4) continue;
    const interactionSamples = interactionFields.map((field) =>
      peers.flatMap((peer) => peer[field] ?? []),
    );
    const scored = peers.map((post) => {
      const viewPlace = peers.filter((peer) => peer.views >= post.views).length;
      const interactionScores = interactionFields.flatMap((field, index) => {
        const values = interactionSamples[index];
        const value = post[field];
        if (value === null || values.length < 4) return [];
        return [
          (values.length - values.filter((peer) => peer >= value).length) /
            (values.length - 1),
        ];
      });
      const interactions = interactionScores.length
        ? interactionScores.reduce((sum, value) => sum + value, 0) /
          interactionScores.length
        : 0;
      return {
        post,
        viewPlace,
        comparedInteractions: interactionScores.length > 0,
        score:
          ((sample - viewPlace) / (sample - 1)) * 0.75 + interactions * 0.25,
      };
    });
    for (const { post, viewPlace, score, comparedInteractions } of scored) {
      const place = scored.filter((peer) => peer.score >= score).length;
      if (
        post.views < 10 ||
        viewPlace > Math.ceil(sample / 2) ||
        place > Math.floor(sample / 4)
      )
        continue;
      const { views, replies, likes, shares } = post;
      selected.set(post.id, {
        at,
        views,
        replies,
        likes,
        shares,
        comparedInteractions,
        rank: { place, sample },
        viewRank: { place: viewPlace, sample },
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
>(posts: readonly T[], now: number) {
  const groups = new Map<string, (T & { growth: TiebaDiscoveryGrowth })[]>();
  for (const post of posts) {
    if (!post.growth || now - post.growth.to > 2 * hour) continue;
    const age = post.growth.to - Date.parse(post.publishedAt);
    if (age < 0 || age > discoveryLookback) continue;
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

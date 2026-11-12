import type { TiebaAnalysisThread } from "../../shared/tieba-analysis";
import type {
  TiebaDiscoveryCandidate,
  TiebaDiscoveryPotentialEvidence,
  TiebaDiscoverySnapshot,
  TiebaDiscoverySource,
} from "../../shared/tieba-resource-discovery";
import { tiebaForumNameSchema } from "../../shared/tieba-forums";
import type { Database } from "../database";
import { AppError } from "../errors";
import { potentialCount, potentialPage, savePotentialPosts } from "./archive";
import {
  queryTiebaAnalysis,
  queryTiebaAnalysisFollowedForums,
  queryTiebaAnalysisForumPosts,
  readTiebaDiscoveryViews,
} from "../tieba/analysis";
import {
  discoveryInterval,
  discoveryLookback,
  groupResources,
  meetsDiscoveryRule,
  minReadingGap,
  observeViews,
  potentialSignals,
  resourceRanks,
  type ViewState,
} from "./rules";

const storageKey = "tieba.resourceDiscovery.v1";
const autoKey = "tieba.resourceDiscovery.auto";
const additionalForumsPerScan = 3;
const key = (name: string) => name.normalize("NFKC").trim().toLowerCase();
const seed = (name: string): TiebaDiscoverySource => ({
  name,
  status: "seed",
  path: [name],
  scannedAt: null,
});

type Post = Omit<TiebaDiscoveryCandidate, "rank" | "paths" | "copies"> &
  ViewState & {
    uid: string | null;
    keys: string[];
    path: string[];
    checkedAt: number;
    interactions?: Pick<TiebaAnalysisThread, "replies" | "likes" | "shares">;
    potential?: TiebaDiscoveryPotentialEvidence;
  };
type StoredSource = TiebaDiscoverySource & {
  addedAt?: number;
  lastUsefulAt?: number;
  lastAttemptAt?: number;
};
type Stored = {
  seeds: string[];
  sources: StoredSource[];
  posts: Post[];
  authors: Record<string, number>;
  lastRun: TiebaDiscoverySnapshot["lastRun"];
};

const orderPosts = (a: Post, b: Post) =>
  b.streak - a.streak ||
  Number(!!b.potential) - Number(!!a.potential) ||
  (b.growth?.hourly ?? -1) - (a.growth?.hourly ?? -1) ||
  (b.views ?? -1) - (a.views ?? -1) ||
  Number(b.linked) - Number(a.linked) ||
  b.publishedAt.localeCompare(a.publishedAt);

const recent = (
  post: Pick<TiebaAnalysisThread, "publishedAt">,
  now: number,
  within = discoveryLookback,
) => {
  const time = Date.parse(post.publishedAt ?? "");
  return time <= now && now - time <= within;
};

function candidates(posts: Post[], now: number) {
  const ranks = resourceRanks(posts, now);
  const trending: TiebaDiscoveryCandidate[] = [];
  const watching: TiebaDiscoveryCandidate[] = [];
  const qualifies = (post: Post) =>
    meetsDiscoveryRule(post.growth, ranks.get(post.id));
  for (const group of groupResources(posts)) {
    group.sort(
      (a, b) => Number(qualifies(b)) - Number(qualifies(a)) || orderPosts(a, b),
    );
    const post = group[0];
    const paths = [
      ...new Map(
        group.map((item) => [JSON.stringify(item.path), item.path]),
      ).values(),
    ];
    const {
      id,
      title,
      url,
      forum,
      author,
      publishedAt,
      linked,
      views,
      growth,
      streak,
    } = post;
    const candidate = {
      id,
      title,
      url,
      forum,
      author,
      publishedAt,
      linked,
      views,
      growth,
      streak,
      rank: ranks.get(id) ?? null,
      copies: group.length,
      paths,
    };
    if (qualifies(post)) trending.push(candidate);
    else if (!group.some((copy) => copy.potential)) watching.push(candidate);
  }
  const score = (a: TiebaDiscoveryCandidate, b: TiebaDiscoveryCandidate) =>
    b.streak - a.streak ||
    (b.growth?.hourly ?? -1) - (a.growth?.hourly ?? -1) ||
    Number(b.linked) - Number(a.linked) ||
    (b.views ?? -1) - (a.views ?? -1);
  return {
    trending: trending.sort(score).slice(0, 30),
    watching: watching.sort(score).slice(0, 30),
  };
}

export interface TiebaDiscoveryReaders {
  forum: typeof queryTiebaAnalysisForumPosts;
  user: typeof queryTiebaAnalysis;
  followed: typeof queryTiebaAnalysisFollowedForums;
  views: typeof readTiebaDiscoveryViews;
}

const readers: TiebaDiscoveryReaders = {
  forum: queryTiebaAnalysisForumPosts,
  user: queryTiebaAnalysis,
  followed: queryTiebaAnalysisFollowedForums,
  views: readTiebaDiscoveryViews,
};

export class TiebaResourceDiscovery {
  private auto: boolean;
  private nextAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: AbortController | undefined;
  private closed = false;

  constructor(
    private db: Pick<
      Database,
      "setting" | "setSetting" | "get" | "all" | "db" | "transaction"
    >,
    private changed: () => void,
    private read = readers,
    private now = Date.now,
  ) {
    this.auto = this.db.setting<boolean>(autoKey, false) === true;
    if (this.auto) this.scheduleNext();
  }

  get isBusy() {
    return !!this.active;
  }

  private stored() {
    return this.db.setting<Stored>(storageKey, {
      seeds: ["网盘资源"],
      sources: [seed("网盘资源")],
      posts: [],
      authors: {},
      lastRun: null,
    });
  }

  snapshot(): TiebaDiscoverySnapshot {
    const state = this.stored(),
      now = this.now();
    return {
      seeds: state.seeds,
      sources: state.sources,
      busy: this.isBusy,
      auto: this.auto,
      nextAt: this.nextAt,
      potentialCount: potentialCount(this.db),
      lastRun: state.lastRun,
      ...candidates(
        state.posts.filter((post) => recent(post, now)),
        now,
      ),
    };
  }

  potential(page: number) {
    return potentialPage(this.db, page, this.now());
  }

  saveSeeds(names: string[]) {
    if (this.isBusy)
      throw new AppError(
        "TIEBA_DISCOVERY_BUSY",
        "请等本轮扫描结束后再修改种子贴吧。",
      );
    const state = this.stored();
    state.seeds = [...new Map(names.map((name) => [key(name), name])).values()];
    const old = new Map(
      state.sources.map((source) => [key(source.name), source]),
    );
    state.sources = [
      ...state.seeds.map((name) => ({
        ...seed(name),
        scannedAt: old.get(key(name))?.scannedAt ?? null,
      })),
      ...state.sources.filter(
        (source) =>
          source.status !== "seed" &&
          !state.seeds.some((name) => key(name) === key(source.name)),
      ),
    ];
    this.db.setSetting(storageKey, state);
    this.changed();
    return this.snapshot();
  }

  setAuto(enabled: boolean) {
    this.db.setSetting(autoKey, enabled);
    this.auto = enabled;
    if (!enabled) this.clearTimer();
    else if (!this.isBusy) this.scheduleNext();
    this.changed();
    return this.snapshot();
  }

  scan() {
    if (this.isBusy) return this.snapshot();
    this.clearTimer();
    const controller = new AbortController();
    this.active = controller;
    void this.run(controller.signal)
      .catch((error: unknown) => {
        if (this.closed) return;
        const state = this.stored();
        state.lastRun = {
          at: this.now(),
          forums: 0,
          authors: 0,
          added: 0,
          warnings: [
            error instanceof Error
              ? error.message.slice(0, 160)
              : "扫描未完成，请重试。",
          ],
        };
        this.db.setSetting(storageKey, state);
      })
      .finally(() => {
        this.active = undefined;
        if (this.closed) return;
        if (this.auto) this.schedule(discoveryInterval);
        this.changed();
      });
    this.changed();
    return this.snapshot();
  }

  dispose() {
    this.closed = true;
    this.clearTimer();
    this.active?.abort();
  }

  private clearTimer() {
    clearTimeout(this.timer);
    this.nextAt = null;
  }

  private schedule(delay: number) {
    this.clearTimer();
    this.nextAt = this.now() + delay;
    this.timer = setTimeout(() => {
      if (this.auto && !this.closed) this.scan();
    }, delay);
    this.timer.unref();
  }

  private scheduleNext() {
    const last = this.stored().lastRun?.at;
    this.schedule(
      last === undefined
        ? 0
        : Math.max(0, last + discoveryInterval - this.now()),
    );
  }

  private async run(signal: AbortSignal) {
    const state = this.stored(),
      now = this.now();
    const send: typeof fetch = (input, options) =>
      fetch(input, {
        ...options,
        signal: options?.signal
          ? AbortSignal.any([signal, options.signal])
          : signal,
      });
    const warnings: string[] = [];
    async function attempt<T>(label: string, read: () => Promise<T>) {
      signal.throwIfAborted();
      try {
        return await read();
      } catch (error) {
        signal.throwIfAborted();
        warnings.push(
          `${label}：${error instanceof Error ? error.message.slice(0, 100) : "读取失败"}`,
        );
        return undefined;
      }
    }
    const posts = new Map(
      state.posts
        .filter((post) => recent(post, now))
        .map((post) => [post.id, post]),
    );
    const before = new Set(posts.keys()),
      listed = new Set<string>(),
      seen = new Set<string>(),
      missingListViews = new Set<string>(),
      advanced = new Set<string>();
    const sources = new Map(
      state.sources
        .filter(
          (source) =>
            source.status === "seed" ||
            now - (source.lastUsefulAt ?? source.addedAt ?? now) <=
              (source.status === "watch" ? 7 : 14) * 24 * discoveryInterval,
        )
        .map((source) => [key(source.name), source]),
    );
    const lastAttempt = (source: StoredSource) =>
      source.lastAttemptAt ?? source.scannedAt ?? 0;
    const dueSources = [...sources.values()]
      .filter((source) => {
        const interval =
          source.status === "watch" && source.scannedAt !== null ? 2 : 1;
        return (
          source.status !== "seed" &&
          now - lastAttempt(source) >= interval * discoveryInterval
        );
      })
      .sort((a, b) => lastAttempt(a) - lastAttempt(b));
    // Keep a slot for a follow-up when new forums are waiting to be sampled.
    const revisit = dueSources.find((source) => source.scannedAt !== null);
    const selected = [
      ...[...sources.values()].filter((source) => source.status === "seed"),
      ...(revisit ? [revisit] : []),
      ...dueSources
        .filter((source) => source !== revisit)
        .slice(0, additionalForumsPerScan - Number(!!revisit)),
    ];
    const record = (post: Post, views: number | null) => {
      const at = this.now();
      const reading = observeViews(post, at, views);
      if (reading.growth?.to !== post.growth?.to) advanced.add(post.id);
      posts.set(post.id, { ...post, ...reading, views, checkedAt: at });
      seen.add(post.id);
    };
    let readForums = 0;
    for (const source of selected) {
      source.lastAttemptAt = this.now();
      for (let page = 1; page <= 3; page++) {
        const result = await attempt(source.name, () =>
          this.read.forum({ name: source.name, page }, send, true),
        );
        if (!result) break;
        if (page === 1) {
          readForums++;
          source.scannedAt = this.now();
        }
        for (const item of result.threads) {
          if (
            !item.publishedAt ||
            !recent(item, this.now()) ||
            seen.has(item.id)
          )
            continue;
          const old = posts.get(item.id);
          if (!item.resource && !old) continue;
          listed.add(item.id);
          source.lastUsefulAt = this.now();
          const post: Post = {
            id: item.id,
            title: item.title,
            url: item.url,
            forum: result.name,
            uid: item.authorId ?? old?.uid ?? null,
            author: item.author || old?.author || "",
            publishedAt: item.publishedAt,
            linked: item.resource?.linked || old?.linked || false,
            keys: [
              ...new Set([
                ...(old?.keys ?? []),
                ...(item.resource?.keys ?? []),
              ]),
            ],
            path: source.path,
            views: old?.views ?? null,
            checkedAt: old?.checkedAt ?? 0,
            baseline: old?.baseline ?? null,
            growth: old?.growth ?? null,
            streak: old?.streak ?? 0,
            interactions: {
              replies: item.replies,
              likes: item.likes,
              shares: item.shares,
            },
            potential: old?.potential,
          };
          if (item.views === null) {
            posts.set(item.id, post);
            missingListViews.add(item.id);
          } else {
            missingListViews.delete(item.id);
            record(post, item.views);
          }
        }
        if (
          !result.hasMore ||
          result.threads.every(
            (post) => post.publishedAt && !recent(post, this.now()),
          )
        )
          break;
      }
    }

    const due = [...posts.values()]
      .filter(
        (post) =>
          !seen.has(post.id) &&
          (missingListViews.has(post.id) || before.has(post.id)) &&
          (!before.has(post.id) ||
            this.now() - post.checkedAt >= minReadingGap),
      )
      .sort(
        (a, b) =>
          Number(!!b.potential) - Number(!!a.potential) ||
          Number(b.streak > 0) - Number(a.streak > 0) ||
          Number(before.has(b.id)) - Number(before.has(a.id)) ||
          a.checkedAt - b.checkedAt,
      )
      .slice(0, 20);
    for (const post of due) {
      const views = await attempt(`${post.forum}帖子复查`, () =>
        this.read.views(post.id, send),
      );
      if (views !== undefined) record(post, views);
    }
    for (const id of missingListViews) {
      const post = posts.get(id);
      if (post && !seen.has(id)) {
        // Keep the last baseline for the next successful reading, but display
        // the missing value and exclude it from this round's ranking.
        posts.set(id, { ...post, views: null, growth: null, streak: 0 });
      }
    }

    const observations = [...posts.values()];
    const rankedAt = this.now();
    const firstSignals = potentialSignals(
      observations
        .filter((post) => listed.has(post.id) && seen.has(post.id))
        .map((post) => ({
          ...post,
          replies: post.interactions?.replies ?? null,
          likes: post.interactions?.likes ?? null,
          shares: post.interactions?.shares ?? null,
        })),
      rankedAt,
    );
    const ranks = resourceRanks(observations, rankedAt);
    for (const post of observations) {
      post.potential ??= firstSignals.get(post.id);
      if (advanced.has(post.id))
        post.streak = meetsDiscoveryRule(post.growth, ranks.get(post.id))
          ? post.streak + 1
          : 0;
    }
    for (const source of selected.filter(
      (source) => source.status === "watch",
    )) {
      const inForum = observations.filter(
        (post) => key(post.forum) === key(source.name),
      );
      if (
        new Set(inForum.flatMap((post) => (post.uid ? [post.uid] : []))).size >=
          2 &&
        groupResources(inForum).length >= 3 &&
        inForum.some((post) => (post.growth?.delta ?? 0) > 0)
      )
        source.status = "active";
    }

    const authorPosts = new Map<string, Post[]>();
    for (const post of observations) {
      if (
        !post.uid ||
        !seen.has(post.id) ||
        post.views === null ||
        now - (state.authors[post.uid] ?? -Infinity) < 6 * discoveryInterval
      )
        continue;
      const group = authorPosts.get(post.uid) ?? [];
      group.push(post);
      authorPosts.set(post.uid, group);
    }
    const authorChoices = [...authorPosts.entries()]
      .flatMap(([uid, items]) => {
        const distinct = groupResources(items).length;
        const best = items.sort(orderPosts)[0];
        return best.streak || best.potential || distinct >= 2
          ? [{ uid, best, distinct }]
          : [];
      })
      .sort(
        (a, b) =>
          b.best.streak - a.best.streak ||
          Number(!!b.best.potential) - Number(!!a.best.potential) ||
          b.distinct - a.distinct ||
          orderPosts(a.best, b.best),
      );
    const perForum = new Map<string, number>();
    const pending = [...sources.values()].filter(
      (source) => source.status !== "seed" && lastAttempt(source) === 0,
    ).length;
    const slots = Math.min(
      additionalForumsPerScan,
      2 * additionalForumsPerScan - pending,
      80 - sources.size,
    );
    let probed = 0,
      added = 0;
    function addSource(candidate: string, best: Post, author: string) {
      const parsed = tiebaForumNameSchema.safeParse(candidate);
      if (!parsed.success || sources.has(key(parsed.data))) return false;
      const name = parsed.data;
      sources.set(key(name), {
        name,
        status: "watch",
        scannedAt: null,
        addedAt: now,
        path: [
          ...best.path.slice(0, 7),
          ...(best.path.length > 7 ? [best.forum] : []),
          author,
          name,
        ],
      });
      added++;
      return true;
    }

    const followCandidates: { uid: string; best: Post; author: string }[] = [];
    for (const { uid, best } of authorChoices) {
      if (probed >= 10 || added >= slots) break;
      const from = key(best.forum);
      if ((perForum.get(from) ?? 0) >= 5) continue;
      probed++;
      perForum.set(from, (perForum.get(from) ?? 0) + 1);
      const user = await attempt(best.author || uid, () =>
        this.read.user({ target: `UID: ${uid}`, page: 1 }, send, true),
      );
      if (!user) continue;
      state.authors[uid] = this.now();
      const author = user.author || best.author || uid;
      const byForum = new Map<string, TiebaAnalysisThread[]>();
      for (const post of user.threads) {
        if (
          !post.forum ||
          !post.resource ||
          !recent(post, this.now(), 7 * 24 * discoveryInterval) ||
          sources.has(key(post.forum))
        )
          continue;
        const entries = byForum.get(post.forum) ?? [];
        entries.push(post);
        byForum.set(post.forum, entries);
      }
      const names = [...byForum]
        .map(
          ([name, items]) =>
            [
              name,
              groupResources(
                items.map((item) => ({
                  id: item.id,
                  keys: item.resource?.keys ?? [],
                })),
              ).length,
            ] as const,
        )
        .sort((a, b) => b[1] - a[1])
        .slice(0, slots - added)
        .map(([name]) => name);
      const before = added;
      for (const name of names) addSource(name, best, author);
      if (added === before) followCandidates.push({ uid, best, author });
    }
    if (added === 0 && slots > 0) {
      for (const { uid, best, author } of followCandidates) {
        const followed = await attempt(`${author}关注贴吧`, () =>
          this.read.followed({ uid, page: 1 }, send),
        );
        if (
          followed?.visibility === "public" &&
          followed.forums.some((forum) => addSource(forum.name, best, author))
        )
          break;
      }
    }

    signal.throwIfAborted();
    const tracked = observations.filter((post) => post.potential);
    state.posts = [
      ...tracked,
      ...observations
        .filter((post) => !post.potential)
        .sort((a, b) => b.checkedAt - a.checkedAt)
        .slice(0, Math.max(0, 1500 - tracked.length)),
    ];
    state.sources = [...sources.values()];
    state.authors = Object.fromEntries(
      Object.entries(state.authors)
        .filter(([, at]) => now - at <= 7 * 24 * discoveryInterval)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 300),
    );
    state.lastRun = {
      at: this.now(),
      forums: readForums,
      authors: probed,
      added,
      warnings: [...new Set(warnings)].slice(0, 10),
    };
    this.db.transaction(() => {
      savePotentialPosts(
        this.db,
        observations.flatMap((post) => {
          if (!post.potential || !seen.has(post.id)) return [];
          const {
            id,
            title,
            url,
            forum,
            author,
            publishedAt,
            views,
            checkedAt,
            path,
          } = post;
          return [
            {
              id,
              title,
              url,
              forum,
              author,
              publishedAt,
              views,
              checkedAt,
              path,
              replies: post.interactions?.replies ?? null,
              likes: post.interactions?.likes ?? null,
              shares: post.interactions?.shares ?? null,
              first: post.potential,
              confirmedAt: meetsDiscoveryRule(post.growth, ranks.get(post.id))
                ? rankedAt
                : null,
            },
          ];
        }),
      );
      this.db.setSetting(storageKey, state);
    });
  }
}

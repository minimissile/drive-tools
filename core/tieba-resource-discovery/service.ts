import type { TiebaAnalysisThread } from "../../shared/tieba-analysis";
import type {
  TiebaDiscoveryCandidate,
  TiebaDiscoveryLog,
  TiebaDiscoveryPotentialEvidence,
  TiebaDiscoveryRules,
  TiebaDiscoveryTrafficPost,
  TiebaDiscoverySnapshot,
  TiebaDiscoverySource,
} from "../../shared/tieba-resource-discovery";
import {
  defaultTiebaDiscoveryRules,
  tiebaDiscoveryCadenceMinutes,
  tiebaDiscoveryRulesSchema,
} from "../../shared/tieba-resource-discovery";
import { tiebaForumNameSchema } from "../../shared/tieba-forums";
import type { Database } from "../database";
import { AppError } from "../errors";
import {
  potentialCount,
  potentialPage,
  savePotentialPosts,
  saveTrafficPosts,
  trafficCount,
  trafficMembership,
  trafficPage,
} from "./archive";
import {
  queryTiebaAnalysis,
  queryTiebaAnalysisFollowedForums,
  queryTiebaAnalysisForumPosts,
  readTiebaDiscoveryViews,
} from "../tieba/analysis";
import {
  discoveryInterval,
  forumExposure,
  groupResources,
  meetsDiscoveryRule,
  minReadingGap,
  observeViews,
  potentialSignals,
  resourceRanks,
  trafficLookback,
  type ViewState,
} from "./rules";

const storageKey = "tieba.resourceDiscovery.v1";
const autoKey = "tieba.resourceDiscovery.auto";
const rulesKey = "tieba.resourceDiscovery.rules";
const logsKey = "tieba.resourceDiscovery.logs";
const additionalForumsPerScan = 3;
const minute = 60_000;
const retainedLogs = 40;
type ScanMode = keyof typeof tiebaDiscoveryCadenceMinutes;
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
  historyPage?: number;
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
  lastSurveyAt?: number;
  surveyAt?: number;
  expandAt?: number;
  rounds?: number;
};

const awaitingScan = (source: StoredSource) =>
  source.status !== "seed" &&
  source.lastAttemptAt == null &&
  source.scannedAt === null;

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
  within: number,
) => {
  const time = Date.parse(post.publishedAt ?? "");
  return time <= now && now - time <= within;
};

function candidates(posts: Post[], now: number, lookback: number) {
  const ranks = resourceRanks(posts, now, lookback);
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
  private nextMode?: ScanMode;
  private scanningForum?: string;
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
    private random = Math.random,
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

  private rules() {
    const result = tiebaDiscoveryRulesSchema.safeParse(
      this.db.setting(rulesKey, defaultTiebaDiscoveryRules),
    );
    return result.success ? result.data : defaultTiebaDiscoveryRules;
  }

  private logs() {
    return this.db.setting<TiebaDiscoveryLog[]>(logsKey, []);
  }

  private log(message: string) {
    const logs = this.logs();
    logs.push({ id: (logs.at(-1)?.id ?? 0) + 1, at: this.now(), message });
    this.db.setSetting(logsKey, logs.slice(-retainedLogs));
  }

  snapshot(): TiebaDiscoverySnapshot {
    const state = this.stored(),
      now = this.now();
    const rules = this.rules();
    const lookback = rules.lookbackHours * discoveryInterval;
    return {
      seeds: state.seeds,
      sources: state.sources,
      busy: this.isBusy,
      auto: this.auto,
      nextAt: this.nextAt,
      nextMode: this.nextMode,
      scanningForum: this.scanningForum,
      queuedForums: state.sources.filter(awaitingScan).length,
      rounds: state.rounds ?? 0,
      logs: this.logs(),
      potentialCount: potentialCount(this.db),
      trafficCount: trafficCount(this.db),
      rules,
      lastRun: state.lastRun,
      ...candidates(
        state.posts.filter((post) => recent(post, now, lookback)),
        now,
        lookback,
      ),
    };
  }

  potential(page: number) {
    return potentialPage(this.db, page, this.now(), this.rules());
  }

  traffic(page: number) {
    return trafficPage(this.db, page);
  }

  saveRules(rules: TiebaDiscoveryRules) {
    this.db.setSetting(rulesKey, rules);
    this.changed();
    return this.snapshot();
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
        historyPage: old.get(key(name))?.historyPage,
      })),
      ...state.sources.filter(
        (source) =>
          source.status !== "seed" &&
          !state.seeds.some((name) => key(name) === key(source.name)),
      ),
    ];
    this.db.setSetting(storageKey, state);
    if (this.auto) this.scheduleNext();
    this.changed();
    return this.snapshot();
  }

  setAuto(enabled: boolean) {
    const changed = this.auto !== enabled;
    this.db.setSetting(autoKey, enabled);
    this.auto = enabled;
    if (changed) this.log(enabled ? "已开启持续发现" : "已关闭持续发现");
    if (!enabled) this.clearTimer();
    else if (!this.isBusy) this.scheduleNext(changed);
    this.changed();
    return this.snapshot();
  }

  scan(mode: ScanMode = "survey") {
    if (this.isBusy) return this.snapshot();
    this.clearTimer();
    const controller = new AbortController();
    this.active = controller;
    this.log(mode === "expand" ? "开始扩散扫描" : "开始巡查");
    void this.run(controller.signal, mode)
      .catch((error: unknown) => {
        if (this.closed) return;
        const state = this.stored();
        this.finishRun(state, {
          at: this.now(),
          forums: 0,
          authors: 0,
          added: 0,
          mode,
          warnings: [
            error instanceof Error
              ? error.message.slice(0, 160)
              : "扫描未完成，请重试。",
          ],
        });
        this.db.setSetting(storageKey, state);
        this.log("本批扫描未完成，详情见读取提示");
      })
      .finally(() => {
        this.active = undefined;
        this.scanningForum = undefined;
        if (this.closed) return;
        if (this.auto) this.scheduleNext(true);
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
    this.nextMode = undefined;
  }

  private schedule(at: number, mode: ScanMode) {
    this.clearTimer();
    const now = this.now();
    this.nextAt = Math.max(at, now);
    this.nextMode = mode;
    this.timer = setTimeout(() => {
      if (this.auto && !this.closed) this.scan(mode);
    }, this.nextAt - now);
    this.timer.unref();
  }

  private randomDelay(mode: ScanMode) {
    const { min, max } = tiebaDiscoveryCadenceMinutes[mode];
    return Math.round((min + this.random() * (max - min)) * minute);
  }

  private plan(state: Stored) {
    const last = state.lastRun?.at;
    if (last === undefined) return false;
    const surveyAt =
      state.surveyAt ??
      (state.lastSurveyAt ?? last) + this.randomDelay("survey");
    const expandAt = state.sources.some(awaitingScan)
      ? (state.expandAt ?? last + this.randomDelay("expand"))
      : undefined;
    const changed = surveyAt !== state.surveyAt || expandAt !== state.expandAt;
    state.surveyAt = surveyAt;
    state.expandAt = expandAt;
    return changed;
  }

  private finishRun(state: Stored, run: NonNullable<Stored["lastRun"]>) {
    if (run.mode === "survey") {
      state.lastSurveyAt = run.at;
      state.surveyAt = undefined;
    } else {
      state.lastSurveyAt ??= state.lastRun?.at;
    }
    state.expandAt = undefined;
    state.lastRun = run;
    state.rounds = (state.rounds ?? 0) + 1;
    this.plan(state);
  }

  private scheduleNext(logWait = false) {
    const state = this.stored();
    const now = this.now();
    if (this.plan(state)) this.db.setSetting(storageKey, state);
    const surveyAt = state.surveyAt ?? now;
    const expandAt = state.expandAt ?? Infinity;
    const mode = expandAt < surveyAt ? "expand" : "survey";
    const at = Math.min(surveyAt, expandAt);
    const delay = Math.max(0, at - now);
    this.schedule(at, mode);
    if (logWait && delay > 0) {
      this.log(
        `${mode === "expand" ? "下一批扩散" : "下次巡查"}约 ${Math.ceil(delay / minute)} 分钟后开始`,
      );
    }
  }

  private async run(signal: AbortSignal, mode: ScanMode) {
    const state = this.stored(),
      now = this.now();
    const rules = this.rules();
    const lookback = rules.lookbackHours * discoveryInterval;
    const monitored = (post: Post) =>
      (post.potential?.score ?? -1) >= rules.potentialThreshold;
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
        .filter((post) => recent(post, now, lookback))
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
    const selected =
      mode === "expand"
        ? [...sources.values()]
            .filter(awaitingScan)
            .slice(0, additionalForumsPerScan)
        : [
            ...[...sources.values()].filter(
              (source) => source.status === "seed",
            ),
            ...(revisit ? [revisit] : []),
            ...dueSources
              .filter((source) => source !== revisit)
              .slice(0, additionalForumsPerScan - Number(!!revisit)),
          ];
    const highTraffic = new Map<string, TiebaDiscoveryTrafficPost>();
    const highTrafficAuthors: Post[] = [];
    const archived = trafficMembership(this.db);
    const archiveReading = ({
      id,
      title,
      url,
      forum,
      author,
      publishedAt,
      views,
      checkedAt,
      path,
      interactions,
    }: Post) => ({
      id,
      title,
      url,
      forum,
      author,
      publishedAt,
      views,
      checkedAt,
      path,
      replies: interactions?.replies ?? null,
      likes: interactions?.likes ?? null,
      shares: interactions?.shares ?? null,
    });
    const record = (post: Post, views: number | null) => {
      const at = this.now();
      seen.add(post.id);
      if (views !== null && views >= rules.trafficThreshold) {
        highTraffic.set(post.id, {
          ...archiveReading(post),
          views,
          checkedAt: at,
          fromPotential: !!post.potential,
        });
        if (post.uid) highTrafficAuthors.push({ ...post, views });
        posts.delete(post.id);
        return;
      }
      const reading = observeViews(post, at, views);
      if (reading.growth?.to !== post.growth?.to) advanced.add(post.id);
      posts.set(post.id, { ...post, ...reading, views, checkedAt: at });
    };
    const readPage = async (source: StoredSource, page: number) => {
      const result = await attempt(source.name, () =>
        this.read.forum({ name: source.name, page }, send, true),
      );
      if (!result) return;
      for (const item of result.threads) {
        if (!item.publishedAt || seen.has(item.id) || archived(item.id))
          continue;
        const fresh = recent(item, this.now(), lookback);
        if (
          !fresh &&
          ((item.views ?? 0) < rules.trafficThreshold ||
            !recent(item, this.now(), trafficLookback))
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
            ...new Set([...(old?.keys ?? []), ...(item.resource?.keys ?? [])]),
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
      return result;
    };
    let readForums = 0;
    for (const source of selected) {
      this.scanningForum = source.name;
      this.log(`正在扫描「${source.name}」`);
      this.changed();
      source.lastAttemptAt = this.now();
      let historyStart: number | undefined;
      for (let page = 1; page <= 3; page++) {
        const result = await readPage(source, page);
        if (!result) {
          if (page === 1) this.log(`「${source.name}」暂未读取到，继续下一项`);
          break;
        }
        if (page === 1) {
          readForums++;
          source.scannedAt = this.now();
          source.exposure = forumExposure(result.threads, source.scannedAt);
        }
        historyStart = result.hasMore ? page + 1 : undefined;
        if (
          !historyStart ||
          result.threads.every(
            (post) => post.publishedAt && !recent(post, this.now(), lookback),
          )
        )
          break;
      }
      if (historyStart !== undefined) {
        const page = Math.max(historyStart, source.historyPage ?? historyStart);
        const result = await readPage(source, page);
        source.historyPage =
          result?.hasMore &&
          result.threads.some((post) =>
            recent(post, this.now(), trafficLookback),
          )
            ? page + 1
            : undefined;
      }
    }

    if (this.scanningForum) {
      this.scanningForum = undefined;
      this.log("正在核对帖子和作者");
      this.changed();
    }

    const due = [...posts.values()]
      .filter(
        (post) =>
          !seen.has(post.id) &&
          ((mode === "survey" && monitored(post)) ||
            (missingListViews.has(post.id) && !post.baseline)) &&
          (!before.has(post.id) ||
            this.now() - post.checkedAt >= minReadingGap),
      )
      .sort(
        (a, b) =>
          Number(monitored(b)) - Number(monitored(a)) ||
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
      rules,
    );
    const ranks = resourceRanks(observations, rankedAt, lookback);
    for (const post of observations) {
      if (!monitored(post))
        post.potential = firstSignals.get(post.id) ?? post.potential;
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
    for (const post of [...observations, ...highTrafficAuthors]) {
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
        const best = items.sort(
          (a, b) =>
            Number(highTraffic.has(b.id)) - Number(highTraffic.has(a.id)) ||
            orderPosts(a, b),
        )[0];
        const established = highTraffic.has(best.id);
        return established || best.streak || monitored(best) || distinct >= 2
          ? [{ uid, best, distinct, established }]
          : [];
      })
      .sort(
        (a, b) =>
          Number(b.established) - Number(a.established) ||
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
    function addSource(
      candidate: string,
      best: Post,
      author: string,
      uid: string,
      reason: "posted" | "followed",
    ) {
      const parsed = tiebaForumNameSchema.safeParse(candidate);
      if (!parsed.success || sources.has(key(parsed.data))) return false;
      const name = parsed.data;
      sources.set(key(name), {
        name,
        status: "watch",
        scannedAt: null,
        addedAt: now,
        path: [...best.path, author, name],
        via: { forum: best.forum, author, uid, reason },
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
      for (const name of names) addSource(name, best, author, uid, "posted");
      if (added === before) followCandidates.push({ uid, best, author });
    }
    if (added === 0 && slots > 0) {
      for (const { uid, best, author } of followCandidates) {
        const followed = await attempt(`${author}关注贴吧`, () =>
          this.read.followed({ uid, page: 1 }, send),
        );
        if (
          followed?.visibility === "public" &&
          followed.forums.some((forum) =>
            addSource(forum.name, best, author, uid, "followed"),
          )
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
    this.finishRun(state, {
      at: this.now(),
      forums: readForums,
      authors: probed,
      added,
      mode,
      warnings: [...new Set(warnings)].slice(0, 10),
    });
    this.db.transaction(() => {
      saveTrafficPosts(this.db, highTraffic);
      savePotentialPosts(
        this.db,
        observations.flatMap((post) => {
          if (!post.potential || !seen.has(post.id)) return [];
          return [
            {
              ...archiveReading(post),
              first: post.potential,
              score: post.potential.score,
              confirmedAt: meetsDiscoveryRule(post.growth, ranks.get(post.id))
                ? rankedAt
                : null,
            },
          ];
        }),
      );
      this.db.setSetting(storageKey, state);
    });
    this.log(
      `本批结束，读到 ${readForums} 个贴吧，查看 ${probed} 位作者，发现 ${added} 个新贴吧`,
    );
  }
}

import { setTimeout as wait } from "node:timers/promises";
import type { TiebaAnalysisThread } from "../../shared/tieba-analysis";
import type {
  TiebaDiscoveryCandidate,
  TiebaDiscoveryLog,
  TiebaDiscoveryPendingPage,
  TiebaDiscoveryReadingPost,
  TiebaDiscoveryPotentialEvidence,
  TiebaDiscoveryRules,
  TiebaDiscoveryTrafficPost,
  TiebaDiscoverySnapshot,
  TiebaDiscoverySource,
  TiebaOldTrafficView,
  TiebaOldResourceFilter,
  TiebaTrafficPostsView,
  TiebaDiscoveryRefresh,
  TiebaDiscoveryImportKind,
} from "../../shared/tieba-resource-discovery";
import {
  defaultTiebaDiscoveryRules,
  oldTrafficMinimumAgeDays,
  tiebaDiscoveryCadenceMinutes,
  tiebaDiscoveryLogLimit,
  tiebaDiscoveryPageSize,
  tiebaDiscoveryRulesSchema,
} from "../../shared/tieba-resource-discovery";
import { tiebaForumNameSchema } from "../../shared/tieba-forums";
import type { Database } from "../database";
import { AppError } from "../errors";
import {
  potentialCount,
  potentialPage,
  refreshPotentialPost,
  refreshTrafficPost,
  savePotentialPosts,
  saveTrafficPosts,
  trafficCount,
  trafficMembership,
  trafficPage,
  visibleHighTraffic,
} from "./archive";
import {
  queryTiebaAnalysis,
  queryTiebaAnalysisFollowedForums,
  queryTiebaAnalysisForumPosts,
  readTiebaDiscoveryViews,
  readTiebaDiscoveryDetails,
  readTiebaDiscoveryThread,
  readTiebaOldResource,
} from "../tieba/analysis";
import {
  awaitsMaturePotentialReading,
  discoveryInterval,
  forumExposure,
  groupResources,
  inRecentGrowthWindow,
  meetsDiscoveryRule,
  minReadingGap,
  observePostViews,
  pendingObservationDueAt,
  potentialSignals,
  qualifyingHourlyViews,
  resourceRanks,
  trafficLookback,
  type ViewState,
} from "./rules";
import {
  dueOldTraffic,
  oldTrafficAge,
  oldTrafficPage,
  oldTrafficSummary,
  trafficPostsPage,
  passesOldTrafficScreen,
  refreshOldTrafficReading,
  saveOldTraffic,
  type OldTrafficReading,
} from "./old-traffic";
import {
  admitOldResource,
  isOldResource,
  nextOldResourceCheck,
  pendingOldResourceCount,
  queueOldResource,
  dueOldResourceChecks,
  oldResourceEvidence,
  saveOldResource,
} from "./old-resource";
import { tiebaDiscoveryStateKey as storageKey } from "./migration";
import { tiebaThreadUrl } from "../tieba/participation-page";
const autoKey = "tieba.resourceDiscovery.auto";
const rulesKey = "tieba.resourceDiscovery.rules";
const logsKey = "tieba.resourceDiscovery.logs";
const additionalForumsPerScan = 3;
const recentPagesPerForum = 3;
const recentGrowthPageSize = 50;
const recentGrowthProbesPerRun = 12;
const recentGrowthDetailReadsPerSurvey = 20;
const historyKey = "tieba.resourceDiscovery.history";
const historyRetryGap = 5 * 60_000;
const historyRescanGap = 7 * 24 * discoveryInterval;
const oldDetailReadsPerSurvey = 12;
const oldResourceRetryDelay = 6 * discoveryInterval;
const minute = 60_000;
type ScanMode = keyof typeof tiebaDiscoveryCadenceMinutes;
const key = (name: string) => name.normalize("NFKC").trim().toLowerCase();
const seed = (name: string): TiebaDiscoverySource => ({
  name,
  status: "seed",
  scannedAt: null,
});

type Post = Omit<TiebaDiscoveryCandidate, "rank" | "copies"> &
  ViewState & {
    uid: string | null;
    keys: string[];
    checkedAt: number;
    resource?: TiebaDiscoveryReadingPost["resource"];
    interactions?: Pick<TiebaAnalysisThread, "replies" | "likes" | "shares">;
    potential?: TiebaDiscoveryPotentialEvidence;
    pendingSince?: number;
    manualGrowthWatch?: boolean;
    oldHandoffAttemptAt?: number;
  };
type StoredSource = TiebaDiscoverySource & {
  highTrafficPage?: number;
  recentGrowthPage?: number;
  recentGrowthSampleAt?: number;
  lastUsefulAt?: number;
  lastAttemptAt?: number;
};
type HistoryCursor = {
  name: string;
  nextPage: number;
  retryAt?: number;
  completedAt?: number;
  lastPageIds?: string;
  authorsChecked?: number;
};
type HistoryScan = {
  screen: string;
  forums: HistoryCursor[];
  authors: Record<string, number>;
  revision: number;
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
  history?: Record<string, { name: string; nextPage?: number }>;
};

const awaitingScan = (source: StoredSource) =>
  source.status !== "seed" &&
  source.lastAttemptAt == null &&
  source.scannedAt === null;

const orderPosts = (a: Post, b: Post) =>
  b.streak - a.streak ||
  Number(!!b.potential) - Number(!!a.potential) ||
  Number(b.pendingSince !== undefined) - Number(a.pendingSince !== undefined) ||
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

function postReading(post: Post): TiebaDiscoveryReadingPost {
  const { id, title, url, forum, author, publishedAt, views, checkedAt, interactions } = post;
  return {
    id, title, url, forum, author, publishedAt, views, checkedAt,
    ...(post.resource ? { resource: post.resource } : {}),
    replies: interactions?.replies ?? null,
    likes: interactions?.likes ?? null,
    shares: interactions?.shares ?? null,
  };
}

function pendingPosts(state: Stored, now: number, rules: TiebaDiscoveryRules) {
  return state.posts.filter((post): post is Post & { pendingSince: number } =>
    post.pendingSince !== undefined &&
    recent(post, now, rules.lookbackHours * discoveryInterval),
  );
}

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
      ...(post.resource ? { resource: post.resource } : {}),
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
  oldForum?: typeof queryTiebaAnalysisForumPosts;
  user: typeof queryTiebaAnalysis;
  followed: typeof queryTiebaAnalysisFollowedForums;
  views: typeof readTiebaDiscoveryViews;
  oldResource?: typeof readTiebaOldResource;
  details?: typeof readTiebaDiscoveryDetails;
  thread?: typeof readTiebaDiscoveryThread;
}

const readers: TiebaDiscoveryReaders = {
  forum: queryTiebaAnalysisForumPosts,
  oldForum: queryTiebaAnalysisForumPosts,
  user: queryTiebaAnalysis,
  followed: queryTiebaAnalysisFollowedForums,
  views: readTiebaDiscoveryViews,
  oldResource: readTiebaOldResource,
  details: readTiebaDiscoveryDetails,
};

export class TiebaResourceDiscovery {
  private auto: boolean;
  private nextAt: number | null = null;
  private nextMode?: ScanMode;
  private scanningForum?: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: AbortController | undefined;
  private closed = false;
  private historyActive?: AbortController;
  private resourceActive?: AbortController;
  private refreshActive?: AbortController;
  private resourceTimer?: ReturnType<typeof setTimeout>;
  private resourceTimerAt?: number;
  private resourceSweep = false;
  private historyTimer?: ReturnType<typeof setTimeout>;
  private historyCooldown = 0;
  private historyPage?: { forum: string; page: number };
  private historyProgress?: TiebaDiscoverySnapshot["historyProgress"];

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
    this.historyProgress = this.describeHistory(this.history());
    if (this.auto) {
      this.scheduleHistory();
      this.scheduleOldResources();
      if (dueOldTraffic(this.db, this.now(), 1, this.rules().oldResourceCheckEnabled).length) this.schedule(this.now(), "survey");
      else this.scheduleNext();
    }
  }

  get isBusy() {
    return !!this.active || !!this.historyActive || !!this.refreshActive;
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
    const saved = this.db.setting<unknown>(rulesKey, null);
    const fields = saved && typeof saved === "object" ? saved : {};
    const result = tiebaDiscoveryRulesSchema.safeParse({
      minHourlyViews: defaultTiebaDiscoveryRules.minHourlyViews,
      ...fields,
    });
    return result.success ? result.data : defaultTiebaDiscoveryRules;
  }

  private logs() {
    return this.db.setting<TiebaDiscoveryLog[]>(logsKey, []).slice(-tiebaDiscoveryLogLimit);
  }

  private log(message: string) {
    const logs = this.logs();
    logs.push({ id: (logs.at(-1)?.id ?? 0) + 1, at: this.now(), message });
    this.db.setSetting(logsKey, logs.slice(-tiebaDiscoveryLogLimit));
  }

  snapshot(): TiebaDiscoverySnapshot {
    const state = this.stored(),
      now = this.now();
    const rules = this.rules();
    const lookback = rules.lookbackHours * discoveryInterval;
    return {
      seeds: state.seeds,
      sources: state.sources,
      busy: !!this.active,
      auto: this.auto,
      nextAt: this.nextAt,
      nextMode: this.nextMode,
      scanningForum: this.scanningForum,
      queuedForums: state.sources.filter(awaitingScan).length,
      rounds: state.rounds ?? 0,
      logs: this.logs(),
      potentialCount: potentialCount(this.db, rules),
      pendingCount: pendingPosts(state, now, rules).length,
      trafficCount: trafficCount(this.db, rules),
      oldTraffic: oldTrafficSummary(this.db, rules),
      oldResourceReady: true,
      oldResourceAdmission: true,
      oldResourcePending: rules.oldResourceCheckEnabled ? pendingOldResourceCount(this.db) : 0,
      historyProgress: this.historyProgress,
      rules,
      lastRun: state.lastRun,
      ...candidates(
        state.posts.filter((post) => recent(post, now, lookback)),
        now,
        lookback,
      ),
    };
  }

  potential(page: number, grew = false) {
    return potentialPage(this.db, page, this.now(), this.rules(), grew);
  }

  pending(requestedPage: number): TiebaDiscoveryPendingPage {
    const rules = this.rules();
    const posts = pendingPosts(this.stored(), this.now(), rules).sort(
      (a, b) => a.publishedAt.localeCompare(b.publishedAt) || b.pendingSince - a.pendingSince,
    );
    const size = tiebaDiscoveryPageSize;
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(posts.length / size)));
    const items = posts.slice((page - 1) * size, page * size).map((post) => ({
      ...postReading(post),
      queuedAt: post.pendingSince,
      dueAt: pendingObservationDueAt(post, rules),
    }));
    return { page, total: posts.length, items };
  }

  traffic(page: number) {
    return trafficPage(this.db, page, this.rules());
  }

  oldTraffic(page: number, view: TiebaOldTrafficView = "qualified", resource: TiebaOldResourceFilter = "all") {
    return oldTrafficPage(this.db, page, this.rules(), view, resource);
  }

  trafficPosts(page: number, view: TiebaTrafficPostsView, resource: TiebaOldResourceFilter) {
    return trafficPostsPage(this.db, page, this.rules(), view, resource);
  }

  async importPost(id: string): Promise<{
    kind: TiebaDiscoveryImportKind;
    already: boolean;
    measuredDailyGrowth?: number;
  }> {
    if (this.closed || this.active || this.refreshActive)
      throw new AppError("TIEBA_DISCOVERY_BUSY", "请等当前巡查或刷新结束后再试。");
    const controller = new AbortController();
    this.refreshActive = controller;
    const { signal } = controller;
    try {
      const send: typeof fetch = (input, options) => fetch(input, {
        ...options,
        signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
      });
      const read = this.read.thread ?? readTiebaDiscoveryThread;
      const { views, publishedAt, uid, ...metadata } = await read(id, send);
      signal.throwIfAborted();
      const at = this.now();
      if (views === null || !metadata.forum || !publishedAt ||
          !(Date.parse(publishedAt) <= at))
        throw new AppError("TIEBA_DISCOVERY_INCOMPLETE", "未读取到有效的浏览量、吧名或发布时间，暂时无法入库。");

      const thread = { ...metadata, id, url: tiebaThreadUrl(id), publishedAt };
      const old = { post: { ...thread, authorId: uid }, at, views };
      const oldResult = oldTrafficAge(publishedAt, at) >= oldTrafficMinimumAgeDays
        ? await this.importOldTraffic(old, send, signal)
        : undefined;
      if (oldResult === "saved" || oldResult === "existing")
        return { kind: "oldTraffic", already: oldResult === "existing" };

      const rules = this.rules();
      const state = this.stored();
      const existing = state.posts.find((post) => post.id === id);
      const reading = { ...thread, views, checkedAt: at, resource: existing?.resource };
      if (trafficMembership(this.db)(id)) return { kind: "traffic", already: true };
      const archivedPotential = this.hasRefreshPost("potential", id);
      if (views >= rules.trafficThreshold) {
        this.db.transaction(() => {
          saveTrafficPosts(this.db, new Map([[id, { ...reading, fromPotential: archivedPotential }]]), rules);
          if (existing) {
            state.posts = state.posts.filter((post) => post.id !== id);
            this.db.setSetting(storageKey, state);
          }
        });
        return { kind: "traffic", already: false };
      }
      if (archivedPotential && !inRecentGrowthWindow(reading, at, rules))
        return { kind: "potential", already: true };

      const viewState = observePostViews({
        publishedAt,
        baseline: existing?.baseline ?? null,
        growth: existing?.growth ?? null,
        streak: existing?.streak ?? 0,
      }, at, views, rules);
      const potential = potentialSignals([{ ...reading, keys: [], growth: viewState.growth }], at, rules).get(id);
      const growthWatch = inRecentGrowthWindow(reading, at, rules);
      if (potential || growthWatch) {
        return this.db.transaction(() => {
          const stage = potential?.stage ?? (archivedPotential ? "potential" : "growthWatch");
          const post: Post = {
            ...viewState,
            ...reading,
            uid,
            keys: existing?.keys ?? [],
            linked: existing?.linked ?? false,
            interactions: metadata,
            pendingSince: stage === "pending" ? existing?.pendingSince ?? at : undefined,
            manualGrowthWatch: (growthWatch && !potential?.recentGrowth) || undefined,
            potential: existing?.potential,
          };
          if (potential?.stage === "potential") {
            const { stage: _stage, ...evidence } = potential;
            post.potential ??= evidence;
          }
          state.posts = [...state.posts.filter((item) => item.id !== id), post];
          this.db.setSetting(storageKey, state);
          if (post.potential)
            savePotentialPosts(this.db, [{
              ...reading, first: post.potential, confirmedAt: potential?.recentGrowth ? at : null,
              ...(potential?.recentGrowth ? { confirmedGrowth: potential.recentGrowth } : {}),
            }]);
          return {
            kind: stage,
            already: archivedPotential || (stage === "pending" && existing?.pendingSince !== undefined),
            ...(stage === "growthWatch" && viewState.growth?.to === at
              ? { measuredDailyGrowth: viewState.growth.hourly * 24 }
              : {}),
          };
        });
      }
      if (oldResult === "no-resource")
        throw new AppError("TIEBA_DISCOVERY_NO_RESOURCE", "老帖的标题、正文和近期回复未通过资源校验，也未达到高流量门槛。");
      throw new AppError("TIEBA_DISCOVERY_BELOW_THRESHOLD", "这篇帖子暂未达到待观察、潜力帖、高流量或老帖流量的入库门槛。");
    } finally {
      this.refreshActive = undefined;
      if (!this.closed) {
        if (this.auto && !this.active) this.scheduleNext();
        this.changed();
      }
    }
  }

  private async importOldTraffic(reading: OldTrafficReading, send: typeof fetch, signal: AbortSignal) {
    const { id } = reading.post;
    const oldStatus = (rules: TiebaDiscoveryRules) => {
      if (this.db.get("SELECT 1 FROM tieba_discovery_old_resource_deleted WHERE thread_id = ?", id))
        throw new AppError("TIEBA_DISCOVERY_DELETED", "这篇老帖已被手动删除，已保留排除记录。");
      return !!this.db.get(
        `SELECT 1 FROM tieba_discovery_old_traffic t
         LEFT JOIN tieba_discovery_old_resource r USING (thread_id)
         WHERE t.thread_id = ? AND t.last_at IS NOT NULL AND (? = 0 OR r.admitted = 1)`,
        id, Number(rules.oldResourceCheckEnabled),
      );
    };
    const rules = this.rules();
    if (oldStatus(rules)) {
      if (reading.views !== null)
        refreshOldTrafficReading(this.db, id, reading.at, reading.views, rules);
      return "existing";
    }
    if (!passesOldTrafficScreen(reading, rules)) return "below";

    const check = this.read.oldResource ?? readTiebaOldResource;
    const resource = rules.oldResourceCheckEnabled ? await check(id, send) : undefined;
    signal.throwIfAborted();
    return this.db.transaction(() => {
      const latest = this.rules();
      if (oldStatus(latest)) return "existing";
      if (!passesOldTrafficScreen(reading, latest)) return "below";
      if (latest.oldResourceCheckEnabled) {
        if (!resource)
          throw new AppError("TIEBA_DISCOVERY_RULES_CHANGED", "发现规则已更新，请重新入库。");
        if (!isOldResource(resource)) return "no-resource";
      }
      saveOldTraffic(this.db, [reading], [], this.now(), latest, latest.oldResourceCheckEnabled ? resource : undefined);
      this.db.db.prepare("DELETE FROM tieba_discovery_old_resource_queue WHERE thread_id = ?").run(id);
      return "saved";
    });
  }

  async refresh(input: TiebaDiscoveryRefresh) {
    if (this.closed || this.active || this.refreshActive)
      throw new AppError("TIEBA_DISCOVERY_BUSY", "请等当前巡查或刷新结束后再试。");
    const controller = new AbortController();
    this.refreshActive = controller;
    const { signal } = controller;
    const send: typeof fetch = (url, options) => fetch(url, {
      ...options,
      signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
    });
    let updated = 0;
    let failed = 0;
    try {
      const targets = input.kind === "sources" ? input.names : input.ids;
      for (const id of new Set(targets)) {
        try {
          signal.throwIfAborted();
          const at = this.now();
          if (input.kind === "sources") {
            if (!this.stored().sources.some(({ name }) => key(name) === key(id))) {
              failed++;
              continue;
            }
            const page = await this.read.forum({ name: id, page: 1 }, send);
            signal.throwIfAborted();
            const state = this.stored();
            const source = state.sources.find(({ name }) => key(name) === key(id));
            if (!source) {
              failed++;
              continue;
            }
            source.exposure = forumExposure(page.threads, at);
            this.db.setSetting(storageKey, state);
            updated++;
            continue;
          }
          const kind = input.kind === "trafficPosts" ? this.trafficRefreshKind(id) : input.kind;
          if (!kind || !this.hasRefreshPost(kind, id)) {
            failed++;
            continue;
          }
          const read = this.read.details ?? readTiebaDiscoveryDetails;
          const result = await read(id, send);
          signal.throwIfAborted();
          const saved = this.db.transaction(() => this.saveRefreshedPost(kind, id, at, result));
          if (saved && result.views !== null) updated++;
          else failed++;
        } catch (error) {
          signal.throwIfAborted();
          failed++;
        }
      }
      return { updated, failed };
    } finally {
      this.refreshActive = undefined;
      if (!this.closed) {
        if (this.auto && !this.active) this.scheduleNext();
        this.changed();
      }
    }
  }

  private trafficRefreshKind(id: string) {
    const { oldResourceCheckEnabled } = this.rules();
    if (this.db.get(`
      SELECT 1 FROM tieba_discovery_old_traffic t
      ${oldResourceCheckEnabled ? "JOIN tieba_discovery_old_resource r USING (thread_id)" : ""}
      WHERE t.thread_id = ? AND t.last_at IS NOT NULL ${oldResourceCheckEnabled ? "AND r.admitted = 1" : ""}
    `, id)) return "oldTraffic";
    if (this.db.get(`
      SELECT 1 FROM tieba_discovery_traffic t
      WHERE t.thread_id = ? AND ${visibleHighTraffic("t.thread_id", oldResourceCheckEnabled)}
    `, id)) return "traffic";
  }

  private hasRefreshPost(kind: Exclude<TiebaDiscoveryRefresh["kind"], "sources" | "trafficPosts">, id: string) {
    switch (kind) {
      case "oldTraffic":
        return !!this.db.get("SELECT 1 FROM tieba_discovery_old_traffic WHERE thread_id = ? AND last_at IS NOT NULL", id);
      case "traffic":
        return trafficMembership(this.db)(id);
      case "potential":
        return !!this.db.get("SELECT 1 FROM tieba_discovery_potential WHERE thread_id = ?", id) && !trafficMembership(this.db)(id);
      case "pending":
        return pendingPosts(this.stored(), this.now(), this.rules()).some((post) => post.id === id);
      case "trending":
        return this.snapshot().trending.some((post) => post.id === id);
    }
  }

  private saveRefreshedPost(
    kind: Exclude<TiebaDiscoveryRefresh["kind"], "sources" | "trafficPosts">,
    id: string,
    at: number,
    { views, resource }: Awaited<ReturnType<typeof readTiebaDiscoveryDetails>>,
  ) {
    const rules = this.rules();
    if (kind === "oldTraffic") {
      if (!this.hasRefreshPost(kind, id)) return false;
      if (views !== null) refreshOldTrafficReading(this.db, id, at, views, rules);
      if (saveOldResource(this.db, id, resource, at, true)) {
        this.db.db.prepare("DELETE FROM tieba_discovery_old_resource_queue WHERE thread_id = ?").run(id);
        // A refresh updates the evidence on an existing record. Admission is
        // evaluated on discovery, so the refreshed row stays reviewable.
      }
      return true;
    }
    if (kind === "traffic") return refreshTrafficPost(this.db, id, views, at, resource);
    const archived = refreshPotentialPost(this.db, id, views, at, resource, rules);
    const state = this.stored();
    const post = state.posts.find((item) => item.id === id);
    if (!post || post.checkedAt > at) return archived;
    post.resource = resource;
    post.linked = resource.linkSources.length > 0;
    if (views !== null) {
      const reading = observePostViews(post, at, views, rules);
      Object.assign(post, reading, { views, checkedAt: at });
    }
    this.db.setSetting(storageKey, state);
    return true;
  }

  private stageOldResources(readings: Iterable<OldTrafficReading>, rules: TiebaDiscoveryRules) {
    const get = this.db.db.prepare(
      "SELECT admitted, checked_at FROM tieba_discovery_old_resource WHERE thread_id = ?",
    );
    const deleted = this.db.db.prepare(
      "SELECT 1 FROM tieba_discovery_old_resource_deleted WHERE thread_id = ?",
    );
    const hasBaseline = this.db.db.prepare(
      "SELECT 1 FROM tieba_discovery_old_traffic WHERE thread_id = ? AND last_at IS NOT NULL",
    );
    const clearQueued = this.db.db.prepare(
      "DELETE FROM tieba_discovery_old_resource_queue WHERE thread_id = ?",
    );
    for (const reading of readings) {
      const id = reading.post.id;
      if (deleted.get(id)) continue;
      if (!rules.oldResourceCheckEnabled && reading.views !== null) {
        saveOldTraffic(this.db, [reading], [], this.now(), rules);
        clearQueued.run(id);
        continue;
      }
      const state = get.get(id);
      if (state?.admitted === 1) {
        saveOldTraffic(this.db, [reading], [], this.now(), rules);
        continue;
      }
      if (reading.views !== null && !passesOldTrafficScreen(reading, rules)) continue;
      if (reading.views !== null && reading.resource?.linkSources.length) {
        if (hasBaseline.get(id)) {
          saveOldResource(this.db, id, reading.resource, this.now());
          admitOldResource(this.db, id);
          saveOldTraffic(this.db, [reading], [], this.now(), rules);
        } else {
          saveOldTraffic(this.db, [reading], [], this.now(), rules, reading.resource);
        }
        clearQueued.run(id);
      } else if (state?.checked_at == null) {
        queueOldResource(this.db, reading);
      }
    }
  }

  private scheduleOldResources() {
    if (this.closed || this.resourceActive || (!this.auto && !this.resourceSweep) || !this.read.oldResource)
      return;
    const next = nextOldResourceCheck(this.db, this.rules().oldResourceCheckEnabled);
    if (next === null) return;
    const at = Math.max(this.now(), next) + 500;
    if (this.resourceTimerAt !== undefined && this.resourceTimerAt <= at) return;
    clearTimeout(this.resourceTimer);
    this.resourceTimerAt = at;
    this.resourceTimer = setTimeout(() => {
      this.resourceTimer = undefined;
      this.resourceTimerAt = undefined;
      void this.checkOldResources().catch((error: unknown) => {
        if (!this.closed)
          this.log(`老帖资源检查失败：${error instanceof Error ? error.message : "读取失败"}`);
      });
    }, at - this.now());
    this.resourceTimer.unref();
  }

  private async checkOldResources() {
    const read = this.read.oldResource;
    if (this.closed || !read || this.resourceActive) return;
    const controller = new AbortController();
    this.resourceActive = controller;
    const { signal } = controller;
    const send: typeof fetch = (input, options) => fetch(input, {
      ...options,
      signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
    });
    try {
      for (const { reading, legacy } of dueOldResourceChecks(this.db, this.now(), 8, this.rules().oldResourceCheckEnabled)) {
        signal.throwIfAborted();
        const id = reading.post.id;
        const startedAt = this.now();
        try {
          if (reading.views === null) {
            reading.views = await this.read.views(id, send);
            reading.at = this.now();
            if (reading.views === null) throw new Error("暂未读到浏览量");
          }
          signal.throwIfAborted();
          if (!passesOldTrafficScreen(reading, this.rules())) {
            if (legacy)
              this.finishOldResourceCheck(id, true, { linkSources: [], keywords: [] }, null);
            else
              this.db.db.prepare("DELETE FROM tieba_discovery_old_resource_queue WHERE thread_id = ?").run(id);
            continue;
          }
          const currentRules = this.rules();
          if (!currentRules.oldResourceCheckEnabled) {
            this.db.transaction(() => {
              if (this.db.get("SELECT 1 FROM tieba_discovery_old_resource_deleted WHERE thread_id = ?", id)) return;
              if (!legacy) saveOldTraffic(this.db, [reading], [], this.now(), currentRules);
              this.db.db.prepare("DELETE FROM tieba_discovery_old_resource_queue WHERE thread_id = ?").run(id);
            });
            continue;
          }
          let detail = reading.resource;
          if (!detail?.linkSources.length) {
            try {
              detail = await read(id, send);
            } catch (error) {
              signal.throwIfAborted();
              if (!(error instanceof AppError) || error.code !== "TIEBA_ANALYSIS_NETWORK") throw error;
              await wait(750, undefined, { signal, ref: false });
              detail = await read(id, send);
            }
          }
          signal.throwIfAborted();
          const evidence = {
            linkSources: [...new Set([...(reading.resource?.linkSources ?? []), ...detail.linkSources])],
            keywords: [...new Set([...(reading.resource?.keywords ?? []), ...detail.keywords])],
          };
          this.db.transaction(() => {
            if (this.db.get("SELECT 1 FROM tieba_discovery_old_resource_deleted WHERE thread_id = ?", id)) return;
            const latest = this.db.get<{ checked_at: number | null }>(
              "SELECT checked_at FROM tieba_discovery_old_resource WHERE thread_id = ?", id,
            );
            if (latest?.checked_at != null && latest.checked_at > startedAt) return;
            const rules = this.rules();
            const accepted = passesOldTrafficScreen(reading, rules) && isOldResource(evidence);
            if (accepted) {
              if (legacy) {
                saveOldResource(this.db, id, evidence, this.now());
                admitOldResource(this.db, id);
              } else {
                saveOldTraffic(this.db, [reading], [], this.now(), rules, evidence);
              }
            }
            this.finishOldResourceCheck(id, legacy, evidence, null, accepted);
          });
        } catch (error) {
          signal.throwIfAborted();
          this.finishOldResourceCheck(id, legacy, undefined, this.now() + oldResourceRetryDelay);
        }
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      this.resourceActive = undefined;
      if (!this.closed) {
        this.scheduleOldResources();
        this.changed();
      }
    }
  }

  private finishOldResourceCheck(
    id: string,
    legacy: boolean,
    evidence: OldTrafficReading["resource"],
    retryAt: number | null,
    accepted = false,
  ) {
    const db = this.db.db;
    if (this.db.get("SELECT 1 FROM tieba_discovery_old_resource_deleted WHERE thread_id = ?", id)) return;
    if (legacy && retryAt !== null) {
      db.prepare(`
        INSERT INTO tieba_discovery_old_resource (thread_id, evidence, status, retry_at)
        VALUES (?, '{"linkSources":[],"keywords":[]}', 'pending', ?)
        ON CONFLICT(thread_id) DO UPDATE SET retry_at = excluded.retry_at
      `).run(id, retryAt);
    } else if (legacy && evidence) {
      saveOldResource(this.db, id, evidence, this.now());
    }
    if (accepted || (legacy && retryAt === null))
      db.prepare("DELETE FROM tieba_discovery_old_resource_queue WHERE thread_id = ?").run(id);
    else
      db.prepare("UPDATE tieba_discovery_old_resource_queue SET next_check_at = ? WHERE thread_id = ?").run(retryAt, id);
  }

  deleteOldResource(id: string) {
    this.db.transaction(() => {
      if (!this.db.get("SELECT 1 FROM tieba_discovery_old_traffic WHERE thread_id = ?", id)) return;
      const db = this.db.db;
      db.prepare("INSERT OR IGNORE INTO tieba_discovery_old_resource_deleted (thread_id) VALUES (?)").run(id);
      db.prepare("DELETE FROM tieba_discovery_old_resource_queue WHERE thread_id = ?").run(id);
      db.prepare("DELETE FROM tieba_discovery_old_traffic WHERE thread_id = ?").run(id);
    });
    this.changed();
  }

  saveRules(rules: TiebaDiscoveryRules) {
    const checkChanged = this.rules().oldResourceCheckEnabled !== rules.oldResourceCheckEnabled;
    this.db.setSetting(rulesKey, rules);
    if (checkChanged) {
      this.resourceActive?.abort();
      clearTimeout(this.resourceTimer);
      this.resourceTimer = undefined;
      this.resourceTimerAt = undefined;
      this.resourceSweep = true;
    }
    this.scheduleHistory();
    this.scheduleOldResources();
    this.changed();
    return this.snapshot();
  }

  saveSeeds(names: string[]) {
    if (this.active)
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
        highTrafficPage: old.get(key(name))?.highTrafficPage,
        recentGrowthPage: old.get(key(name))?.recentGrowthPage,
        recentGrowthSampleAt: old.get(key(name))?.recentGrowthSampleAt,
      })),
      ...state.sources.filter(
        (source) =>
          source.status !== "seed" &&
          !state.seeds.some((name) => key(name) === key(source.name)),
      ),
    ];
    this.db.setSetting(storageKey, state);
    if (this.auto) this.scheduleNext();
    this.scheduleHistory();
    this.changed();
    return this.snapshot();
  }

  setAuto(enabled: boolean) {
    const changed = this.auto !== enabled;
    this.db.setSetting(autoKey, enabled);
    this.auto = enabled;
    if (changed) this.log(enabled ? "已开启持续发现" : "已关闭持续发现");
    if (!enabled) {
      this.clearTimer();
      clearTimeout(this.historyTimer);
      this.historyActive?.abort();
      this.resourceSweep = false;
      clearTimeout(this.resourceTimer);
      this.resourceTimer = undefined;
      this.resourceTimerAt = undefined;
      this.resourceActive?.abort();
    } else {
      if (!this.active) this.scheduleNext(changed);
      this.scheduleHistory();
      this.scheduleOldResources();
    }
    this.changed();
    return this.snapshot();
  }

  scan(mode: ScanMode = "survey") {
    if (this.active || this.refreshActive) return this.snapshot();
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
        this.scheduleHistory();
        this.changed();
      });
    this.changed();
    return this.snapshot();
  }

  dispose() {
    this.closed = true;
    this.resourceActive?.abort();
    this.refreshActive?.abort();
    clearTimeout(this.resourceTimer);
    this.clearTimer();
    this.active?.abort();
    clearTimeout(this.historyTimer);
    this.historyActive?.abort();
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

  private history() {
    const rules = this.rules();
    const screen = JSON.stringify([
      rules.oldTrafficMinTotalViews,
      rules.oldTrafficMinLifetimeDailyViews,
    ]);
    const saved = this.db.setting<HistoryScan>(historyKey, {
      screen, forums: [], authors: {}, revision: 0,
    });
    const { seeds, sources, history } = this.stored();
    const forums = new Map(saved.forums.map((forum) => [key(forum.name), forum]));
    const names = new Set([
      ...seeds,
      ...sources.map(({ name }) => name),
      ...Object.values(history ?? {}).map(({ name }) => name),
    ]);
    for (const name of names) {
      if (!forums.has(key(name))) forums.set(key(name), { name, nextPage: 1 });
    }
    return {
      screen,
      forums: [...forums.values()].map((forum) =>
        saved.screen === screen ? forum : { name: forum.name, nextPage: 1 },
      ),
      authors: saved.screen === screen ? saved.authors : {},
      revision: saved.revision,
    };
  }

  private describeHistory(history: HistoryScan) {
    return {
      ...this.historyPage,
      completed: history.forums.filter(({ completedAt }) => completedAt !== undefined).length,
      total: history.forums.length,
      revision: history.revision,
    };
  }

  private scheduleHistory() {
    if (!this.read.oldForum || this.closed) return;
    clearTimeout(this.historyTimer);
    if (this.historyActive) return;
    const history = this.history();
    this.historyProgress = this.describeHistory(history);
    if (!this.auto) return;
    const now = this.now();
    const next = Math.min(...history.forums.map(({ completedAt, retryAt }) =>
      Math.max(retryAt ?? now, completedAt === undefined ? now : completedAt + historyRescanGap),
    ));
    if (!Number.isFinite(next)) return;
    this.historyTimer = setTimeout(() => {
      if (this.auto) this.scanOldForum(true);
    }, Math.max(0, Math.max(next, this.historyCooldown) - now));
    this.historyTimer.unref();
  }

  scanOldForum(automatic = false) {
    const read = this.read.oldForum;
    if (!read || this.closed || this.historyActive) return this.snapshot();
    clearTimeout(this.historyTimer);
    const controller = new AbortController();
    this.historyActive = controller;
    this.resourceSweep = true;
    this.scheduleOldResources();
    void this.scanHistory(controller.signal, read, automatic)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        this.log(`老帖扫描暂缓：${error instanceof Error ? error.message.slice(0, 100) : "读取失败"}`);
        this.historyCooldown = this.now() + historyRetryGap;
      })
      .finally(() => {
        this.historyActive = undefined;
        this.historyPage = undefined;
        if (this.closed) return;
        this.scheduleHistory();
        this.changed();
      });
    return this.snapshot();
  }

  private async scanHistory(
    signal: AbortSignal,
    read: NonNullable<TiebaDiscoveryReaders["oldForum"]>,
    automatic: boolean,
  ) {
    const now = this.now();
    const history = this.history();
    const eligible = history.forums.filter(({ retryAt, completedAt }) =>
      (!automatic || (retryAt ?? 0) <= now) &&
      (completedAt === undefined || now - completedAt >= historyRescanGap),
    );
    const cursor = eligible.find(({ completedAt }) => completedAt === undefined) ?? eligible[0];
    if (!cursor) return;
    const rules = this.rules();
    const send: typeof fetch = (input, options) => fetch(input, {
      ...options,
      signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
    });
    const authors = new Map(Object.entries(history.authors)
      .filter(([, checkedAt]) => now - checkedAt < historyRescanGap));
    cursor.retryAt = undefined;
    cursor.completedAt = undefined;
    let nextNotice = 0;
    this.log(`「${cursor.name}」开始扫描老帖，从第 ${cursor.nextPage} 页接续`);
    while (true) {
      signal.throwIfAborted();
      const page = cursor.nextPage;
      this.historyPage = { forum: cursor.name, page };
      const at = this.now();
      this.historyProgress = this.describeHistory(history);
      if (page === 1 || at >= nextNotice) {
        this.changed();
        nextNotice = at + 3000;
      }
      const readings = new Map<string, OldTrafficReading>();
      const collect = (threads: (TiebaAnalysisThread & { author?: string })[], author?: string) => {
        const at = this.now();
        for (const item of threads) {
          const { id, title, url, forum, publishedAt, authorId, views } = item;
          if (!publishedAt || !(oldTrafficAge(publishedAt, at) >= oldTrafficMinimumAgeDays)) continue;
          if (views === null && readings.get(id)?.views != null) continue;
          readings.set(id, {
            post: { id, title, url, forum, publishedAt, authorId, author: author ?? item.author },
            at, views, resource: item.oldResource ?? oldResourceEvidence([{ source: "标题", text: title }]),
          });
        }
      };
      try {
        const result = await read({ name: cursor.name, page }, send, "old");
        signal.throwIfAborted();
        const pageIds = result.threads.map(({ id }) => id).sort().join(",");
        if (result.hasMore && pageIds && pageIds === cursor.lastPageIds) {
          throw new Error("贴吧未返回下一页，稍后重试");
        }
        collect(result.threads);
        const lead = (cursor.authorsChecked ?? 0) < 3
          ? [...readings.values()].find((item) =>
              item.post.authorId && !authors.has(item.post.authorId) && passesOldTrafficScreen(item, rules),
            )
          : undefined;
        if (lead?.post.authorId) {
          const uid = lead.post.authorId;
          cursor.authorsChecked = (cursor.authorsChecked ?? 0) + 1;
          authors.set(uid, this.now());
          try {
            const user = await this.read.user({ target: `UID: ${uid}`, page: 1 }, send, true);
            signal.throwIfAborted();
            collect(user.threads, user.author);
            const known = new Set(history.forums.map(({ name }) => key(name)));
            let added = 0;
            for (const { forum } of user.threads) {
              const name = tiebaForumNameSchema.safeParse(forum);
              if (!name.success || known.has(key(name.data))) continue;
              known.add(key(name.data));
              history.forums.push({ name: name.data, nextPage: 1 });
              added++;
            }
            if (added) this.log(`「${cursor.name}」通过老帖作者发现 ${added} 个贴吧，已加入历史扫描`);
          } catch (error) {
            signal.throwIfAborted();
            this.log(`「${cursor.name}」暂未读到老帖作者，继续扫描`);
          }
        }
        signal.throwIfAborted();
        cursor.nextPage = result.hasMore ? page + 1 : 1;
        cursor.lastPageIds = result.hasMore ? pageIds || undefined : undefined;
        cursor.completedAt = result.hasMore ? undefined : this.now();
        if (!result.hasMore) cursor.authorsChecked = undefined;
        history.authors = Object.fromEntries(authors);
        this.db.transaction(() => {
          this.stageOldResources(readings.values(), this.rules());
          history.revision++;
          this.db.setSetting(historyKey, history);
        });
        this.scheduleOldResources();
        if (!result.hasMore) {
          this.log(`「${cursor.name}」老帖扫描已到公开列表末页（第 ${page} 页）`);
          return;
        }
      } catch (error) {
        signal.throwIfAborted();
        cursor.nextPage = page;
        cursor.retryAt = this.now() + historyRetryGap;
        cursor.completedAt = undefined;
        this.db.setSetting(historyKey, history);
        this.log(`「${cursor.name}」老帖扫描停在第 ${page} 页，稍后重试：${error instanceof Error ? error.message.slice(0, 80) : "读取失败"}`);
        return;
      }
      await wait(300 + Math.floor(Math.random() * 250), undefined, { signal, ref: false });
      const latest = this.rules();
      if (history.screen !== JSON.stringify([latest.oldTrafficMinTotalViews, latest.oldTrafficMinLifetimeDailyViews])) return;
    }
  }

  private async run(signal: AbortSignal, mode: ScanMode) {
    const state = this.stored(),
      now = this.now();
    const rules = this.rules();
    const lookback = rules.lookbackHours * discoveryInterval;
    const growthCandidate = (post: Pick<TiebaAnalysisThread, "publishedAt" | "views">, at: number) =>
      post.publishedAt !== null && (post.views ?? 0) < rules.trafficThreshold &&
      inRecentGrowthWindow({ publishedAt: post.publishedAt }, at, rules);
    const needsOldHandoff = (post: Post, at: number) =>
      oldTrafficAge(post.publishedAt, at) >= oldTrafficMinimumAgeDays &&
      oldTrafficAge(post.publishedAt, post.checkedAt) < oldTrafficMinimumAgeDays &&
      !!(post.potential || post.pendingSince !== undefined || post.manualGrowthWatch ||
        inRecentGrowthWindow(post, post.checkedAt, rules));
    const monitored = (post: Post) =>
      !!post.potential && !awaitsMaturePotentialReading(post, rules) &&
      (qualifyingHourlyViews(post, this.now(), rules) !== null ||
        (!!post.potential.recentGrowth && growthCandidate(post, this.now())));
    const pendingDue = (post: Post, at: number) => {
      if (at < pendingObservationDueAt(post, rules)) return false;
      return post.pendingSince !== undefined ||
        (!!post.potential && recent(post, at, lookback) && awaitsMaturePotentialReading(post, rules));
    };
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
        .filter((post) => recent(post, now, lookback) || growthCandidate(post, now) || needsOldHandoff(post, now))
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
    const oldCandidates: OldTrafficReading[] = [];
    const oldHandoffs: OldTrafficReading[] = [];
    const oldRetries: string[] = [];
    const record = (post: Post, views: number) => {
      const at = this.now();
      seen.add(post.id);
      if (needsOldHandoff(post, at)) {
        const reading = postReading(post);
        oldHandoffs.push({
          post: { ...reading, authorId: post.uid },
          at, views, resource: post.resource,
        });
      }
      if (views >= rules.trafficThreshold) {
        highTraffic.set(post.id, {
          ...postReading(post),
          views,
          checkedAt: at,
          fromPotential: !!post.potential,
        });
        if (post.uid) highTrafficAuthors.push({ ...post, views });
        posts.delete(post.id);
        return;
      }
      const reading = observePostViews(post, at, views, rules);
      if (reading.growth?.to !== post.growth?.to) advanced.add(post.id);
      posts.set(post.id, { ...post, ...reading, views, checkedAt: at });
    };
    const ingestForumPage = (source: StoredSource, result: Awaited<ReturnType<typeof queryTiebaAnalysisForumPosts>>) => {
      for (const item of result.threads) {
        if (!item.publishedAt || seen.has(item.id) || archived(item.id))
          continue;
        const fresh = recent(item, this.now(), lookback);
        if (
          !fresh && !growthCandidate(item, this.now()) &&
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
          pendingSince: old?.pendingSince,
          manualGrowthWatch: old?.manualGrowthWatch,
          oldHandoffAttemptAt: old?.oldHandoffAttemptAt,
          resource: old?.resource,
        };
        if (item.views === null) {
          posts.set(item.id, post);
          missingListViews.add(item.id);
        } else {
          missingListViews.delete(item.id);
          record(post, item.views);
        }
      }
    };
    const readPage = async (source: StoredSource, page: number) => {
      const result = await attempt(source.name, () =>
        this.read.forum({ name: source.name, page }, send, true));
      if (result) ingestForumPage(source, result);
      return result;
    };
    let readForums = 0;
    let growthProbesLeft = recentGrowthProbesPerRun;
    const scanSources = mode === "survey"
      ? selected.toSorted((a, b) => (a.recentGrowthSampleAt ?? 0) - (b.recentGrowthSampleAt ?? 0))
      : selected;
    for (const source of scanSources) {
      this.scanningForum = source.name;
      this.log(`正在扫描「${source.name}」`);
      this.changed();
      source.lastAttemptAt = this.now();
      const recentReadings: TiebaAnalysisThread[] = [];
      let recentPages = 0;
      let historyStart: number | undefined;
      let firstPage: Awaited<ReturnType<typeof readPage>>;
      for (let page = 1; page <= recentPagesPerForum; page++) {
        const result = await readPage(source, page);
        if (!result) {
          if (page === 1) this.log(`「${source.name}」暂未读取到，继续下一项`);
          break;
        }
        recentPages++;
        firstPage ??= result;
        recentReadings.push(...result.threads);
        historyStart = result.hasMore ? page + 1 : undefined;
        if (
          !historyStart ||
          result.threads.every(
            (post) => post.publishedAt && !recent(post, this.now(), lookback) &&
              !growthCandidate(post, this.now()),
          )
        )
          break;
      }
      if (!recentPages) continue;
      readForums++;
      source.scannedAt = this.now();
      source.exposure = forumExposure(recentReadings, source.scannedAt);
      const readIds = new Set(recentReadings.map(({ id }) => id));
      const extra = historyStart === undefined
        ? undefined
        : await readPage(source, Math.max(
            historyStart,
            source.highTrafficPage ?? state.history?.[key(source.name)]?.nextPage ?? historyStart,
          ));
      if (extra) source.highTrafficPage = extra.hasMore ? extra.page + 1 : 1;
      for (const { id } of extra?.threads ?? []) readIds.add(id);
      let growthPage: number | undefined;
      if (mode === "survey" && growthProbesLeft > 0 && firstPage?.totalPages &&
          lookback < oldTrafficMinimumAgeDays * 24 * discoveryInterval &&
          !recentReadings.some((post) => growthCandidate(post, now))) {
        // A busy forum can place the entire growth window well beyond the hot pages.
        source.recentGrowthSampleAt = this.now();
        let low = 1;
        let high = Math.max(1, Math.ceil(firstPage.totalPages * 20 / recentGrowthPageSize));
        let page = Math.min(high, source.recentGrowthPage ?? Math.floor((low + high) / 2));
        let found: Awaited<ReturnType<typeof queryTiebaAnalysisForumPosts>> | undefined;
        let interrupted = false;
        for (let probe = 0; probe < 9 && growthProbesLeft > 0 && low <= high; probe++) {
          growthProbesLeft--;
          const sample = await attempt(source.name, () =>
            this.read.forum({ name: source.name, page, pageSize: recentGrowthPageSize }, send, true));
          if (!sample) {
            interrupted = true;
            break;
          }
          const at = this.now();
          const ages = sample.threads.flatMap(({ publishedAt }) =>
            publishedAt ? [at - Date.parse(publishedAt)] : []);
          if (ages.some((age) => age > lookback && age < oldTrafficMinimumAgeDays * 24 * discoveryInterval)) {
            found = sample;
            if (source.recentGrowthPage !== undefined) break;
          }
          if (ages.length && Math.max(...ages) <= lookback) low = page + 1;
          else high = page - 1;
          page = Math.floor((low + high) / 2);
        }
        if (found) {
          ingestForumPage(source, found);
          growthPage = found.page;
          source.recentGrowthPage = found.hasMore ? found.page + 1 : undefined;
          for (const { id } of found.threads) readIds.add(id);
        } else if (!interrupted && low > high) {
          source.recentGrowthPage = undefined;
        }
      }
      const pageNote = extra ? `，补读第 ${extra.page} 页` : "";
      const growthNote = growthPage ? `，近期增长取样第 ${growthPage} 页` : "";
      this.log(
        `「${source.name}」读到近期 ${recentPages} 页${pageNote}${growthNote}，共 ${readIds.size} 篇 · 曝光${source.exposure ? `样本 ${source.exposure.sample} 篇` : "样本不足"}`,
      );
    }

    if (this.scanningForum) {
      this.scanningForum = undefined;
      this.log("正在核对帖子和作者");
      this.changed();
    }

    const recheckAt = this.now();
    const due = [...posts.values()]
      .filter(
        (post) =>
          !seen.has(post.id) &&
          ((mode === "survey" && (pendingDue(post, recheckAt) || monitored(post) ||
            growthCandidate(post, recheckAt))) ||
            (missingListViews.has(post.id) && !post.baseline)) &&
          (pendingDue(post, recheckAt) || !before.has(post.id) ||
            recheckAt - (growthCandidate(post, recheckAt)
              ? post.baseline?.at ?? post.checkedAt : post.checkedAt) >= minReadingGap),
      )
      .sort(
        (a, b) =>
          Number(pendingDue(b, recheckAt)) - Number(pendingDue(a, recheckAt)) ||
          Number(!!b.manualGrowthWatch) - Number(!!a.manualGrowthWatch) ||
          Number(monitored(b)) - Number(monitored(a)) ||
          Number(b.streak > 0) - Number(a.streak > 0) ||
          Number(before.has(b.id)) - Number(before.has(a.id)) ||
          a.checkedAt - b.checkedAt,
      );
    const growthDue = due.filter((post) => growthCandidate(post, recheckAt));
    const otherDue = due.filter((post) => !growthCandidate(post, recheckAt));
    for (const post of [...otherDue.slice(0, 20), ...growthDue.slice(0, recentGrowthDetailReadsPerSurvey)]) {
      const views = await attempt(`${post.forum}帖子复查`, () =>
        this.read.views(post.id, send),
      );
      if (views != null) record(post, views);
    }
    if (mode === "survey") {
      const handoffs = [...posts.values()]
        .filter((post) => !seen.has(post.id) && needsOldHandoff(post, recheckAt))
        .sort((a, b) => (a.oldHandoffAttemptAt ?? 0) - (b.oldHandoffAttemptAt ?? 0) ||
          a.publishedAt.localeCompare(b.publishedAt))
        .slice(0, oldDetailReadsPerSurvey);
      for (const post of handoffs) {
        post.oldHandoffAttemptAt = this.now();
        const views = await attempt(`${post.forum}老帖交接复查`, () =>
          this.read.views(post.id, send),
        );
        if (views != null) record(post, views);
      }
    }
    const observations = [...posts.values()];
    const rankedAt = this.now();
    const firstSignals = potentialSignals(
      observations
        .filter((post) => seen.has(post.id) && (!post.potential || !post.potential.recentGrowth &&
          growthCandidate(post, rankedAt)) &&
          (listed.has(post.id) || pendingDue(post, post.checkedAt) || growthCandidate(post, rankedAt)))
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
      const signal = firstSignals.get(post.id);
      if (signal) {
        const { stage, ...evidence } = signal;
        if (stage === "potential") {
          post.potential ??= evidence;
          post.manualGrowthWatch = undefined;
        } else post.pendingSince ??= evidence.at;
      }
      if (seen.has(post.id) && pendingDue(post, post.checkedAt))
        post.pendingSince = undefined;
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
        return established || best.streak || monitored(best) ||
          best.pendingSince !== undefined || distinct >= 2
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
      best: Pick<Post, "forum">,
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
        via: { forum: best.forum, reason },
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
      for (const name of names) addSource(name, best, "posted");
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
            addSource(forum.name, best, "followed"),
          )
        )
          break;
      }
    }

    if (mode === "survey") {
      const due = dueOldTraffic(this.db, this.now(), oldDetailReadsPerSurvey, rules.oldResourceCheckEnabled);
      for (const post of due) {
        const views = await attempt(`${post.forum}老帖复查`, () =>
          this.read.views(post.id, send),
        );
        if (views == null) oldRetries.push(post.id);
        else oldCandidates.push({ post, at: this.now(), views });
      }
    }

    signal.throwIfAborted();
    // Keep every in-window baseline even when the archive or pending queue is large.
    state.posts = observations.filter((post) =>
      recent(post, rankedAt, lookback) || growthCandidate(post, rankedAt) || needsOldHandoff(post, rankedAt));
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
    const oldReadings = this.db.transaction(() => {
      this.stageOldResources(oldHandoffs, this.rules());
      saveTrafficPosts(this.db, highTraffic, this.rules());
      savePotentialPosts(
        this.db,
        observations.flatMap((post) => {
          if (!post.potential || !seen.has(post.id)) return [];
          const confirmedGrowth = firstSignals.get(post.id)?.recentGrowth ??
            (meetsDiscoveryRule(post.growth, ranks.get(post.id)) ? post.growth ?? undefined : undefined);
          return [
            {
              ...postReading(post),
              first: post.potential,
              ...(confirmedGrowth ? { confirmedGrowth } : {}),
              confirmedAt: confirmedGrowth ? rankedAt : null,
            },
          ];
        }),
      );
      const updated = saveOldTraffic(
        this.db,
        oldCandidates,
        oldRetries,
        this.now(),
        rules,
      );
      this.db.setSetting(storageKey, state);
      return updated;
    });
    if (oldHandoffs.length) this.scheduleOldResources();
    if (oldReadings) {
      const results = oldTrafficSummary(this.db, this.rules());
      this.log(`老帖更新 ${oldReadings} 篇读数 · 跟踪 ${results.tracked} 篇 · 实测达标 ${results.total} 篇`);
    }
    this.log(
      `本批结束，读到 ${readForums} 个贴吧，查看 ${probed} 位作者，发现 ${added} 个新贴吧`,
    );
  }
}

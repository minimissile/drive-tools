import type { z } from "zod";
import type { Database } from "../database";
import type { WebsiteAccounts } from "../website-accounts";
import type { BrowserEnvironments } from "../browser-environments";
import type { BrowserEnvironmentQueue } from "../browser-environment-queue";
import type { TiebaPublicationRef } from "../../shared/tieba-insights";
import {
  tiebaPostStatsScopeMessage,
  tiebaPostStatsDiscoverSchema,
  tiebaPostStatsImportSchema,
  tiebaPostStatsRefreshSchema,
  type TiebaPostStat,
  type TiebaPostStatsReading,
  type TiebaPostStatsSnapshot,
} from "../../shared/tieba-post-stats";
import type { TiebaPostStatsBrowser } from "./types";
import { AppError, safeMessage } from "../errors";
import {
  tiebaThreadIdFromUrl,
  tiebaThreadUrl,
} from "../tieba/participation-page";
import { tiebaBodyDriveLinks } from "./links";

const stateKey = "tiebaPostStats:v1";
const ref = (id: string) => ({ kind: "website" as const, id });
type StatState = { posts: TiebaPostStat[]; lastRefreshedAt: string | null };
type Dependencies = {
  db: Database;
  accounts: WebsiteAccounts;
  environments: BrowserEnvironments;
  queue: BrowserEnvironmentQueue;
  browser?: TiebaPostStatsBrowser;
  publications(): TiebaPublicationRef[];
  changed(): void;
  clock?(): number;
};
const empty = (): StatState => ({ posts: [], lastRefreshedAt: null });
const metricKeys = ["views", "replies", "likes"] as const;
const total = (rows: (number | null)[]) => {
  if (!rows.length || rows.some((n) => n === null)) return null;
  const sum = rows.reduce<number>((value, n) => value + n!, 0);
  return Number.isSafeInteger(sum) ? sum : null;
};
const delta = (current: number | null, previous: number | null | undefined) =>
  current !== null &&
  previous !== null &&
  previous !== undefined &&
  current >= previous
    ? current - previous
    : null;

/** Explicit reads only. Opening the screen never opens an official page. */
export class TiebaPostStats {
  private working = false;
  private closed = false;
  private controllers = new Set<AbortController>();
  constructor(private d: Dependencies) {}
  get isBusy() {
    return this.working;
  }
  private time() {
    return this.d.clock?.() ?? Date.now();
  }
  private now() {
    return new Date(this.time()).toISOString();
  }
  private alive() {
    if (this.closed)
      throw new AppError(
        "TIEBA_POST_STATS_CLOSED",
        "帖子统计读取已停止，历史保留。",
      );
  }
  private state() {
    return this.d.db.setting<StatState>(stateKey, empty());
  }
  private save(value: StatState) {
    this.d.db.setSetting(stateKey, value);
  }
  snapshot(): TiebaPostStatsSnapshot {
    this.alive();
    const state = this.state();
    const accounts = this.d.db
      .all<{ id: string }>(
        "SELECT id FROM website_accounts WHERE provider='tieba' ORDER BY created_at,id",
      )
      .map(({ id }) => this.d.accounts.get(id));
    const posts = state.posts
      .filter(
        (post) =>
          post.links.length &&
          accounts.some((a) => a.id === post.accountId && a.uid === post.uid),
      )
      .sort(
        (a, b) =>
          (b.deltaViews ?? -1) - (a.deltaViews ?? -1) ||
          b.checkedAt.localeCompare(a.checkedAt),
      );
    return {
      busy: this.working,
      accounts,
      posts,
      summary: {
        trackedPosts: posts.length,
        views: total(posts.map((p) => p.views)),
        replies: total(posts.map((p) => p.replies)),
        likes: total(posts.map((p) => p.likes)),
        deltaViews: total(posts.map((p) => p.deltaViews)),
        deltaReplies: total(posts.map((p) => p.deltaReplies)),
        deltaLikes: total(posts.map((p) => p.deltaLikes)),
        lastRefreshedAt: state.lastRefreshedAt,
      },
      scopeMessage: tiebaPostStatsScopeMessage,
      message: this.working
        ? "正在只读核对本人资源帖"
        : "增量对比每个帖子最近两次成功读取；首次记录或官网未返回的数字不补零。",
    };
  }
  private account(accountId: string, expectedUid?: string) {
    const account = this.d.accounts.get(accountId);
    if (
      account.provider !== "tieba" ||
      !account.uid ||
      (expectedUid && account.uid !== expectedUid)
    )
      throw new AppError(
        "TIEBA_POST_STATS_ACCOUNT",
        "请先核实原贴吧账号身份，未读取其他账号帖子。",
      );
    return account;
  }
  private browser() {
    if (!this.d.browser)
      throw new AppError(
        "TIEBA_POST_STATS_BROWSER",
        "当前后台尚未接入帖子统计，请应用更新后重试。",
      );
    return this.d.browser;
  }
  private async operation<T>(action: () => Promise<T>): Promise<T> {
    this.alive();
    if (this.working)
      throw new AppError(
        "TIEBA_POST_STATS_BUSY",
        "已有帖子统计正在读取，请等待完成。",
      );
    this.working = true;
    this.d.changed();
    try {
      return await action();
    } finally {
      this.working = false;
      if (!this.closed) this.d.changed();
    }
  }
  private async queued<T>(
    accountId: string,
    label: string,
    action: (uid: string) => Promise<T>,
  ) {
    const original = this.account(accountId),
      uid = original.uid!;
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      return await this.d.queue.schedule(
        [ref(accountId)],
        label,
        async () => {
          this.alive();
          this.account(accountId, uid);
          const verified = await this.d.accounts.verify(accountId);
          this.alive();
          if (verified.status !== "connected" || verified.uid !== uid)
            throw new AppError(
              "TIEBA_POST_STATS_LOGIN",
              verified.message || "请在原账号核实贴吧登录。",
            );
          this.account(accountId, uid);
          const stamp = this.d.environments.stamp(ref(accountId));
          const result = await action(uid);
          this.alive();
          this.account(accountId, uid);
          this.d.environments.assertStamp(ref(accountId), stamp);
          return result;
        },
        controller.signal,
      );
    } finally {
      this.controllers.delete(controller);
    }
  }
  private validate(
    reading: TiebaPostStatsReading,
    threadId: string,
    uid: string,
  ) {
    const at = Date.parse(reading.checkedAt);
    if (
      reading.threadId !== threadId ||
      reading.uid !== uid ||
      reading.url !== tiebaThreadUrl(threadId) ||
      !/^[1-9]\d{0,19}$/.test(reading.forumId) ||
      !reading.title.trim() ||
      !reading.forumName.trim() ||
      !Number.isFinite(at) ||
      at > this.time() + 5000 ||
      at < this.time() - 10 * 60000 ||
      metricKeys.some(
        (key) =>
          reading[key] !== null &&
          (!Number.isSafeInteger(reading[key]) || reading[key]! < 0),
      ) ||
      reading.links.some((url) => tiebaBodyDriveLinks(url).length !== 1)
    )
      throw new AppError(
        "TIEBA_POST_STATS_READING",
        "官网主题身份、时间或统计读数无效，原记录已保留。",
      );
  }
  private async readOne(
    accountId: string,
    threadId: string,
    expectedUid: string,
  ) {
    this.account(accountId, expectedUid);
    const reading = await this.queued(
      accountId,
      "读取本人资源帖数据",
      async (uid) => {
        const account = this.account(accountId, uid);
        const result = await this.browser().readThread(account, uid, threadId);
        this.validate(result, threadId, uid);
        return result;
      },
    );
    this.alive();
    const state = this.state();
    const id = `${accountId}:${reading.uid}:${threadId}`;
    const old = state.posts.find((p) => p.id === id);
    // Keep prior history when the complete current first post leaves the scope.
    if (!reading.links.length && !old) return false;
    if (!old && state.posts.length >= 500)
      throw new AppError(
        "TIEBA_POST_STATS_LIMIT",
        "已记录500个资源帖，暂未加入更多统计。",
      );
    const history = [
      ...(old?.history ?? []),
      {
        checkedAt: reading.checkedAt,
        views: reading.views,
        replies: reading.replies,
        likes: reading.likes,
      },
    ].slice(-60);
    const post: TiebaPostStat = {
      ...reading,
      id,
      accountId,
      history,
      previousCheckedAt: old?.checkedAt ?? null,
      deltaViews: delta(reading.views, old?.views),
      deltaReplies: delta(reading.replies, old?.replies),
      deltaLikes: delta(reading.likes, old?.likes),
    };
    this.save({
      posts: [...state.posts.filter((p) => p.id !== id), post],
      lastRefreshedAt: reading.checkedAt,
    });
    return !!reading.links.length;
  }
  private async readMany(
    accountId: string,
    ids: string[],
    expectedUid: string,
  ) {
    this.account(accountId, expectedUid);
    const result: NonNullable<TiebaPostStatsSnapshot["refreshResult"]> = {
      succeeded: [],
      excluded: [],
      failed: [],
    };
    for (const threadId of [...new Set(ids)]) {
      try {
        if (await this.readOne(accountId, threadId, expectedUid))
          result.succeeded.push(threadId);
        else
          result.excluded.push({
            threadId,
            message: "首帖正文中没有受支持的网盘分享链接，未纳入统计。",
          });
      } catch (error) {
        if (this.closed) throw error;
        result.failed.push({ threadId, message: safeMessage(error) });
      }
    }
    return result;
  }
  async refresh(raw: z.infer<typeof tiebaPostStatsRefreshSchema>) {
    const input = tiebaPostStatsRefreshSchema.parse(raw);
    return this.operation(async () => {
      const account = this.account(input.accountId),
        uid = account.uid!;
      const known = new Set([
        ...this.state()
          .posts.filter((p) => p.accountId === account.id && p.uid === uid)
          .map((p) => p.threadId),
        ...this.d
          .publications()
          .filter(
            (p) =>
              p.kind === "topic" &&
              p.accountId === account.id &&
              p.uid === uid &&
              p.threadId &&
              tiebaBodyDriveLinks(p.body).length,
          )
          .map((p) => p.threadId!),
      ]);
      if (input.threadIds === undefined && known.size > 20)
        throw new AppError(
          "TIEBA_POST_STATS_BATCH",
          "已有超过20个资源帖，请每次勾选最多20帖刷新；不会只读取部分后冒充全部完成。",
        );
      const ids = input.threadIds ?? [...known];
      if (ids.some((id) => !known.has(id)))
        throw new AppError(
          "TIEBA_POST_STATS_SOURCE",
          "请先扫描或导入本人官网帖子，再刷新原记录。",
        );
      const refreshResult = await this.readMany(account.id, ids, uid);
      return { ...this.snapshot(), busy: false, refreshResult };
    });
  }
  async importThread(raw: z.infer<typeof tiebaPostStatsImportSchema>) {
    const input = tiebaPostStatsImportSchema.parse(raw);
    const threadId = tiebaThreadIdFromUrl(input.url);
    if (!threadId)
      throw new AppError(
        "TIEBA_POST_STATS_URL",
        "请填写贴吧官网HTTPS主题链接，例如 https://tieba.baidu.com/p/123456 。",
      );
    const uid = this.account(input.accountId).uid!;
    return this.operation(async () => ({
      ...this.snapshotAfterRead(
        await this.readMany(input.accountId, [threadId], uid),
      ),
    }));
  }
  private snapshotAfterRead(
    refreshResult: NonNullable<TiebaPostStatsSnapshot["refreshResult"]>,
  ) {
    return { ...this.snapshot(), busy: false, refreshResult };
  }
  async discover(raw: z.input<typeof tiebaPostStatsDiscoverSchema>) {
    const input = tiebaPostStatsDiscoverSchema.parse(raw);
    const uid = this.account(input.accountId).uid!;
    return this.operation(async () => {
      const list = await this.queued(
        input.accountId,
        "扫描本人官网主题列表",
        (uid) =>
          this.browser().listOwnThreads(
            this.account(input.accountId, uid),
            uid,
            input.page,
          ),
      );
      this.alive();
      this.account(input.accountId, uid);
      if (
        list.threadIds.length > 20 ||
        list.threadIds.some((id) => !/^[1-9]\d{0,19}$/.test(id)) ||
        (list.nextPage !== null && list.nextPage !== input.page + 1)
      )
        throw new AppError(
          "TIEBA_POST_STATS_LIST",
          "官网本人帖子分页无法核实，原记录保留。",
        );
      const refreshResult = await this.readMany(
        input.accountId,
        list.threadIds,
        uid,
      );
      return {
        ...this.snapshotAfterRead(refreshResult),
        discoveryResult: {
          found: list.threadIds.length,
          nextPage: list.nextPage,
          message: list.threadIds.length
            ? `已读取官网第${input.page}页${list.threadIds.length}个本人主题，只有正文包含网盘链接的帖子纳入统计。`
            : "官网当前本人帖子列表为空，尚无可纳入统计的资源帖。",
        },
      };
    });
  }
  dispose() {
    this.closed = true;
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
  }
}

import {
  unsupportedStatisticsProviders,
  providerStatisticsNotes,
} from "../shared/providers";
import { z } from "zod";
import { providerSchema } from "../shared/schemas";
import { providers } from "../shared/platforms";
import type { Account } from "../shared/types";
import {
  metricNames,
  metricLabels,
  formatShareMetric,
  shareMetricDelta,
  shareStateLabels,
  type ProviderShareStatistic,
  type ShareStatistic,
  type ShareStatsFilter,
  type ShareStatsResult,
  type ShareStatsSync,
  type ShareStatsRefreshResult,
  type ShareMetrics,
  type MetricTotal,
} from "../shared/share-statistics";
import type { DriveProvider } from "./providers/provider";
import { Repository } from "./repository";
import { parseJson } from "./database";
import { AppError, safeMessage } from "./errors";
import { csv } from "./csv";

export const shareStatsFilterSchema = z.object({
  provider: providerSchema.optional(),
  accountId: z.string().min(1).max(100).optional(),
  query: z.string().trim().max(200).default(""),
  scope: z.enum(["all", "managed"]).default("all"),
  state: z
    .enum(["all", "active", "expired", "unavailable", "unknown", "missing"])
    .default("all"),
  sort: z.enum(["views", "saves", "downloads", "createdAt"]).default("views"),
  page: z.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(50),
});
type Authenticate = <T>(
  accountId: string,
  fn: (account: Account, provider: DriveProvider) => Promise<T>,
) => Promise<T>;
type Stored = {
  account_id: string;
  share_id: string;
  owner_uid: string;
  data: string;
  synced_at: string;
  present: number;
  previous_metrics: string | null;
  previous_at: string | null;
};

export class ShareStatisticsService {
  private pending = new Map<string, Promise<ShareStatsRefreshResult>>();
  private readers = 0;
  private waiting: (() => void)[] = [];
  get isBusy() {
    return this.pending.size > 0;
  }
  constructor(
    private repo: Repository,
    private authenticate: Authenticate,
    private changed: () => void,
  ) {
    this.repo.db.run(
      "UPDATE share_statistics_syncs SET status='failed',error='上次同步中断，保留之前的数据，请重新同步。' WHERE status='running'",
    );
  }
  private get db() {
    return this.repo.db;
  }
  syncs(): ShareStatsSync[] {
    const rows = new Map(
      this.db
        .all<{
          account_id: string;
          status: ShareStatsSync["status"];
          attempted_at: string | null;
          succeeded_at: string | null;
          share_count: number;
          error: string | null;
        }>("SELECT * FROM share_statistics_syncs")
        .map((r) => [r.account_id, r]),
    );
    return this.repo.accounts().map((a) => {
      const row = rows.get(a.id);
      return {
        accountId: a.id,
        status: row?.status ?? "never",
        attemptedAt: row?.attempted_at ?? null,
        succeededAt: row?.succeeded_at ?? null,
        count: row?.share_count ?? 0,
        error: row?.error ?? null,
      };
    });
  }
  async refresh(accountIds?: string[]): Promise<ShareStatsRefreshResult[]> {
    const ids = accountIds
      ? [...new Set(accountIds)]
      : this.repo
          .accounts()
          .filter((a) => a.enabled && a.uid)
          .map((a) => a.id);
    if (!ids.length)
      throw new AppError("ACCOUNT_REQUIRED", "请先添加并核验一个网盘账号。");
    // Validate the whole selection before starting any network request.
    for (const id of ids) this.repo.getAccount(id);
    const results = new Array<ShareStatsRefreshResult>(ids.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(2, ids.length) }, async () => {
        while (next < ids.length) {
          const index = next++;
          results[index] = await this.refreshAccount(ids[index]);
        }
      }),
    );
    return results;
  }
  private refreshAccount(accountId: string) {
    const existing = this.pending.get(accountId);
    if (existing) return existing;
    const result = this.withReader(() => this.collect(accountId)).finally(() =>
      this.pending.delete(accountId),
    );
    this.pending.set(accountId, result);
    return result;
  }
  private async withReader<T>(read: () => Promise<T>): Promise<T> {
    if (this.readers >= 2)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.readers++;
    try {
      return await read();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.readers--;
    }
  }
  private async collect(accountId: string): Promise<ShareStatsRefreshResult> {
    const account = this.repo.getAccount(accountId);
    const skipped = (message: string): ShareStatsRefreshResult => ({
      accountId,
      status: "skipped",
      count: 0,
      message,
    });
    if (unsupportedStatisticsProviders.includes(account.provider))
      return skipped(providerStatisticsNotes[account.provider]!);
    if (!account.enabled || !account.uid)
      return skipped("请先启用账号并核验登录。");
    const last = this.db.get<{ attempted_at: string }>(
      "SELECT attempted_at FROM share_statistics_syncs WHERE account_id=?",
      accountId,
    );
    const elapsed = last ? Date.now() - Date.parse(last.attempted_at) : NaN;
    // A restored snapshot or corrected system clock must not lock out reads
    // for hours because its saved timestamp lies in the future.
    const remaining = elapsed >= 0 ? 60_000 - elapsed : 0;
    if (remaining > 0)
      return skipped(
        `为避免频繁请求，请在${Math.ceil(remaining / 1000)}秒后重试。`,
      );
    const attemptedAt = new Date().toISOString();
    this.db.run(
      "INSERT INTO share_statistics_syncs(account_id,status,attempted_at) VALUES(?,'running',?) ON CONFLICT(account_id) DO UPDATE SET status='running',attempted_at=excluded.attempted_at,error=NULL",
      accountId,
      attemptedAt,
    );
    this.changed();
    try {
      const count = await this.authenticate(
        accountId,
        async (current, provider) => {
          if (!provider.shareStatistics)
            throw new AppError(
              "STATISTICS_UNSUPPORTED",
              "此网盘适配器尚未提供分享统计。",
            );
          const records = new Map<string, ProviderShareStatistic>();
          const cursors = new Set<string>();
          let cursor: string | undefined,
            completed = false,
            expected: number | null = null;
          for (let page = 1; page <= 100; page++) {
            const result = await provider.shareStatistics(
              current,
              page,
              cursor,
            );
            if (result.total != null) expected = result.total;
            const before = records.size;
            for (const row of result.items) records.set(row.shareId, row);
            if (result.items.length && records.size === before)
              throw new AppError(
                "INCOMPLETE_LIST",
                "分享列表重复返回同一页，统计未更新，请稍后重试。",
              );
            if (!result.hasMore) {
              if (expected != null && records.size < expected)
                throw new AppError(
                  "INCOMPLETE_LIST",
                  "分享列表尚未完整返回，统计未更新，请稍后重试。",
                );
              completed = true;
              break;
            }
            if (!result.items.length)
              throw new AppError(
                "INCOMPLETE_LIST",
                "分享列表分页中断，统计未更新。",
              );
            if (result.nextCursor) {
              if (cursors.has(result.nextCursor))
                throw new AppError(
                  "INCOMPLETE_LIST",
                  "分享列表分页游标重复，统计未更新。",
                );
              cursors.add(result.nextCursor);
            }
            cursor = result.nextCursor;
          }
          if (!completed)
            throw new AppError(
              "STATISTICS_LIST_LIMIT",
              "本次分享记录超过100页读取上限，未更新统计，保留之前的数据。",
            );
          // The isolated login window can be changed manually while a read is in flight.
          const identity = await provider.identity(current);
          if (
            identity.uid !== current.uid ||
            this.repo.getAccount(accountId).uid !== current.uid
          )
            throw new AppError(
              "ACCOUNT_UID_MISMATCH",
              "同步期间账号身份变化，统计未更新，请登录原账号。",
            );
          const syncedAt = new Date().toISOString();
          this.db.transaction(() => {
            this.db.run(
              "UPDATE share_statistics SET present=0 WHERE account_id=?",
              accountId,
            );
            for (const row of records.values()) {
              const old = this.db.get<Stored>(
                "SELECT * FROM share_statistics WHERE account_id=? AND share_id=?",
                accountId,
                row.shareId,
              );
              const previous =
                old && old.owner_uid === current.uid
                  ? parseJson<ProviderShareStatistic | null>(old.data, null)
                  : null;
              this.db.run(
                "INSERT INTO share_statistics(account_id,share_id,owner_uid,data,synced_at,present,previous_metrics,previous_at) VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(account_id,share_id) DO UPDATE SET owner_uid=excluded.owner_uid,data=excluded.data,synced_at=excluded.synced_at,present=1,previous_metrics=excluded.previous_metrics,previous_at=excluded.previous_at",
                accountId,
                row.shareId,
                current.uid!,
                JSON.stringify(row),
                syncedAt,
                previous ? JSON.stringify(previous.metrics) : null,
                previous ? old!.synced_at : null,
              );
            }
            this.db.run(
              "UPDATE share_statistics_syncs SET status='success',succeeded_at=?,share_count=?,error=NULL WHERE account_id=?",
              syncedAt,
              records.size,
              accountId,
            );
          });
          return records.size;
        },
      );
      return {
        accountId,
        status: "success",
        count,
        message: `已同步${count}个本人分享。`,
      };
    } catch (error) {
      const message = safeMessage(error);
      this.db.run(
        "UPDATE share_statistics_syncs SET status='failed',error=? WHERE account_id=?",
        message,
        accountId,
      );
      return { accountId, status: "failed", count: 0, message };
    } finally {
      this.changed();
    }
  }
  private matching(filter: ShareStatsFilter): ShareStatistic[] {
    const accounts = new Map(this.repo.accounts().map((a) => [a.id, a]));
    const targets = this.db.all<{
      account_id: string;
      share_id: string;
      owner_uid: string;
      resource_id: string;
      copy_id: string;
      split_item_id: string | null;
      resource_title: string;
      target_path: string;
    }>(`
      SELECT c.account_id,c.share_id,c.share_owner_uid owner_uid,r.id resource_id,c.id copy_id,NULL split_item_id,r.title resource_title,c.directory target_path FROM copies c JOIN resources r ON r.id=c.resource_id WHERE c.share_id IS NOT NULL
      UNION ALL SELECT c.account_id,i.share_id,i.owner_uid,r.id,c.id,i.id,r.title,i.path FROM split_items i JOIN copies c ON c.id=i.copy_id JOIN resources r ON r.id=c.resource_id WHERE i.share_id IS NOT NULL
    `);
    const targetMap = new Map(
      targets.map((t) => [
        JSON.stringify([t.account_id, t.owner_uid, t.share_id]),
        t,
      ]),
    );
    const conditions = ["s.owner_uid=a.uid"],
      values: string[] = [];
    if (filter.provider) {
      conditions.push("a.provider=?");
      values.push(filter.provider);
    }
    if (filter.accountId) {
      conditions.push("s.account_id=?");
      values.push(filter.accountId);
    }
    const rows = this.db.all<Stored>(
      `SELECT s.* FROM share_statistics s JOIN accounts a ON a.id=s.account_id WHERE ${conditions.join(" AND ")}`,
      ...values,
    );
    const query = filter.query.toLocaleLowerCase();
    const items: ShareStatistic[] = [];
    for (const row of rows) {
      const data = parseJson<ProviderShareStatistic | null>(row.data, null);
      if (!data) continue;
      const account = accounts.get(row.account_id)!;
      const target = targetMap.get(
        JSON.stringify([row.account_id, row.owner_uid, row.share_id]),
      );
      if (filter.scope === "managed" && !target) continue;
      if (
        filter.state === "missing"
          ? !!row.present
          : !row.present ||
            (filter.state !== "all" && data.state !== filter.state)
      )
        continue;
      if (
        query &&
        ![
          data.title,
          data.url,
          data.shareId,
          account.alias,
          target?.resource_title,
          target?.target_path,
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query)
      )
        continue;
      items.push({
        ...data,
        accountId: row.account_id,
        accountAlias: account.alias,
        provider: account.provider,
        ownerUid: row.owner_uid,
        present: !!row.present,
        syncedAt: row.synced_at,
        previousAt: row.previous_at,
        previousMetrics: parseJson<ShareMetrics | null>(
          row.previous_metrics,
          null,
        ),
        resourceId: target?.resource_id ?? null,
        copyId: target?.copy_id ?? null,
        splitItemId: target?.split_item_id ?? null,
        resourceTitle: target?.resource_title ?? null,
        targetPath: target?.target_path ?? null,
      });
    }
    return items.sort((a, b) => {
      const av =
        filter.sort === "createdAt"
          ? a.createdAt
            ? Date.parse(a.createdAt)
            : null
          : a.metrics[filter.sort].value;
      const bv =
        filter.sort === "createdAt"
          ? b.createdAt
            ? Date.parse(b.createdAt)
            : null
          : b.metrics[filter.sort].value;
      return av == null && bv != null
        ? 1
        : bv == null && av != null
          ? -1
          : (bv ?? 0) - (av ?? 0) ||
            a.accountId.localeCompare(b.accountId) ||
            a.shareId.localeCompare(b.shareId);
    });
  }
  list(filter: ShareStatsFilter): ShareStatsResult {
    const records = this.matching(filter);
    const summary = Object.fromEntries(
      metricNames.map((name) => {
        const known = records.filter((r) => r.metrics[name].value != null);
        const sum = known.reduce((n, r) => n + r.metrics[name].value!, 0);
        const total: MetricTotal = {
          value: known.length && Number.isSafeInteger(sum) ? sum : null,
          atLeast: known.some((r) => r.metrics[name].precision === "at_least"),
          known: known.length,
          unknown: records.length - known.length,
        };
        return [name, total];
      }),
    ) as ShareStatsResult["summary"];
    const page = Math.min(
      filter.page,
      Math.max(1, Math.ceil(records.length / filter.pageSize)),
    );
    return {
      items: records.slice(
        (page - 1) * filter.pageSize,
        page * filter.pageSize,
      ),
      total: records.length,
      page,
      pageSize: filter.pageSize,
      summary,
      syncs: this.syncs(),
    };
  }
  export(filter: ShareStatsFilter): string {
    return csv([
      [
        "网盘",
        "账号",
        "分享ID",
        "分享标题",
        "分享链接（不含提取码）",
        "状态",
        "关联资料",
        "资料路径",
        ...metricNames.flatMap((n) => [
          metricLabels[n],
          `${metricLabels[n]}口径`,
          `${metricLabels[n]}较上次同步新增`,
        ]),
        "分享时间UTC",
        "本次同步UTC",
        "上次同步UTC",
      ],
      ...this.matching(filter).map((r) => [
        providers[r.provider],
        r.accountAlias,
        r.shareId,
        r.title,
        r.url,
        r.present ? shareStateLabels[r.state] : "已不在分享列表（历史值）",
        r.resourceTitle,
        r.targetPath,
        ...metricNames.flatMap((n) => [
          formatShareMetric(r.metrics[n]),
          r.metrics[n].precision === "exact"
            ? "精确返回值"
            : r.metrics[n].precision === "at_least"
              ? "已知下限"
              : "未返回",
          shareMetricDelta(r.metrics[n], r.previousMetrics?.[n]),
        ]),
        r.createdAt,
        r.syncedAt,
        r.previousAt,
      ]),
    ]);
  }
}

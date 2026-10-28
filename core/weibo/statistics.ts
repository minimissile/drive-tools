import { createHash } from "node:crypto";
import { Database, id, now } from "../database";
import type { WebsiteAccounts } from "../website-accounts";
import type { AppPorts } from "../ports";
import { AppError } from "../errors";
import {
  weiboReceiptUrl,
  type WeiboMarketingRun,
} from "../../shared/weibo-marketing";
import type { WeiboPost } from "../../shared/weibo-posts";
import {
  weiboStatisticsReading,
  weiboStatisticsSample,
  type WeiboStatisticsSample,
  type WeiboStatisticsTarget,
} from "../../shared/weibo-statistics";

const prefix = "weiboStats:v1:";
export class WeiboStatistics {
  constructor(
    private deps: {
      db: Database;
      accounts: WebsiteAccounts;
      ports: AppPorts;
      changed(): void;
      posts(accountId: string): WeiboPost[];
      marketing(): WeiboMarketingRun[];
    },
  ) {}
  private target(accountId: string, raw: string) {
    const account = this.deps.accounts.get(accountId);
    if (account.provider !== "weibo" || !account.uid)
      throw new AppError(
        "WEIBO_IDENTITY_REQUIRED",
        "请先检查此微博账号的登录身份。",
      );
    return { account, url: weiboReceiptUrl(raw, account.uid) };
  }
  private key(accountId: string, url: string) {
    return (
      prefix + createHash("sha256").update(`${accountId}\0${url}`).digest("hex")
    );
  }
  get(accountId: string, raw: string): WeiboStatisticsSample[] {
    const { account, url } = this.target(accountId, raw);
    const saved = this.deps.db.setting<unknown>(this.key(accountId, url), []);
    const samples = weiboStatisticsSample.array().max(30).parse(saved);
    if (
      samples.some(
        (sample) =>
          sample.accountId !== accountId ||
          sample.uid !== account.uid ||
          sample.url !== url,
      )
    )
      throw new AppError(
        "WEIBO_STATISTICS_IDENTITY",
        "本地统计归属不一致，请检查账号后重试。",
      );
    return samples;
  }
  list(accountId: string): WeiboStatisticsTarget[] {
    const account = this.deps.accounts.get(accountId);
    if (account.provider !== "weibo")
      throw new AppError("WEIBO_ACCOUNT_REQUIRED", "此账号不是微博账号。");
    const targets = new Map<string, WeiboStatisticsTarget>();
    const add = (url: string | null, text: string) => {
      if (!url || !account.uid) return;
      try {
        const normalized = weiboReceiptUrl(url, account.uid);
        targets.set(normalized, { url: normalized, text: text.slice(0, 100) });
      } catch {
        /* Ignore historical receipts for a different author. */
      }
    };
    for (const post of this.deps.posts(accountId)) add(post.url, post.text);
    for (const run of this.deps.marketing())
      if (
        run.options?.accountId === accountId ||
        run.prepared?.accountId === accountId
      )
        add(run.url, run.input.keyword);
    for (const row of this.deps.db.all<{ value: string }>(
      "SELECT value FROM settings WHERE key LIKE ?",
      `${prefix}%`,
    )) {
      const samples = weiboStatisticsSample
        .array()
        .parse(JSON.parse(row.value));
      const last = samples[0];
      if (
        last?.accountId === accountId &&
        last.uid === account.uid &&
        !targets.has(last.url)
      )
        add(last.url, "已采集的微博");
    }
    return [...targets.values()].reverse();
  }
  async refresh(accountId: string, raw: string) {
    const { account: original, url } = this.target(accountId, raw);
    return this.deps.accounts.use(
      accountId,
      "weibo",
      async (account) => {
        if (account.uid !== original.uid)
          throw new AppError(
            "WEIBO_ACCOUNT_MISMATCH",
            "微博身份已变化，请重新选择账号。",
          );
        const port = this.deps.ports.weiboStatistics;
        if (!port)
          throw new AppError(
            "WEIBO_STATISTICS_UNAVAILABLE",
            "当前桌面尚不支持微博数据读取，请等待开发后端更新后重试。",
          );
        const reading = weiboStatisticsReading.parse(
          await port.read(account, url),
        );
        if (reading.uid !== account.uid || reading.url !== url)
          throw new AppError(
            "WEIBO_STATISTICS_IDENTITY",
            "微博统计与当前账号或单条链接不一致，未保存数据。",
          );
        const sample: WeiboStatisticsSample = {
          ...reading,
          id: id("wbstats"),
          accountId,
          observedAt: now(),
          source: "weibo-page",
        };
        const samples = [sample, ...this.get(accountId, url)].slice(0, 30);
        this.deps.db.setSetting(this.key(accountId, url), samples);
        this.deps.changed();
        return samples;
      },
      "微博数据读取",
    );
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  fixture,
  TestProvider,
  removeV7,
  currentSchemaVersion,
} from "./helpers";
import { Database } from "../core/database";
import { shareStatsFilterSchema } from "../core/share-statistics";
import {
  normalizeShareStatistic,
  shareMetric,
  shareTime,
} from "../core/providers/share-statistics";
import { QuarkProvider } from "../core/providers/quark";
import { UcProvider } from "../core/providers/uc";
import { BaiduProvider } from "../core/providers/baidu";
import { XunleiProvider } from "../core/providers/xunlei";
import type { ProviderTransport } from "../core/providers/provider";
import type { Account, Provider } from "../shared/types";
import {
  shareMetricDelta,
  type ProviderShareStatsPage,
  type ProviderShareStatistic,
  type ShareStatsResult,
  type ShareStatsRefreshResult,
} from "../shared/share-statistics";
import { AppError } from "../core/errors";
import { inspectBackup, stageRestore } from "../core/backups";

function record(
  shareId = "own-share",
  views: unknown = 12,
  saves: unknown = 0,
  downloads: unknown = 3,
): ProviderShareStatistic {
  return normalizeShareStatistic(
    {
      share_id: shareId,
      title: `分享 ${shareId}`,
      share_url: `https://pan.quark.cn/s/${shareId}?pwd=hide`,
      status: 1,
      click_pv: views,
      save_pv: saves,
      download_pv: downloads,
      created_at: 1730000000000,
    },
    "quark",
  );
}
class StatsProvider extends TestProvider {
  rows = [record()];
  calls: { accountId: string; page: number; cursor?: string }[] = [];
  forcedUid: string | null = null;
  fetch?: (
    account: Account,
    page: number,
    cursor?: string,
  ) => Promise<ProviderShareStatsPage>;
  override async identity(account: Account) {
    return {
      uid: this.forcedUid ?? account.uid ?? this.uid,
      nickname: "测试本人",
    };
  }
  async shareStatistics(
    account: Account,
    page: number,
    cursor?: string,
  ): Promise<ProviderShareStatsPage> {
    this.calls.push({ accountId: account.id, page, cursor });
    return this.fetch
      ? this.fetch(account, page, cursor)
      : { items: this.rows, hasMore: false, total: this.rows.length };
  }
}
async function setup() {
  const provider = new StatsProvider();
  const f = await fixture({
    quark: provider,
    baidu: provider,
    uc: provider,
    xunlei: provider,
  });
  const refresh = (accountIds = [f.account.id]) =>
    f.app.invoke("shareStats.refresh", { accountIds }) as Promise<
      ShareStatsRefreshResult[]
    >;
  const list = (filter: Record<string, unknown> = {}) =>
    f.app.invoke("shareStats.list", filter) as Promise<ShareStatsResult>;
  const allowRefresh = () =>
    f.app.db.run(
      "UPDATE share_statistics_syncs SET attempted_at='1970-01-01T00:00:00.000Z'",
    );
  return { ...f, statsProvider: provider, refresh, list, allowRefresh };
}

test("统计字段保留真实0、未知、受限值；不接受空串、布尔、负数、精度溢出", () => {
  for (const raw of [
    undefined,
    null,
    "",
    "  ",
    false,
    true,
    -1,
    "-1",
    1.2,
    "1.2",
    "NaN",
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.equal(shareMetric(raw).value, null, String(raw));
  assert.deepEqual(shareMetric("0"), { value: 0, precision: "exact" });
  assert.equal(shareMetric("100+").precision, "at_least");
  assert.equal(shareMetric("100+").value, 100);
  const q = normalizeShareStatistic(
    {
      share_id: "q",
      click_pv: "22",
      save_pv: 0,
      download_pv: "8",
      download_pvlimited: true,
      share_url: "https://pan.quark.cn/s/abc?pwd=secret",
    },
    "quark",
  );
  assert.equal(q.url, "https://pan.quark.cn/s/abc");
  assert.equal(q.metrics.downloads.precision, "at_least");
  const x = normalizeShareStatistic(
    { share_id: "x", view_count: "-1" },
    "xunlei",
  );
  assert.deepEqual(
    [x.metrics.views.value, x.metrics.views.precision, x.metrics.saves.value],
    [100, "at_least", null],
  );
  assert.equal(
    normalizeShareStatistic({ share_id: "x", view_count: 175 }, "xunlei")
      .metrics.views.value,
    175,
  );
  assert.equal(
    normalizeShareStatistic(
      { share_id: "q", share_url: "https://pan.quark.cn.evil.invalid/s/a" },
      "quark",
    ).url,
    null,
  );
  assert.equal(
    normalizeShareStatistic({ share_id: "q", pwd_id: "abc123" }, "uc").url,
    "https://drive.uc.cn/s/abc123",
  );
  assert.throws(() => normalizeShareStatistic({}, "uc"), /分享ID/);
  assert.throws(
    () =>
      normalizeShareStatistic(
        { share_id: Number.MAX_SAFE_INTEGER + 1 },
        "quark",
      ),
    /分享ID/,
  );
  assert.equal(
    normalizeShareStatistic(
      { shareId: 123, typicalPath: "/资料/安装指南" },
      "baidu",
    ).title,
    "安装指南",
  );
  assert.equal(shareTime(1730000000), shareTime(1730000000000));
  assert.equal(shareTime("bad date"), null);
  assert.equal(shareMetricDelta(shareMetric(5), shareMetric(10)), null);
  assert.equal(shareMetricDelta(shareMetric("100+"), shareMetric(90)), null);
});

for (const kind of ["quark", "uc", "baidu", "xunlei"] as Provider[]) {
  test(`${kind}：使用现有隔离账号只读接口，提取真实统计字段及分页信息`, async () => {
    const requests: { url: URL; method: string }[] = [];
    const transport: ProviderTransport = {
      text: async () => {
        throw new Error("不应打开公开分享页");
      },
      authHeaders: async () => ({ authorization: "Bearer test-only" }),
      json: async (_id, text, init) => {
        const url = new URL(text);
        requests.push({ url, method: init?.method ?? "GET" });
        const row =
          kind === "baidu"
            ? {
                shareId: "bd",
                title: "百度分享",
                shortlink: "https://pan.baidu.com/s/1abc",
                vCnt: "19",
                tCnt: "0",
                dCnt: 2,
                status: 0,
              }
            : kind === "xunlei"
              ? {
                  share_id: "xl",
                  share_url: "https://pan.xunlei.com/s/abc",
                  view_count: 20,
                  restore_count: 4,
                  share_status: "OK",
                }
              : {
                  share_id: "q",
                  title: "云盘分享",
                  click_pv: 7,
                  save_pv: 3,
                  download_pv: 0,
                  status: 1,
                };
        return kind === "baidu"
          ? { errno: 0, list: [row], total: 1 }
          : kind === "xunlei"
            ? { data: [row], next_page_token: "next" }
            : {
                code: 0,
                status: 200,
                data: { list: [row] },
                metadata: { _total: 1 },
              };
      },
    };
    const provider =
      kind === "quark"
        ? new QuarkProvider(transport)
        : kind === "uc"
          ? new UcProvider(transport)
          : kind === "baidu"
            ? new BaiduProvider(transport)
            : new XunleiProvider(transport);
    const account = { id: "isolated-account", provider: kind } as Account;
    const page: ProviderShareStatsPage = await provider.shareStatistics(
      account,
      1,
      "before",
    );
    assert.equal(page.items.length, 1);
    assert.equal(
      page.items[0].metrics.views.value,
      kind === "baidu" ? 19 : kind === "xunlei" ? 20 : 7,
    );
    assert.equal(
      page.items[0].metrics.saves.value,
      kind === "baidu" ? 0 : kind === "xunlei" ? 4 : 3,
    );
    assert.equal(
      page.items[0].metrics.downloads.value,
      kind === "xunlei" ? null : kind === "baidu" ? 2 : 0,
    );
    assert.equal(page.items[0].state, "active");
    assert.ok(requests.every((r) => r.method === "GET"));
    assert.equal(
      requests[0].url.hostname,
      {
        quark: "drive-pc.quark.cn",
        uc: "pc-api.uc.cn",
        baidu: "pan.baidu.com",
        xunlei: "api-pan.xunlei.com",
        guangya: "api.guangyapan.com",
        pikpak: "api-drive.mypikpak.com",
      }[kind],
    );
    assert.equal(page.hasMore, kind === "xunlei");
    if (kind === "xunlei") assert.equal(page.nextCursor, "next");
  });
}

test("同步完整列表、统计全筛选而非当前页、增量只比较快照，导出无提取码且防CSV公式", async () => {
  const f = await setup();
  try {
    const p = f.statsProvider;
    p.rows = Array.from({ length: 55 }, (_, i) =>
      record(`s-${i}`, i === 54 ? null : i, i === 0 ? 0 : null),
    );
    p.rows[0].title = "=HYPERLINK(危险)";
    p.fetch = async (_account, page) => ({
      items: p.rows.slice((page - 1) * 30, page * 30),
      hasMore: page === 1,
      total: 55,
    });
    assert.equal((await f.refresh())[0].status, "success");
    assert.deepEqual(
      p.calls.map((c) => c.page),
      [1, 2],
    );
    const first = await f.list({ pageSize: 10 });
    assert.equal(first.items.length, 10);
    assert.equal(first.total, 55);
    assert.deepEqual(
      [
        first.summary.views.known,
        first.summary.views.unknown,
        first.summary.views.value,
      ],
      [54, 1, 1431],
    );
    assert.equal(
      (await f.list({ query: "HYPERLINK" })).items[0].previousMetrics,
      null,
    );
    let exported = "";
    f.ports.saveFile = async (_name, bytes) => {
      exported = bytes.toString();
      return "/tmp/statistics.csv";
    };
    await f.app.invoke("shareStats.export", { pageSize: 10 });
    assert.equal(exported.split("\r\n").length, 57);
    assert.ok(exported.includes("'=HYPERLINK"));
    assert.ok(!exported.includes("pwd="));
    assert.ok(!exported.includes("Bearer"));
    assert.ok(exported.includes("未返回"));
    f.allowRefresh();
    p.rows[0].metrics.views = shareMetric(8);
    p.rows[1].metrics.views = shareMetric(0);
    p.rows[2].metrics.views = shareMetric("100+");
    await f.refresh();
    const changed = await f.list({ query: "HYPERLINK" });
    assert.equal(
      shareMetricDelta(
        changed.items[0].metrics.views,
        changed.items[0].previousMetrics!.views,
      ),
      8,
    );
    const all = await f.list({ pageSize: 100 });
    assert.equal(
      shareMetricDelta(
        all.items.find((r) => r.shareId === "s-1")!.metrics.views,
        all.items.find((r) => r.shareId === "s-1")!.previousMetrics!.views,
      ),
      null,
    );
    assert.equal(all.summary.views.atLeast, true);
    assert.equal(f.provider.transfers, 0);
    assert.equal(f.provider.shares, 0);
  } finally {
    await f.cleanup();
  }
});

test("分页中断、游标重复、身份变化均不覆盖成功快照；完整空列表保留消失链接历史", async () => {
  const f = await setup();
  try {
    await f.refresh();
    const initial = (await f.list()).items[0];
    for (const mode of [
      "error",
      "repeated",
      "cursor",
      "identity",
      "incomplete",
    ] as const) {
      f.allowRefresh();
      f.statsProvider.fetch = async (_a, page) => {
        if (mode === "identity") {
          f.statsProvider.forcedUid = "other-owner";
          return { items: [record("changed", 1000)], hasMore: false, total: 1 };
        }
        if (mode === "error" && page === 2)
          throw new AppError("REMOTE_ERROR", "网络失败");
        if (mode === "incomplete")
          return { items: [record("new")], hasMore: false, total: 2 };
        return {
          items: [record(mode === "repeated" ? "repeat" : `new-${page}`)],
          hasMore: true,
          total: null,
          ...(mode === "cursor" ? { nextCursor: "repeated-cursor" } : {}),
        };
      };
      assert.equal((await f.refresh())[0].status, "failed", mode);
      f.statsProvider.forcedUid = null;
      const old = await f.list();
      assert.equal(old.items.length, 1);
      assert.equal(old.items[0].shareId, initial.shareId);
      assert.equal(old.items[0].syncedAt, initial.syncedAt);
      assert.equal(old.syncs[0].status, "failed");
    }
    f.allowRefresh();
    f.statsProvider.fetch = async () => ({
      items: [],
      hasMore: false,
      total: 0,
    });
    assert.equal((await f.refresh())[0].status, "success");
    assert.equal((await f.list()).total, 0);
    const historical = await f.list({ state: "missing" });
    assert.equal(historical.items.length, 1);
    assert.equal(historical.items[0].metrics.views.value, 12);
    assert.equal(historical.items[0].present, false);
  } finally {
    await f.cleanup();
  }
});

test("多账号和四盘筛选、同ID隔离、整份/拆分资料关联不混用来源链接", async () => {
  const f = await setup();
  try {
    const saved = await f.add(false);
    const uid = f.app.repo.getAccount(f.account.id).uid!;
    f.app.db.run(
      "UPDATE copies SET share_id='own-share',share_url='https://pan.quark.cn/s/own-share',share_owner_uid=? WHERE id=?",
      uid,
      saved.copyId,
    );
    f.app.db.run(
      "INSERT INTO split_items(id,copy_id,file_id,file,ancestors,path,depth,status,share_id,share_url,owner_uid) VALUES('child',?,'f','{}','[]','课程 / 第一节',1,'ready','child-share','https://pan.quark.cn/s/child-share',?)",
      saved.copyId,
      uid,
    );
    f.statsProvider.rows.push(record("child-share", 9), record("source123", 7));
    const ids = [f.account.id];
    for (const provider of ["baidu", "uc", "xunlei"] as Provider[]) {
      const account = (await f.app.invoke("account.add", {
        provider,
        alias: `${provider}本人`,
      })) as Account;
      await f.app.invoke("account.check", { id: account.id });
      ids.push(account.id);
    }
    const results = await f.refresh(ids);
    assert.equal(results.filter((r) => r.status === "success").length, 4);
    assert.equal((await f.list()).total, 12);
    assert.equal((await f.list({ provider: "uc" })).total, 3);
    const managed = await f.list({ scope: "managed" });
    assert.equal(managed.total, 2);
    assert.equal(
      managed.items.find((r) => r.shareId === "own-share")!.copyId,
      saved.copyId,
    );
    assert.equal(
      managed.items.find((r) => r.shareId === "child-share")!.splitItemId,
      "child",
    );
    assert.equal((await f.list({ query: "第一节" })).total, 1);
    assert.equal((await f.list({ accountId: ids[2] })).total, 3);
    f.app.db.run("UPDATE accounts SET uid='changed' WHERE id=?", ids[2]);
    assert.equal((await f.list({ accountId: ids[2] })).total, 0);
    assert.equal((await f.list()).total, 9);
  } finally {
    await f.cleanup();
  }
});

test("重复同步合并、60秒限频、账号锁保护、同步时阻止更新与空间切换", async () => {
  const f = await setup();
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.statsProvider.fetch = async () => {
      await gate;
      return { items: [record()], hasMore: false, total: 1 };
    };
    const one = f.refresh(),
      two = f.refresh();
    assert.throws(() => f.app.assertUpdateIdle(), /任务/);
    await assert.rejects(f.app.invoke("system.previousWorkspace"), /没有/);
    f.app.db.setSetting("restorePreviousDataPath", "/tmp/previous");
    await assert.rejects(f.app.invoke("system.previousWorkspace"), /停止任务/);
    let otherEntered = false;
    const locked = f.app.authenticated(f.account.id, async () => {
      otherEntered = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(otherEntered, false);
    release();
    await Promise.all([one, two, locked]);
    assert.equal(f.statsProvider.calls.length, 1);
    assert.equal(otherEntered, true);
    assert.equal((await f.refresh())[0].status, "skipped");
    assert.equal(f.statsProvider.calls.length, 1);
    await assert.rejects(
      f.app.invoke("shareStats.refresh", {
        accountIds: [f.account.id, "does-not-exist"],
      }),
      /账号/,
    );
    f.app.db.run("UPDATE accounts SET enabled=0 WHERE id=?", f.account.id);
    f.allowRefresh();
    assert.equal((await f.refresh())[0].status, "skipped");
  } finally {
    await f.cleanup();
  }
});

test("v6升级快照、重开不重复迁移，备份恢复保留统计并明确要求重新同步", async () => {
  const f = await setup();
  try {
    const path = join(f.dir, "v6.db");
    new Database(path).close();
    const old = new DatabaseSync(path);
    old.exec(removeV7 + "PRAGMA user_version=6;");
    old.prepare("INSERT INTO settings VALUES('kept','true')").run();
    old.close();
    const db = new Database(path);
    assert.equal(db.setting("kept", false), true);
    assert.equal(
      db.get<any>("PRAGMA user_version").user_version,
      currentSchemaVersion,
    );
    db.close();
    new Database(path).close();
    const backups = (await readdir(f.dir)).filter((n) =>
      n.startsWith("v6.db.before-v7-"),
    );
    assert.equal(backups.length, 1);
    assert.equal((await stat(join(f.dir, backups[0]))).mode & 0o777, 0o600);
    const snap = new DatabaseSync(join(f.dir, backups[0]), { readOnly: true });
    assert.equal(snap.prepare("PRAGMA user_version").get()!.user_version, 6);
    snap.close();
    await f.refresh();
    f.ports.chooseDirectory = async () => f.dir;
    const folder = await f.app.backup();
    const inspected = await inspectBackup(folder!);
    const restored = await stageRestore(
      folder!,
      f.dir,
      inspected.databaseSha256,
    );
    const restoredDb = new Database(join(restored.dataPath, "panxu.db"));
    assert.equal(
      restoredDb.get<any>("SELECT COUNT(*) n FROM share_statistics").n,
      1,
    );
    assert.match(
      restoredDb.get<any>("SELECT error FROM share_statistics_syncs").error,
      /历史统计/,
    );
    assert.equal(restoredDb.get<any>("SELECT COUNT(*) n FROM secrets").n, 0);
    restoredDb.close();
  } finally {
    await f.cleanup();
  }
});

test("统计筛选IPC边界验证", () => {
  assert.equal(shareStatsFilterSchema.parse({}).pageSize, 50);
  assert.throws(() => shareStatsFilterSchema.parse({ page: 0 }));
  assert.throws(() => shareStatsFilterSchema.parse({ provider: "evil" }));
  assert.throws(() => shareStatsFilterSchema.parse({ pageSize: 10000 }));
});

test("系统时钟回调或恢复未来快照不会造成数小时同步锁定", async () => {
  const f = await setup();
  try {
    await f.refresh();
    f.app.db.run(
      "UPDATE share_statistics_syncs SET attempted_at='2099-01-01T00:00:00.000Z'",
    );
    assert.equal((await f.refresh())[0].status, "success");
  } finally {
    await f.cleanup();
  }
});

test("适配器不支持统计时明确失败，不保存虚假零值", async () => {
  const f = await fixture();
  try {
    const result = (await f.app.invoke("shareStats.refresh", {
      accountIds: [f.account.id],
    })) as ShareStatsRefreshResult[];
    assert.equal(result[0].status, "failed");
    assert.match(result[0].message, /尚未提供分享统计/);
    assert.equal(
      ((await f.app.invoke("shareStats.list", {})) as ShareStatsResult).total,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

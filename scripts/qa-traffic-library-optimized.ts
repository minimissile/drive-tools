import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { queryMethods } from "../shared/ipc";
import type { Pool, PoolSummary } from "../shared/types";
import type {
  KnowledgeDetail,
  KnowledgeFilter,
  KnowledgeHistory,
  KnowledgeItem,
  KnowledgePage,
  KnowledgeQuery,
} from "../shared/traffic-knowledge";

type FixtureItem = KnowledgeItem & { endpoint: KnowledgeFilter["endpoint"] };
type Call = { method: string; args: unknown };
interface Fixture {
  items: FixtureItem[];
  histories: Record<string, KnowledgeHistory>;
  details: Record<string, KnowledgeDetail>;
  queries: KnowledgeQuery[];
  pools: Pool[];
  readonlyMethods: string[];
  storageKey: string;
}
interface MockState {
  calls: Call[];
  copies: string[];
  saves: Record<string, unknown>[];
  exports: Call[];
  forbidden: Call[];
  failNextList: boolean;
  holdNextList: boolean;
  holdNextDetail: boolean;
  holdNextSave: boolean;
  holdResolve: boolean;
  heldResolves: Array<{
    resolve(value: unknown): void;
    result: { items: KnowledgeItem[]; missingIds: string[] };
  }>;
  held: Array<{ resolve(value: unknown): void; result: KnowledgePage }>;
  heldDetails: Array<{
    resolve(value: unknown): void;
    result: KnowledgeDetail;
  }>;
  heldSaves: Array<{
    resolve(value: unknown): void;
    result: Record<string, unknown>;
  }>;
  heldResolved: number;
  heldDetailsResolved: number;
  heldSavesResolved: number;
  latestList: KnowledgePage | null;
  releaseHeld(): void;
  releaseHeldDetails(): void;
  releaseHeldSaves(): void;
  releaseHeldResolves(): void;
}
declare global {
  interface Window {
    __qaTrafficOptimized: MockState;
    __qaTrafficInvoke(method: string, args?: unknown): Promise<unknown>;
  }
}

function makeFixture(windowId: string): Fixture {
  const items: FixtureItem[] = Array.from({ length: 125 }, (_, index) => {
    const endpoint = (
      ["baidu-discovery", "baidu-keywords", "longtail", "suggest"] as const
    )[index % 4];
    const source = {
      "baidu-discovery": "百度批量扩词",
      "baidu-keywords": "百度营销 · 关键词规划师",
      longtail: "5118 长尾词 v2",
      suggest: "5118 下拉联想词",
    }[endpoint];
    return {
      id: `qa_observation_${index}`,
      entryId: `qa_entry_${index}`,
      queryId: `qa_query_${index}`,
      word: `国画学习关键词${String(index).padStart(3, "0")}`,
      kind: "word",
      platform: index % 4 === 3 ? "douyin" : "baidu",
      source,
      endpoint,
      metrics:
        endpoint === "baidu-discovery"
          ? { averageMonthPv: 10, averageMonthPvSource: "默认值（非实测）" }
          : endpoint === "baidu-keywords"
            ? { averageMonthPv: 20 + (index % 11), recommendPrice: 1.25 }
            : endpoint === "longtail"
              ? {}
              : { douyin_index: 30 + index },
      observedAt: new Date(
        Date.UTC(2026, 10, 7, 12, 0) - index * 60000,
      ).toISOString(),
      firstObservedAt: "2026-10-31T01:00:00.000Z",
      sourceUpdatedAt: null,
      observations: index === 0 ? 25 : 3,
    };
  });
  Object.assign(items[0], { word: "竹子画法" });
  Object.assign(items[1], {
    word: "竹子画法",
    metrics: { averageMonthPv: 100, recommendPrice: 1.5 },
  });
  Object.assign(items[2], {
    word: "国画基础教程",
    endpoint: "baidu-keywords",
    source: "百度营销 · 关键词规划师",
    metrics: { averageMonthPv: 80 },
  });
  Object.assign(items[3], { word: "水墨画入门", metrics: {} });
  Object.assign(items[4], {
    word: "国画展览新动态",
    kind: "hotspot",
    endpoint: "radar",
    source: "5118 热点雷达",
    metrics: { event_hot_exp: 560 },
  });
  Object.assign(items[5], {
    word: `面向初学者的${"国画笔墨与竹叶构图分步骤练习方法".repeat(8)}课程资料整理`,
    endpoint: "baidu-discovery",
    source: "百度批量扩词",
    metrics: { averageMonthPv: 10, averageMonthPvSource: "默认值（非实测）" },
  });
  Object.assign(items[6], {
    word: "竹子绘画视频",
    platform: "douyin",
    metrics: { douyin_index: 300 },
  });
  for (const index of [29, 59, 89, 119]) {
    Object.assign(items[index], {
      kind: "hotspot",
      endpoint: "radar",
      source: "5118 热点雷达",
      metrics: { event_hot_exp: 100 + index },
    });
  }
  const queries: KnowledgeQuery[] = items.map((item) => ({
    id: item.queryId,
    endpoint: item.endpoint,
    phase: "query",
    request: { keyword: item.word, source: item.source },
    seeds: [item.word],
    platform: item.platform,
    status: "success",
    startedAt: item.observedAt,
    receivedAt: item.observedAt,
    httpStatus: 200,
    message: "已保留这次采集的来源与指标。",
    legacy: false,
    count: 1,
  }));
  const details: Record<string, KnowledgeDetail> = {};
  const histories: Record<string, KnowledgeHistory> = {};
  for (const item of items) {
    const observations = Array.from(
      { length: item.observations },
      (_, index) => {
        const queryId =
          index === 0 ? item.queryId : `${item.queryId}_history_${index}`;
        const query = {
          ...queries.find((entry) => entry.id === item.queryId)!,
          id: queryId,
          receivedAt: new Date(
            Date.parse(item.observedAt!) - index * 86400000,
          ).toISOString(),
        };
        const observation = {
          ...item,
          id: `${item.id}_history_${index}`,
          queryId,
          observedAt: query.receivedAt,
          observations: 1,
        };
        details[queryId] = {
          query,
          response: JSON.stringify(
            {
              keyword: item.word,
              metrics: item.metrics,
              origin: {
                query: item.word,
                url: "https://www.baidu.com/s?wd=竹子画法",
              },
              receipt: queryId,
              literal: '<b data-qa-raw="literal">来源字符串仅按文本显示</b>',
            },
            null,
            2,
          ),
        };
        return observation;
      },
    );
    histories[item.entryId] = {
      entry: {
        entryId: item.entryId,
        word: item.word,
        kind: item.kind,
        platform: item.platform,
        source: item.source,
      },
      items: observations,
      total: observations.length,
      page: 1,
      pageSize: 20,
    };
  }
  return {
    items,
    histories,
    details,
    queries,
    pools: [
      {
        id: "qa_existing_pool",
        name: "笔墨练习收藏",
        resourceId: null,
        createdAt: "2026-11-06T12:00:00.000Z",
        keywords: items
          .filter((item) => item.kind === "word")
          .slice(0, 65)
          .map((item) => ({
            id: item.id,
            word: item.word,
            source: item.source,
            platform: item.platform,
            metrics: item.metrics as Pool["keywords"][number]["metrics"],
            sourceUpdatedAt: item.sourceUpdatedAt,
            fetchedAt: item.observedAt!,
          })),
      },
    ],
    readonlyMethods: [...queryMethods, "dev.status"],
    storageKey: `qa-traffic-library-optimized:${windowId}`,
  };
}

// Serialized into this task's renderer only. Native preload remains untouched.
function installFixture(fixture: Fixture) {
  const original = window.panxu.invoke.bind(window.panxu);
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const previous = JSON.parse(
    sessionStorage.getItem(fixture.storageKey) ?? "null",
  ) as Partial<MockState> | null;
  const state: MockState = {
    calls: previous?.calls ?? [],
    copies: previous?.copies ?? [],
    saves: previous?.saves ?? [],
    exports: previous?.exports ?? [],
    forbidden: previous?.forbidden ?? [],
    failNextList: false,
    holdNextList: false,
    holdNextDetail: false,
    holdNextSave: false,
    holdResolve: previous?.holdResolve ?? false,
    heldResolves: [],
    held: [],
    heldDetails: [],
    heldSaves: [],
    heldResolved: 0,
    heldDetailsResolved: 0,
    heldSavesResolved: 0,
    latestList: null,
    releaseHeld() {
      for (const held of state.held.splice(0)) {
        held.resolve(clone(held.result));
        state.heldResolved++;
      }
    },
    releaseHeldDetails() {
      for (const held of state.heldDetails.splice(0)) {
        held.resolve(clone(held.result));
        state.heldDetailsResolved++;
      }
    },
    releaseHeldSaves() {
      for (const held of state.heldSaves.splice(0)) {
        held.resolve(clone(held.result));
        state.heldSavesResolved++;
      }
    },
    releaseHeldResolves() {
      state.holdResolve = false;
      for (const held of state.heldResolves.splice(0))
        held.resolve(clone(held.result));
      persist();
    },
  };
  const persist = () =>
    sessionStorage.setItem(
      fixture.storageKey,
      JSON.stringify({
        calls: state.calls,
        copies: state.copies,
        saves: state.saves,
        exports: state.exports,
        forbidden: state.forbidden,
        holdResolve: state.holdResolve,
      }),
    );
  const summary = {
    queries: fixture.queries.length,
    responses: fixture.queries.length,
    words: new Set(
      fixture.items
        .filter((item) => item.kind === "word")
        .map((item) => item.word),
    ).size,
    hotspots: fixture.items.filter((item) => item.kind === "hotspot").length,
    observations: fixture.items.reduce(
      (total, item) => total + item.observations,
      0,
    ),
    legacy: 0,
  };
  const monthly = (item: KnowledgeItem) => {
    const value = item.metrics.averageMonthPv;
    if (value === undefined || value === null || value === "") return null;
    const result =
      typeof value === "number"
        ? value
        : Number(String(value).replace(/,/g, ""));
    return Number.isFinite(result) ? result : null;
  };
  const pools = () => [
    ...fixture.pools,
    ...state.saves.map(
      (saved, index) =>
        ({
          ...saved,
          id: `qa_pool_${index + 1}`,
          createdAt: "2026-11-07T12:00:00.000Z",
        }) as unknown as Pool,
    ),
  ];
  const poolSummaries = (): PoolSummary[] =>
    pools().map(({ keywords, ...pool }) => ({
      ...pool,
      keywordCount: keywords.length,
      preview: keywords.slice(0, 5).map(({ id, word }) => ({ id, word })),
    }));
  window.__qaTrafficOptimized = state;
  window.__qaTrafficInvoke = async (method, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    state.calls.push({ method, args: clone(args) });
    persist();
    if (method === "snapshot") {
      const snapshot = (await original(method, raw)) as Record<string, unknown>;
      return { ...snapshot, pools: poolSummaries() };
    }
    if (method === "pool.list") return clone(poolSummaries());
    if (method === "pool.get") {
      const pool = pools().find((pool) => pool.id === args.id);
      if (!pool) throw new Error("词池不存在。");
      return clone(pool);
    }
    if (method === "traffic.knowledge.overview")
      return clone({ revision: 1, summary, seeds: [], patterns: [] });
    if (method === "traffic.knowledge.resolve") {
      const ids = args.observationIds as string[];
      const result = {
        items: fixture.items.filter((item) => ids.includes(item.id)),
        missingIds: ids.filter(
          (id) => !fixture.items.some((item) => item.id === id),
        ),
      };
      if (state.holdResolve)
        return new Promise((resolve) =>
          state.heldResolves.push({ resolve, result }),
        );
      return clone(result);
    }
    if (method === "traffic.knowledge.list") {
      if (state.failNextList) {
        state.failNextList = false;
        throw new Error("本地词库读取暂不可用，请重试。");
      }
      const filter = {
        search: "",
        endpoint: "",
        platform: "",
        page: 1,
        view: "items",
        kind: "",
        sort: "recent",
        volume: "",
        cursor: null,
        ...args,
      } as KnowledgeFilter;
      const search = filter.search.toLocaleLowerCase();
      let matched = fixture.items.filter(
        (item) =>
          (!search || item.word.toLocaleLowerCase().includes(search)) &&
          (!filter.endpoint || item.endpoint === filter.endpoint) &&
          (!filter.platform || item.platform === filter.platform) &&
          (!filter.kind ||
            (filter.kind === "longtail"
              ? item.kind === "word" &&
                ["longtail", "baidu-discovery"].includes(item.endpoint)
              : item.kind === filter.kind)) &&
          (!filter.volume ||
            (filter.volume === "default"
              ? item.metrics.averageMonthPvSource === "默认值（非实测）"
              : filter.volume === "measured"
                ? monthly(item) !== null &&
                  item.metrics.averageMonthPvSource !== "默认值（非实测）"
                : monthly(item) === null)),
      );
      matched = [...matched].sort((left, right) =>
        filter.sort === "monthly"
          ? (monthly(right) ?? -1) - (monthly(left) ?? -1) ||
            left.entryId.localeCompare(right.entryId)
          : filter.sort === "word"
            ? left.word.localeCompare(right.word, "zh-CN") ||
              left.entryId.localeCompare(right.entryId)
            : String(right.observedAt).localeCompare(String(left.observedAt)),
      );
      const pageSize = filter.view === "queries" ? 20 : 50;
      const signature = JSON.stringify([
        filter.search,
        filter.endpoint,
        filter.platform,
        filter.kind,
        filter.sort,
        filter.volume,
      ]);
      let offset = (filter.page - 1) * pageSize;
      if (filter.view === "items") {
        if (filter.page === 1) {
          if (filter.cursor !== null)
            throw new Error("词库首页必须显式使用空游标。");
          offset = 0;
        } else {
          if (!filter.cursor?.startsWith("qa_cursor:"))
            throw new Error("词库下一页必须使用上一页返回的游标。");
          const cursor = JSON.parse(
            decodeURIComponent(filter.cursor.slice(10)),
          ) as { signature: string; offset: number };
          if (cursor.signature !== signature || cursor.offset !== offset)
            throw new Error(
              "筛选或排序改变后必须重置游标，返回上一页必须恢复对应游标。",
            );
          offset = cursor.offset;
        }
      }
      const queryIds = new Set(matched.map((item) => item.queryId));
      const queries = fixture.queries.filter((query) => queryIds.has(query.id));
      const result: KnowledgePage = {
        total: filter.view === "queries" ? queries.length : matched.length,
        page: filter.page,
        pageSize,
        items:
          filter.view === "items"
            ? matched
                .slice(offset, offset + pageSize)
                .map(({ endpoint: _endpoint, ...item }) => item)
            : [],
        queries:
          filter.view === "queries"
            ? queries.slice(
                (filter.page - 1) * pageSize,
                filter.page * pageSize,
              )
            : [],
        nextCursor:
          filter.view === "items" && offset + pageSize < matched.length
            ? `qa_cursor:${encodeURIComponent(JSON.stringify({ signature, offset: offset + pageSize }))}`
            : null,
      };
      if (filter.view === "items") state.latestList = clone(result);
      if (state.holdNextList && filter.view === "items") {
        state.holdNextList = false;
        return new Promise((resolve) => state.held.push({ resolve, result }));
      }
      return clone(result);
    }
    if (method === "traffic.knowledge.history") {
      const history = fixture.histories[String(args.entryId)];
      if (!history) throw new Error("词条历史不存在。");
      const page = Number(args.page ?? 1);
      return clone({
        ...history,
        page,
        items: history.items.slice(
          (page - 1) * history.pageSize,
          page * history.pageSize,
        ),
      });
    }
    if (method === "traffic.knowledge.detail") {
      const detail = fixture.details[String(args.id)];
      if (!detail) throw new Error("来源档案不存在。");
      if (state.holdNextDetail) {
        state.holdNextDetail = false;
        return new Promise((resolve) =>
          state.heldDetails.push({ resolve, result: detail }),
        );
      }
      return clone(detail);
    }
    if (method === "system.copyText") {
      state.copies.push(String(args.text));
      persist();
      return true;
    }
    if (method === "pool.save") {
      state.saves.push(clone(args));
      persist();
      const saved = {
        ...args,
        id: `qa_pool_${state.saves.length}`,
        createdAt: "2026-11-07T12:00:00.000Z",
      };
      if (state.holdNextSave) {
        state.holdNextSave = false;
        return new Promise((resolve) =>
          state.heldSaves.push({ resolve, result: saved }),
        );
      }
      return clone(saved);
    }
    if (
      method === "traffic.knowledge.export" ||
      method === "traffic.knowledge.exportQuery"
    ) {
      state.exports.push({ method, args: clone(args) });
      persist();
      return method.endsWith("exportQuery")
        ? "/tmp/traffic-source-fixture.json"
        : "/tmp/traffic-history-fixture.csv";
    }
    if (
      fixture.readonlyMethods.includes(method) &&
      !method.startsWith("traffic.knowledge.") &&
      !method.startsWith("pool.")
    )
      return original(method, raw);
    // Fail closed for an unexpected mutation: no test action can reach a paid,
    // clipboard, publication, share, login, or other real business write.
    state.forbidden.push({ method, args: clone(args) });
    persist();
    throw new Error(`本窗口验收不允许真实业务变更：${method}`);
  };
}

/** Run only through test:session. This exercises the actual UI with a page-local
 * transport fixture; it does not verify a staged database migration or backend. */
export async function run({ page, checkpoint, windowId }: any) {
  console.log(JSON.stringify({ qaWindowId: windowId }));
  const output = "/tmp/panxu-traffic-library-optimized-qa";
  await mkdir(output, { recursive: true });
  const fixture = makeFixture(windowId);
  const routePattern = "**/src/api/client.ts*";
  let rewrittenModules = 0;
  const routeHandler = async (route: any) => {
    if (new URL(route.request().url()).pathname !== "/src/api/client.ts")
      return route.continue();
    const response = await route.fetch();
    const body = await response.text();
    const matches = body.match(/window\.panxu\.invoke\(/g) ?? [];
    assert.equal(
      matches.length,
      1,
      "只替换此页面client模块的一处IPC调用，源码不匹配时停止",
    );
    rewrittenModules++;
    await route.fulfill({
      response,
      body: body.replace("window.panxu.invoke(", "window.__qaTrafficInvoke("),
    });
  };
  const errors: string[] = [];
  const consoleMessages: string[] = [];
  const screenshots: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  page.on("console", (message: any) => {
    if (["error", "warning"].includes(message.type()))
      consoleMessages.push(`${message.type()}: ${message.text()}`);
  });
  const capture = async (name: string) => {
    const path = join(output, name);
    await page.screenshot({ path });
    screenshots.push(path);
  };
  const calls = async (method: string) =>
    page.evaluate(
      (name: string) =>
        window.__qaTrafficOptimized.calls.filter(
          (call) => call.method === name,
        ),
      method,
    );
  const selectOption = async (label: string, name: string) => {
    await page.getByLabel(label, { exact: true }).click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  const table = () =>
    page.getByRole("table", { name: "词库列表", exact: true });
  const rows = () => table().locator("tbody tr");
  const batch = () => page.locator('[aria-label="词库批量操作"]');
  const search = async (word: string) => {
    await page.getByLabel("搜索词库", { exact: true }).fill(word);
    await page.getByRole("button", { name: "搜索", exact: true }).click();
  };
  const waitRows = async (count: number) => {
    await page.waitForFunction((expected: number) => {
      const target = document.querySelector('table[aria-label="词库列表"]');
      return (
        target?.getAttribute("aria-busy") === "false" &&
        target.querySelectorAll("tbody tr").length === expected
      );
    }, count);
  };
  try {
    await page.route(routePattern, routeHandler);
    await page.addInitScript(
      `window.__name = fn => fn;(${installFixture.toString()})(${JSON.stringify(fixture)});`,
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    const tabs = page.getByRole("tablist", {
      name: "流量词库功能",
      exact: true,
    });
    await tabs.getByRole("tab", { name: "关键词库", exact: true }).waitFor();
    assert.equal(
      await tabs
        .getByRole("tab", { name: "关键词库", exact: true })
        .getAttribute("aria-selected"),
      "true",
    );
    await waitRows(50);
    assert.match(await page.title(), /盘序|Panxu/i);
    assert.ok(page.url().startsWith("http://127.0.0.1:"));
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
    assert.equal(
      (await calls("traffic.knowledge.list")).at(-1).args.cursor,
      null,
    );
    assert.equal((await calls("traffic.knowledge.overview")).length, 0);
    assert.equal(
      await page.evaluate(
        () => "summary" in window.__qaTrafficOptimized.latestList!,
      ),
      false,
    );
    assert.deepEqual(await tabs.getByRole("tab").allTextContents(), [
      "关键词库",
      "我的词池",
      "5118找词",
      "百度营销",
      "找热点",
    ]);
    assert.equal(
      await page
        .getByLabel("词库平台", { exact: true })
        .getAttribute("data-value"),
      "",
    );
    assert.equal(await page.getByText("125项", { exact: true }).count(), 1);
    assert.equal((await calls("traffic.knowledge.history")).length, 0);
    assert.equal((await calls("traffic.knowledge.detail")).length, 0);
    await capture("01-library-1440.png");
    const pagination = page.getByRole("navigation", {
      name: "词库分页",
      exact: true,
    });
    const cursorPageTwo = await page.evaluate(
      () => window.__qaTrafficOptimized.latestList!.nextCursor,
    );
    assert.ok(cursorPageTwo);
    await pagination
      .getByRole("button", { name: "下一页", exact: true })
      .click();
    await waitRows(50);
    assert.equal(
      (await calls("traffic.knowledge.list")).at(-1).args.cursor,
      cursorPageTwo,
    );
    const cursorPageThree = await page.evaluate(
      () => window.__qaTrafficOptimized.latestList!.nextCursor,
    );
    assert.ok(cursorPageThree);
    await pagination
      .getByRole("button", { name: "下一页", exact: true })
      .click();
    await waitRows(25);
    assert.equal(
      (await calls("traffic.knowledge.list")).at(-1).args.cursor,
      cursorPageThree,
    );
    assert.equal(
      await page.evaluate(
        () => window.__qaTrafficOptimized.latestList!.nextCursor,
      ),
      null,
    );
    await capture("06-cursor-last-page-1440.png");
    await pagination
      .getByRole("button", { name: "上一页", exact: true })
      .click();
    await waitRows(50);
    assert.equal(
      (await calls("traffic.knowledge.list")).at(-1).args.cursor,
      cursorPageTwo,
    );
    await pagination
      .getByRole("button", { name: "上一页", exact: true })
      .click();
    await waitRows(50);
    assert.equal(
      (await calls("traffic.knowledge.list")).at(-1).args.cursor,
      null,
    );
    assert.equal(
      (await calls("traffic.knowledge.overview")).length,
      0,
      "翻页不触发全库统计",
    );
    await pagination
      .getByRole("button", { name: "下一页", exact: true })
      .click();
    await waitRows(50);
    await selectOption("词库排序", "月搜索量从高到低");
    await page.waitForFunction(() => {
      const args = window.__qaTrafficOptimized.calls
        .filter((call) => call.method === "traffic.knowledge.list")
        .at(-1)?.args as KnowledgeFilter;
      return args.sort === "monthly" && args.page === 1 && args.cursor === null;
    });
    await selectOption("词库排序", "最近采集优先");
    await waitRows(50);

    await rows()
      .nth(0)
      .getByRole("button", { name: "查看词条 竹子画法", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "词条详情 · 竹子画法",
      exact: true,
    });
    await dialog.getByText("25 次记录", { exact: true }).waitFor();
    const historyCalls = await calls("traffic.knowledge.history");
    assert.equal(historyCalls.at(-1).args.entryId, "qa_entry_0");
    assert.equal((await calls("traffic.knowledge.detail")).length, 0);
    await dialog
      .getByText("月搜索量 10 为默认值，非实测数据。", { exact: true })
      .waitFor();
    await dialog
      .getByRole("button", { name: "查看来源", exact: true })
      .nth(0)
      .click();
    await dialog.getByText("查看原始查询与响应", { exact: true }).waitFor();
    assert.equal(
      (await calls("traffic.knowledge.detail")).at(-1).args.id,
      "qa_query_0",
    );
    assert.equal(
      await dialog
        .locator("details.knowledge-detail-raw")
        .evaluate((node: HTMLDetailsElement) => node.open),
      false,
    );
    await dialog.getByText("查看原始查询与响应", { exact: true }).click();
    assert.equal(await dialog.locator("[data-qa-raw]").count(), 0);
    assert.match(
      await dialog.locator(".knowledge-detail-raw pre").last().textContent(),
      /data-qa-raw/,
    );
    const dialogBounds = await dialog.boundingBox();
    assert.ok(
      dialogBounds && dialogBounds.width >= 800,
      "历史详情使用桌面宽面板",
    );
    assert.equal(
      await dialog
        .locator(".dialog-body")
        .evaluate(
          (node: HTMLElement) => node.scrollWidth > node.clientWidth + 1,
        ),
      false,
      "详情正文不横向溢出或裁切",
    );
    await capture("02-entry-history-1440.png");
    await page.evaluate(() => {
      window.__qaTrafficOptimized.holdNextDetail = true;
    });
    await dialog
      .getByRole("button", { name: "查看来源", exact: true })
      .nth(1)
      .click();
    await page.waitForFunction(
      () => window.__qaTrafficOptimized.heldDetails.length === 1,
    );
    await dialog
      .getByRole("button", { name: "查看来源", exact: true })
      .nth(2)
      .click();
    await dialog.getByText("查看原始查询与响应", { exact: true }).waitFor();
    await dialog.getByText("查看原始查询与响应", { exact: true }).click();
    assert.match(
      await dialog.locator(".knowledge-detail-raw pre").last().textContent(),
      /qa_query_0_history_2/,
    );
    await page.evaluate(() => window.__qaTrafficOptimized.releaseHeldDetails());
    await page.waitForFunction(
      () => window.__qaTrafficOptimized.heldDetailsResolved === 1,
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    assert.match(
      await dialog.locator(".knowledge-detail-raw pre").last().textContent(),
      /qa_query_0_history_2/,
    );
    await dialog
      .getByRole("navigation", { name: "词条历史分页", exact: true })
      .getByRole("button", { name: "下一页", exact: true })
      .click();
    await dialog.getByText("第 2 / 2 页 · 共 25 项", { exact: true }).waitFor();
    assert.equal(
      (await calls("traffic.knowledge.history")).at(-1).args.page,
      2,
    );
    assert.equal(
      (await calls("traffic.knowledge.history")).at(-1).args.entryId,
      "qa_entry_0",
    );
    await dialog.getByRole("button", { name: "完成", exact: true }).click();

    await selectOption("词库来源", "百度关键词规划师");
    await selectOption("词库平台", "百度");
    await selectOption("搜索量依据", "有实测月搜索量");
    await selectOption("词库排序", "月搜索量从高到低");
    await page.waitForFunction(
      () =>
        window.__qaTrafficOptimized.latestList?.items[0]?.metrics
          .averageMonthPv === 100,
    );
    await page.waitForFunction(
      () =>
        document.querySelector(
          'table[aria-label="词库列表"] tbody tr td:nth-child(4) span',
        )?.textContent === "100",
    );
    assert.equal(
      await table().getByText("默认值 · 非实测", { exact: false }).count(),
      0,
    );
    assert.equal((await calls("traffic.knowledge.list")).at(-1).args.page, 1);
    assert.equal(
      (await calls("traffic.knowledge.list")).at(-1).args.cursor,
      null,
    );
    await search("没有对应词条的筛选条件");
    await page
      .getByRole("heading", { name: "没有符合筛选的词条", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await waitRows(50);

    await selectOption("词条类型", "关键词");
    await selectOption("词库排序", "最近采集优先");
    await waitRows(50);
    await page.getByLabel("全选本页词条", { exact: true }).check();
    await batch().getByText("已选 50 项", { exact: true }).waitFor();
    const expectedPageOne: KnowledgeItem[] = await page.evaluate(
      () => window.__qaTrafficOptimized.latestList!.items,
    );
    await page
      .getByRole("navigation", { name: "词库分页", exact: true })
      .getByRole("button", { name: "下一页", exact: true })
      .click();
    await waitRows(50);
    const expectedPageTwo: KnowledgeItem = await page.evaluate(
      () => window.__qaTrafficOptimized.latestList!.items[0],
    );
    await rows().nth(0).getByRole("checkbox").check();
    await batch().getByText("已选 51 项", { exact: true }).waitFor();
    await page
      .getByRole("navigation", { name: "词库分页", exact: true })
      .getByRole("button", { name: "上一页", exact: true })
      .click();
    await waitRows(50);
    assert.equal(
      await page.getByLabel("全选本页词条", { exact: true }).isChecked(),
      true,
    );
    await batch()
      .getByRole("button", { name: "清空选择", exact: true })
      .click();
    await batch().getByText("勾选词条后批量复用", { exact: true }).waitFor();

    await rows().nth(0).getByRole("checkbox").check();
    await rows().nth(1).getByRole("checkbox").check();
    await batch().getByText("跨页保留 · 1个词", { exact: true }).waitFor();
    await batch().getByRole("button", { name: "复制词", exact: true }).click();
    assert.deepEqual(
      await page.evaluate(() => window.__qaTrafficOptimized.copies),
      ["竹子画法"],
    );
    await batch()
      .getByRole("button", { name: "清空选择", exact: true })
      .click();
    await page.getByLabel("全选本页词条", { exact: true }).check();
    await page
      .getByRole("navigation", { name: "词库分页", exact: true })
      .getByRole("button", { name: "下一页", exact: true })
      .click();
    await waitRows(50);
    await rows().nth(0).getByRole("checkbox").check();
    await page
      .getByLabel("词库新词池名称", { exact: true })
      .fill("绘画学习选词");
    await batch()
      .getByRole("button", { name: "保存为词池", exact: true })
      .click();
    await batch().getByText("勾选词条后批量复用", { exact: true }).waitFor();
    const saved = await page.evaluate(
      () => window.__qaTrafficOptimized.saves[0],
    );
    assert.equal(saved.name, "绘画学习选词");
    assert.deepEqual(
      (saved.keywords as KnowledgeItem[]).map((item) => item.id),
      [...expectedPageOne, expectedPageTwo].map((item) => item.id),
    );

    // Repeating a search is not a new result set. Preserve all cross-page
    // selections rather than discarding them merely because Search was clicked.
    await search("国画");
    await waitRows(50);
    await page.getByLabel("全选本页词条", { exact: true }).check();
    const submittedPageOne: KnowledgeItem[] = await page.evaluate(
      () => window.__qaTrafficOptimized.latestList!.items,
    );
    await page
      .getByRole("navigation", { name: "词库分页", exact: true })
      .getByRole("button", { name: "下一页", exact: true })
      .click();
    await waitRows(50);
    const submittedPageTwo: KnowledgeItem = await page.evaluate(
      () => window.__qaTrafficOptimized.latestList!.items[0],
    );
    await rows().nth(0).getByRole("checkbox").check();
    await batch().getByText("已选 51 项", { exact: true }).waitFor();
    await search("国画");
    await waitRows(50);
    await page
      .getByRole("navigation", { name: "词库分页", exact: true })
      .getByText(/^第 1 \/ /)
      .waitFor();
    await batch().getByText("已选 51 项", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("全选本页词条", { exact: true }).isChecked(),
      true,
    );

    // Hold only this page's simulated save. Editing and leaving the library
    // while that receipt is pending must not let its completion erase a newer
    // name or selection draft, including after the original hook unmounts.
    await page
      .getByLabel("词库新词池名称", { exact: true })
      .fill("国画素材初选");
    await page.evaluate(() => {
      window.__qaTrafficOptimized.holdNextSave = true;
    });
    await batch()
      .getByRole("button", { name: "保存为词池", exact: true })
      .click();
    await page.waitForFunction(
      () => window.__qaTrafficOptimized.heldSaves.length === 1,
    );
    await page
      .getByLabel("词库新词池名称", { exact: true })
      .fill("国画素材新草稿");
    await rows().nth(0).getByRole("checkbox").uncheck();
    await batch().getByText("已选 50 项", { exact: true }).waitFor();
    await page
      .getByRole("navigation", { name: "词库分页", exact: true })
      .getByRole("button", { name: "下一页", exact: true })
      .click();
    await waitRows(50);
    await rows().nth(1).getByRole("checkbox").check();
    await batch().getByText("已选 51 项", { exact: true }).waitFor();
    await tabs.getByRole("tab", { name: "我的词池", exact: true }).click();
    await tabs.getByRole("tab", { name: "关键词库", exact: true }).click();
    await waitRows(50);
    assert.equal(
      await page.getByLabel("词库新词池名称", { exact: true }).inputValue(),
      "国画素材新草稿",
    );
    await page.evaluate(() => window.__qaTrafficOptimized.releaseHeldSaves());
    await page.waitForFunction(
      () => window.__qaTrafficOptimized.heldSavesResolved === 1,
    );
    await page.waitForFunction(() =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[aria-label="词库批量操作"] button',
        ),
      ].some(
        (button) => button.textContent?.includes("复制词") && !button.disabled,
      ),
    );
    await batch().getByText("已选 51 项", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("词库新词池名称", { exact: true }).inputValue(),
      "国画素材新草稿",
    );
    assert.equal(await rows().nth(0).getByRole("checkbox").isChecked(), true);
    assert.equal(await rows().nth(1).getByRole("checkbox").isChecked(), true);
    const delayedSave = await page.evaluate(
      () => window.__qaTrafficOptimized.saves[1],
    );
    assert.equal(delayedSave.name, "国画素材初选");
    assert.deepEqual(
      (delayedSave.keywords as KnowledgeItem[]).map((item) => item.id),
      [...submittedPageOne, submittedPageTwo].map((item) => item.id),
    );
    await page
      .getByRole("navigation", { name: "词库分页", exact: true })
      .getByRole("button", { name: "上一页", exact: true })
      .click();
    await waitRows(50);
    assert.equal(await rows().nth(0).getByRole("checkbox").isChecked(), false);
    assert.equal(await rows().nth(1).getByRole("checkbox").isChecked(), true);

    await search("竹子画法");
    await waitRows(2);
    await page.getByLabel("全选本页词条", { exact: true }).check();
    await batch()
      .getByRole("button", { name: "带入找词", exact: true })
      .click();
    await page.getByLabel("查询种子词", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("查询种子词", { exact: true }).inputValue(),
      "竹子画法",
    );
    assert.equal((await calls("traffic.query")).length, 0);
    await tabs.getByRole("tab", { name: "关键词库", exact: true }).click();
    await waitRows(2);
    await page.getByLabel("词库新词池名称", { exact: true }).fill("待整理词池");
    const legacySelection: { key: string; items: KnowledgeItem[] } =
      await page.evaluate(() => {
        const id = window.panxu.windowId;
        if (!id || id === "main")
          throw new Error("旧草稿验收仅允许本任务窗口。");
        const prefix = `panxu-window:${encodeURIComponent(id)}:panxu-traffic-library-v1:`;
        const key = Object.keys(localStorage).find((key) =>
          key.startsWith(prefix),
        );
        if (!key) throw new Error("本任务窗口的选词草稿不存在。");
        const draft = JSON.parse(localStorage.getItem(key)!);
        draft.selected = draft.selected.map(
          (item: KnowledgeItem, index: number) => ({
            ...item,
            entryId: `pre_migration_identity_${index}`,
            metrics: {
              ...item.metrics,
              averageMonthPv: 3,
              snapshotStamp: "saved_before_schema_35",
            },
            sourceUpdatedAt: "2026-10-20T00:00:00.000Z",
          }),
        );
        localStorage.setItem(key, JSON.stringify(draft));
        return { key, items: draft.selected as KnowledgeItem[] };
      });
    await page.reload();
    await waitRows(2);
    assert.equal(
      await page.getByLabel("搜索词库", { exact: true }).inputValue(),
      "竹子画法",
    );
    assert.equal(
      await page
        .getByLabel("词条类型", { exact: true })
        .getAttribute("data-value"),
      "word",
    );
    await batch().getByText("已选 2 项", { exact: true }).waitFor();
    await page.waitForFunction((key: string) => {
      const draft = JSON.parse(localStorage.getItem(key)!);
      return draft.selected.every((item: KnowledgeItem) =>
        item.entryId.startsWith("qa_entry_"),
      );
    }, legacySelection.key);
    const repairedSelection: KnowledgeItem[] = await page.evaluate(
      (key: string) => JSON.parse(localStorage.getItem(key)!).selected,
      legacySelection.key,
    );
    assert.deepEqual(
      repairedSelection.map(({ entryId: _entryId, ...item }) => item),
      legacySelection.items.map(({ entryId: _entryId, ...item }) => item),
      "旧选词仅修复当前entryId，原采集指标与时间不变",
    );
    assert.deepEqual(
      repairedSelection.map((item) => item.entryId),
      ["qa_entry_0", "qa_entry_1"],
    );
    assert.equal(
      await page.getByLabel("全选本页词条", { exact: true }).isChecked(),
      true,
    );
    assert.deepEqual(
      (await calls("traffic.knowledge.resolve")).at(-1).args.observationIds,
      ["qa_observation_0", "qa_observation_1"],
    );
    assert.equal(
      await page.getByLabel("词库新词池名称", { exact: true }).inputValue(),
      "待整理词池",
    );
    await capture("03-restored-selection-1440.png");
    await batch()
      .getByRole("button", { name: "保存为词池", exact: true })
      .click();
    await batch().getByText("勾选词条后批量复用", { exact: true }).waitFor();
    const repairedPool = await page.evaluate(() =>
      window.__qaTrafficOptimized.saves.at(-1),
    );
    assert.equal(repairedPool!.name, "待整理词池");
    assert.deepEqual(
      (repairedPool!.keywords as KnowledgeItem[]).map((item) => ({
        id: item.id,
        volume: item.metrics.averageMonthPv,
        at: item.sourceUpdatedAt,
      })),
      repairedSelection.map((item) => ({
        id: item.id,
        volume: 3,
        at: item.sourceUpdatedAt,
      })),
    );
    await page.evaluate(
      ({
        key,
        storageKey,
        item,
      }: {
        key: string;
        storageKey: string;
        item: KnowledgeItem;
      }) => {
        const draft = JSON.parse(localStorage.getItem(key)!);
        const { entryId: _entryId, ...legacy } = item;
        draft.selected = [legacy];
        draft.poolName = "旧选词恢复整理";
        localStorage.setItem(key, JSON.stringify(draft));
        const state = JSON.parse(sessionStorage.getItem(storageKey)!);
        state.holdResolve = true;
        sessionStorage.setItem(storageKey, JSON.stringify(state));
      },
      {
        key: legacySelection.key,
        storageKey: fixture.storageKey,
        item: legacySelection.items[0],
      },
    );
    await page.reload();
    await waitRows(2);
    await page.waitForFunction(
      () => window.__qaTrafficOptimized.heldResolves.length > 0,
    );
    await batch().getByText("已选 1 项", { exact: true }).waitFor();
    assert.equal(await rows().nth(0).getByRole("checkbox").isChecked(), false);
    await rows().nth(0).getByRole("checkbox").check();
    await batch().getByText("已选 2 项", { exact: true }).waitFor();
    await page.waitForFunction(
      () => window.__qaTrafficOptimized.heldResolves.length >= 2,
    );
    await page.evaluate(() =>
      window.__qaTrafficOptimized.releaseHeldResolves(),
    );
    await batch().getByText("已选 1 项", { exact: true }).waitFor();
    const deduplicated: KnowledgeItem[] = await page.evaluate(
      (key: string) => JSON.parse(localStorage.getItem(key)!).selected,
      legacySelection.key,
    );
    assert.equal(deduplicated.length, 1);
    assert.equal(deduplicated[0].entryId, "qa_entry_0");
    assert.equal(deduplicated[0].metrics.averageMonthPv, 3);
    assert.equal(deduplicated[0].sourceUpdatedAt, "2026-10-20T00:00:00.000Z");
    await batch()
      .getByRole("button", { name: "保存为词池", exact: true })
      .click();
    await batch().getByText("勾选词条后批量复用", { exact: true }).waitFor();
    const deduplicatedPool = await page.evaluate(() =>
      window.__qaTrafficOptimized.saves.at(-1),
    );
    assert.equal((deduplicatedPool!.keywords as KnowledgeItem[]).length, 1);
    assert.equal(
      (deduplicatedPool!.keywords as KnowledgeItem[])[0].metrics.averageMonthPv,
      3,
    );

    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await waitRows(50);
    await checkpoint();
    await page.evaluate(() => {
      window.__qaTrafficOptimized.failNextList = true;
    });
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page
      .getByRole("heading", { name: "词库暂未读取成功", exact: true })
      .waitFor();
    assert.equal(await rows().count(), 50, "刷新失败应保留已显示的词条");
    await page.getByRole("button", { name: "重试读取", exact: true }).click();
    await waitRows(50);
    assert.equal(
      await page
        .getByRole("heading", { name: "词库暂未读取成功", exact: true })
        .count(),
      0,
    );

    await page.evaluate(() => {
      window.__qaTrafficOptimized.holdNextList = true;
    });
    await search("国画");
    await page.waitForFunction(
      () => window.__qaTrafficOptimized.held.length === 1,
    );
    await selectOption("词库来源", "百度关键词规划师");
    await page.waitForFunction(() => {
      const list = document.querySelector('table[aria-label="词库列表"]');
      return (
        list?.getAttribute("aria-busy") === "false" &&
        [...list.querySelectorAll("tbody tr")].every((row) =>
          row.children[2].textContent?.includes("百度营销 · 关键词规划师"),
        )
      );
    });
    const filteredRowCount = await rows().count();
    await page.evaluate(() => window.__qaTrafficOptimized.releaseHeld());
    await page.waitForFunction(
      () => window.__qaTrafficOptimized.heldResolved === 1,
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    assert.equal(await rows().count(), filteredRowCount);
    assert.equal(
      await page
        .getByLabel("词库来源", { exact: true })
        .getAttribute("data-value"),
      "baidu-keywords",
    );
    assert.ok(
      (await rows().locator("td:nth-child(3)").allTextContents()).every(
        (value: string) => value.includes("百度营销 · 关键词规划师"),
      ),
    );

    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await waitRows(50);
    await search("面向初学者");
    await waitRows(1);
    await rows().nth(0).getByRole("checkbox").check();
    assert.equal(
      await batch()
        .getByRole("button", { name: "带入找词", exact: true })
        .isDisabled(),
      true,
    );
    await capture("04-long-keyword-1440.png");
    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await selectOption("词条类型", "热点");
    await waitRows(5);
    await page.getByLabel("全选本页词条", { exact: true }).check();
    assert.equal(
      await batch()
        .getByRole("button", { name: "保存为词池", exact: true })
        .isDisabled(),
      true,
    );
    await batch()
      .getByText("热点可复制或带入找词；词池仅收录关键词。", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await waitRows(50);
    const longtailTotal = fixture.items.filter(
      (item) =>
        item.kind === "word" &&
        ["longtail", "baidu-discovery"].includes(item.endpoint),
    ).length;
    await selectOption("词条类型", "长尾流量池");
    await waitRows(50);
    assert.equal(
      await page.getByText(`${longtailTotal}项`, { exact: true }).count(),
      1,
    );
    assert.ok(
      (await rows().locator("td:nth-child(3)").allTextContents()).every(
        (value: string) =>
          value.includes("百度批量扩词") || value.includes("5118 长尾词"),
      ),
    );
    await page
      .getByText("归集百度批量扩词与5118长尾词；默认搜索量不代表实测。", {
        exact: true,
      })
      .waitFor();
    await page.getByLabel("全选本页词条", { exact: true }).check();
    await page
      .getByRole("navigation", { name: "词库分页", exact: true })
      .getByRole("button", { name: "下一页", exact: true })
      .click();
    await waitRows(longtailTotal - 50);
    await rows().nth(0).getByRole("checkbox").check();
    await batch().getByText("已选 51 项", { exact: true }).waitFor();
    await page.reload();
    await waitRows(longtailTotal - 50);
    assert.equal(
      await page
        .getByLabel("词条类型", { exact: true })
        .getAttribute("data-value"),
      "longtail",
    );
    await batch().getByText("已选 51 项", { exact: true }).waitFor();
    await capture("05-longtail-pool-1440.png");
    const savesBeforeLongtail = (await calls("pool.save")).length;
    await batch()
      .getByRole("button", { name: "保存为词池", exact: true })
      .click();
    await page.waitForFunction(
      (expected: number) =>
        window.__qaTrafficOptimized.saves.length === expected,
      savesBeforeLongtail + 1,
    );
    const savedLongtail = await page.evaluate(() =>
      window.__qaTrafficOptimized.saves.at(-1),
    );
    assert.equal((savedLongtail!.keywords as KnowledgeItem[]).length, 51);
    assert.ok(
      (savedLongtail!.keywords as KnowledgeItem[]).every((item) =>
        ["百度批量扩词", "5118 长尾词 v2"].includes(item.source),
      ),
    );
    await selectOption("词库来源", "百度关键词规划师");
    await page
      .getByRole("heading", { name: "没有符合筛选的词条", exact: true })
      .waitFor();
    await selectOption("词库来源", "5118长尾词");
    await waitRows(
      fixture.items.filter(
        (item) => item.endpoint === "longtail" && item.kind === "word",
      ).length,
    );
    await selectOption("搜索量依据", "默认月搜索量");
    await page
      .getByRole("heading", { name: "没有符合筛选的词条", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await waitRows(50);
    assert.equal(
      (await calls("traffic.knowledge.list")).filter(
        (call: Call) => (call.args as KnowledgeFilter).view === "queries",
      ).length,
      0,
    );
    await page.getByText("查询档案与入库说明", { exact: true }).click();
    assert.equal(
      (await calls("traffic.knowledge.overview")).length,
      0,
      "列表、筛选、排序和档案读取均不隐式请求全库统计",
    );
    const overview = await page.evaluate(() =>
      window.__qaTrafficInvoke("traffic.knowledge.overview"),
    );
    assert.equal(
      (overview as { summary: { queries: number } }).summary.queries,
      fixture.queries.length,
    );
    const poolReadsBeforeOpening = (await calls("pool.get")).length;
    assert.equal(
      poolReadsBeforeOpening,
      0,
      "词池导航列表只用摘要，尚未读取完整关键词",
    );
    const poolSummaries: PoolSummary[] = await page.evaluate(() =>
      window.__qaTrafficInvoke("pool.list"),
    );
    assert.equal(poolSummaries[0].keywordCount, 65);
    assert.ok(poolSummaries.every((pool) => !("keywords" in pool)));
    assert.ok(poolSummaries.every((pool) => pool.preview.length <= 5));
    await tabs.getByRole("tab", { name: "我的词池", exact: true }).click();
    const poolCard = page
      .locator(".pool-list > div")
      .filter({ has: page.getByText("笔墨练习收藏", { exact: true }) });
    await poolCard
      .getByText("65个词 · 尚未关联资源", { exact: true })
      .waitFor();
    assert.equal((await calls("pool.get")).length, 0);
    await poolCard.getByText("查看全部关键词", { exact: true }).click();
    await poolCard.getByRole("textbox").waitFor();
    assert.equal((await calls("pool.get")).at(-1).args.id, "qa_existing_pool");
    assert.equal(
      await poolCard.getByRole("textbox").inputValue(),
      fixture.pools[0].keywords.map((word) => word.word).join("\n"),
    );
    await capture("07-pool-on-demand-1440.png");
    await poolCard
      .getByRole("button", { name: "复制编辑", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("手工词池名称", { exact: true }).inputValue(),
      "笔墨练习收藏 副本",
    );
    assert.equal(
      await page.getByLabel("手工词池关键词", { exact: true }).inputValue(),
      fixture.pools[0].keywords.map((word) => word.word).join("\n"),
    );
    await tabs.getByRole("tab", { name: "关键词库", exact: true }).click();
    await page.getByText("查询档案与入库说明", { exact: true }).click();
    const archive = page.getByRole("region", { name: "查询档案", exact: true });
    await archive
      .getByRole("button", { name: "查看档案", exact: true })
      .nth(0)
      .waitFor();
    const sourceReads = (await calls("traffic.knowledge.detail")).length;
    await archive
      .getByRole("button", { name: "查看档案", exact: true })
      .nth(0)
      .click();
    await archive.getByText("查看原始查询与响应", { exact: true }).waitFor();
    assert.equal(
      (await calls("traffic.knowledge.detail")).length,
      sourceReads + 1,
    );
    await archive
      .getByRole("button", { name: "导出此来源 JSON", exact: true })
      .waitFor();
    await page.getByText("查询档案与入库说明", { exact: true }).click();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.ok(rewrittenModules >= 2, "重载后仍通过本页面的传输夹具读取");
    const audit = await page.evaluate(() => ({
      calls: window.__qaTrafficOptimized.calls,
      copies: window.__qaTrafficOptimized.copies,
      saves: window.__qaTrafficOptimized.saves,
      forbidden: window.__qaTrafficOptimized.forbidden,
    }));
    assert.deepEqual(audit.forbidden, []);
    assert.deepEqual(errors, []);
    const result = {
      windowId,
      frontendMock: true,
      scope:
        "仅本任务页面的/src/api/client.ts一处传输委托被替换；词库list/overview/resolve/history/detail、pool.list/get/save、复制与导出使用页面夹具，snapshot仅替换词池摘要，其余只读调用委托原后台。未修改共享业务数据、系统剪贴板或后端代码，不代表真实迁移与新后端验收。",
      checks: [
        "精确游标前后翻页与排序重置",
        "lean列表无统计，overview独立读取",
        "旧selection仅修复entryId并保留原指标时间快照",
        "旧selection缺entryId且resolve延迟时重选同条，修复后去重并保留最初快照",
        "词池摘要导航与按需详情/复制编辑",
        "默认关键词库与业务筛选",
        "空态恢复与核心指标排序",
        "全选本页和跨页保留/清空",
        "复制同词去重",
        "词池保存包含跨页全部所选",
        "相同搜索再次提交保留跨页选择",
        "旧保存回执不清除编辑并切页后的新草稿",
        "带入找词不发查询",
        "筛选与选择刷新恢复",
        "词条ID精确历史和按需报文",
        "读取失败保留内容与重试",
        "慢响应不覆盖新筛选",
        "长词和热点选择边界",
        "查询档案按需读取",
        "长尾流量池来源归集与交叉筛选",
        "长尾类型跨页选择刷新恢复并保存全部所选",
      ],
      fixtures: {
        entries: fixture.items.length,
        simulatedPools: audit.saves.length,
        clipboardWrites: 0,
        paidOrExternalMutations: audit.forbidden.length,
      },
      screenshots,
      consoleMessages,
      rewrittenModules,
    };
    await writeFile(
      join(output, "result.json"),
      JSON.stringify(result, null, 2),
    );
    return result;
  } catch (error) {
    await capture("failure.png").catch(() => {});
    await writeFile(
      join(output, "failure.json"),
      JSON.stringify(
        await page.evaluate(() => ({
          windowId: window.panxu.windowId,
          busy: document
            .querySelector('table[aria-label="词库列表"]')
            ?.getAttribute("aria-busy"),
          calls: window.__qaTrafficOptimized?.calls.slice(-30),
          latestList: window.__qaTrafficOptimized?.latestList,
          held: window.__qaTrafficOptimized?.held.length,
          errors: document.querySelector("vite-error-overlay")?.textContent,
        })),
        null,
        2,
      ),
    ).catch(() => {});
    throw error;
  } finally {
    await page.unroute(routePattern, routeHandler);
  }
}

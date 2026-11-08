import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir, cpus, totalmem, platform, arch } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { Database } from "../core/database";
import { TrafficKnowledge } from "../core/traffic-knowledge";
import { packTrafficArchive } from "../core/traffic-knowledge-store";

const { values } = parseArgs({
  options: {
    output: { type: "string", default: "/tmp/panxu-traffic-scale-500k" },
    export: { type: "boolean", default: false },
    scenario: { type: "string", multiple: true },
    extended: { type: "boolean", default: false },
  },
});
const output = values.output!;
await mkdir(output, { recursive: true });
const workspace = await mkdtemp(join(tmpdir(), "panxu-traffic-scale-"));
const sources = [
  ["baidu-discovery", "百度批量扩词"],
  ["longtail", "5118 长尾词 v2"],
  ["baidu-keywords", "百度营销 · 关键词规划师"],
  ["suggest", "5118 下拉联想词"],
] as const;
const themes = [
  "国画教程",
  "办公自动化",
  "考研英语",
  "数据分析",
  "视频剪辑",
  "摄影构图",
  "编程实践",
  "数学复习",
];
type Scenario = { name: string; entries: number; observations: number };
const scenarios: Scenario[] = [
  { name: "500k-history-50k-entries", entries: 50000, observations: 500000 },
  { name: "500k-distinct-entries", entries: 500000, observations: 500000 },
  ...(values.extended
    ? [
        {
          name: "500k-distinct-entries-3-rounds",
          entries: 500000,
          observations: 1500000,
        },
      ]
    : []),
];
const selectedScenarios = values.scenario?.length
  ? scenarios.filter((scenario) => values.scenario!.includes(scenario.name))
  : scenarios;
assert.ok(selectedScenarios.length > 0, "No matching benchmark scenario");
type Timing = {
  name: string;
  samplesMs: number[];
  maxMs: number;
  rows: number;
  total: number;
  wireBytes: number;
  under5s: boolean;
};
const report: Record<string, unknown> = {
  environment: {
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    ramGiB: totalmem() / 1024 ** 3,
    node: process.version,
  },
  scope:
    "Current source, real temporary SQLite WAL files, real ingest triggers, compressed query archives (one per source per 100 observations); no shared app data. First read after reopen has a cold SQLite connection, not a flushed OS page cache. List DTOs exclude optional overview. Timings include DTO JSON serialization, exclude Electron IPC/DOM rendering and file-save dialogs. Legacy deep numeric pages and keyset continuation are both measured; overview is measured separately.",
  scenarios: [] as unknown[],
};
try {
  for (const scenario of selectedScenarios) {
    const path = join(workspace, `${scenario.name}.db`);
    let db = new Database(path);
    try {
      const query = db.db.prepare(
        "INSERT INTO traffic_queries(id,endpoint,phase,request,seeds,platform,status,started_at,received_at,response) VALUES(?,?,'query',?,?,'baidu','success',?,?,?)",
      );
      const observation = db.db.prepare(
        "INSERT INTO traffic_items(id,query_id,kind,word,normalized_word,platform,source,metrics,observed_at,source_updated_at) VALUES(?,?,'word',?,?,?,?,?,?,NULL)",
      );
      const started = performance.now();
      for (let block = 0; block < scenario.observations; block += 1000) {
        db.transaction(() => {
          for (let offset = 0; offset < 1000; offset += 100) {
            const batch = block + offset;
            const rows = Array.from({ length: 100 }, (_, index) => {
              const sequence = batch + index,
                entry = sequence % scenario.entries;
              const mod = entry % 10;
              const sourceIndex = mod < 5 ? 0 : mod < 7 ? 1 : mod < 9 ? 2 : 3;
              const word = `${themes[Math.floor(entry / 10) % themes.length]}从零入门系统课程与实践资料第${String(entry).padStart(6, "0")}讲`;
              const metrics =
                sourceIndex === 0
                  ? {
                      averageMonthPv: 10,
                      averageMonthPvSource: "默认值（非实测）",
                    }
                  : sourceIndex === 2
                    ? {
                        averageMonthPv: 10 + (entry % 50000),
                        recommendPrice: 0.2 + (entry % 80) / 10,
                      }
                    : {
                        index: 1 + (entry % 20000),
                        mobile_index: entry % 5000,
                        bidword_pcpv: entry % 3000,
                      };
              return {
                sequence,
                entry,
                sourceIndex,
                word,
                metrics,
                at: new Date(
                  Date.UTC(2026, 10, 7, 0, 0) + sequence * 1000,
                ).toISOString(),
              };
            });
            for (const [sourceIndex, [endpoint, source]] of sources.entries()) {
              const selected = rows.filter(
                (row) => row.sourceIndex === sourceIndex,
              );
              const queryId = `query_${batch}_${sourceIndex}`;
              const seed =
                themes[
                  Math.floor((batch % scenario.entries) / 10) % themes.length
                ];
              query.run(
                queryId,
                endpoint,
                JSON.stringify({
                  keyword: seed,
                  page: Math.floor(batch / 100),
                }),
                JSON.stringify([seed]),
                selected[0].at,
                selected.at(-1)!.at,
                packTrafficArchive(
                  JSON.stringify({
                    data: selected.map((row) => ({
                      keyword: row.word,
                      metrics: row.metrics,
                      source,
                    })),
                    request: { keyword: seed },
                    total: selected.length,
                  }),
                ),
              );
              for (const row of selected)
                observation.run(
                  `obs_${row.sequence}`,
                  queryId,
                  row.word,
                  row.word.toLowerCase(),
                  row.entry % 3 === 0 ? "douyin" : "baidu",
                  source,
                  JSON.stringify(row.metrics),
                  row.at,
                );
            }
          }
        });
        if ((block + 1000) % 50000 === 0)
          console.log(
            JSON.stringify({
              scenario: scenario.name,
              seeded: block + 1000,
              elapsedSeconds: Math.round((performance.now() - started) / 1000),
            }),
          );
      }
      const seedMs = performance.now() - started;
      db.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      assert.equal(
        db.get<{ n: number }>("SELECT count(*) n FROM traffic_entries")?.n,
        scenario.entries,
      );
      assert.equal(
        db.get<{ n: number }>("SELECT count(*) n FROM traffic_observations")?.n,
        scenario.observations,
      );
      assert.equal(
        db.get<{ n: number }>("SELECT count(*) n FROM traffic_queries")?.n,
        scenario.observations / 25,
      );
      assert.equal(
        db.db.prepare("PRAGMA quick_check").get()?.quick_check,
        "ok",
      );
      const fileBytes = (await stat(path)).size;
      db.close();
      db = new Database(path);
      const library = new TrafficKnowledge(db);
      const timings: Timing[] = [];
      const measure = (
        name: string,
        action: () => { rows: number; total: number; value: unknown },
        repeat = 1,
      ) => {
        const samplesMs: number[] = [];
        let rows = 0,
          total = 0,
          wireBytes = 0;
        for (let i = 0; i < repeat; i++) {
          const start = performance.now();
          const result = action();
          const wire = JSON.stringify(result.value);
          samplesMs.push(Math.round((performance.now() - start) * 10) / 10);
          rows = result.rows;
          total = result.total;
          wireBytes = Buffer.byteLength(wire);
        }
        const maxMs = Math.max(...samplesMs);
        const result = {
          name,
          samplesMs,
          maxMs,
          rows,
          total,
          wireBytes,
          under5s: maxMs < 5000,
        };
        timings.push(result);
        console.log(JSON.stringify({ scenario: scenario.name, ...result }));
      };
      const list = (filter: Record<string, unknown> = {}) => {
        const value = library.list(filter);
        return {
          value,
          rows: value.items.length || value.queries.length,
          total: value.total,
        };
      };
      measure("first_50_reopened_connection", () => list({ cursor: null }));
      measure("page_2_numeric", () => list({ page: 2 }), 3);
      const firstPage = library.list({ cursor: null });
      assert.ok(firstPage.nextCursor, "First page must expose a continuation");
      measure(
        "page_2_cursor",
        () => list({ page: 2, cursor: firstPage.nextCursor }),
        3,
      );
      assert.deepEqual(
        library
          .list({ page: 2, cursor: firstPage.nextCursor })
          .items.map((item) => item.id),
        library.list({ page: 2 }).items.map((item) => item.id),
      );
      measure("chinese_search_common", () => list({ search: "国画教程" }), 2);
      measure(
        "search_no_matches",
        () => list({ search: "不存在的唯一检索条件XYZ" }),
        2,
      );
      measure(
        "source_baidu_discovery",
        () => list({ endpoint: "baidu-discovery" }),
        2,
      );
      measure("longtail_pool", () => list({ kind: "longtail" }), 2);
      measure(
        "longtail_pool_chinese_search",
        () => list({ kind: "longtail", search: "国画教程" }),
        2,
      );
      measure(
        "longtail_pool_monthly_sort",
        () => list({ kind: "longtail", sort: "monthly" }),
        2,
      );
      measure("longtail_pool_measured_volume", () =>
        list({ kind: "longtail", volume: "measured" }),
      );
      measure("monthly_sort", () => list({ sort: "monthly" }), 2);
      measure(
        "last_page",
        () => list({ page: Math.ceil(scenario.entries / 50) }),
        2,
      );
      measure("last_page_longtail", () =>
        list({
          kind: "longtail",
          page: Math.ceil((scenario.entries * 0.7) / 50),
        }),
      );
      const penultimateLongtail = library.list({
        kind: "longtail",
        page: Math.ceil((scenario.entries * 0.7) / 50) - 1,
      });
      assert.ok(penultimateLongtail.nextCursor);
      measure("last_page_longtail_cursor_resume", () =>
        list({
          kind: "longtail",
          page: Math.ceil((scenario.entries * 0.7) / 50),
          cursor: penultimateLongtail.nextCursor,
        }),
      );
      measure("query_archives_page_1", () => list({ view: "queries" }));
      measure("longtail_query_archives_search", () =>
        list({ view: "queries", kind: "longtail", search: "国画教程" }),
      );
      const entryId = library.list({}).items[0].entryId;
      measure("one_term_history", () => {
        const value = library.history({ entryId });
        return { value, rows: value.items.length, total: value.total };
      });
      const overview = () => {
        const value = library.overview();
        return { value, rows: value.seeds.length, total: value.summary.words };
      };
      measure("overview_first_explicit_read", overview);
      measure("overview_cached", overview, 2);
      const trafficRevision = library.overview().revision;
      db.setSetting("benchmark:unrelated-write", Date.now());
      measure("first_50_after_unrelated_write", () => list());
      measure("overview_after_unrelated_write", overview);
      assert.equal(library.overview().revision, trafficRevision);
      db.setSetting("benchmark:unrelated-write", Date.now() + 1);
      measure("longtail_monthly_sort_after_unrelated_write", () =>
        list({ kind: "longtail", sort: "monthly" }),
      );
      let fullExport: Record<string, unknown> | undefined;
      if (values.export && scenario.entries === 500000) {
        const start = performance.now();
        const content = library.export({});
        const elapsedMs = Math.round(performance.now() - start);
        fullExport = {
          name: "full_500k_observations_csv_in_memory",
          elapsedMs,
          bytes: Buffer.byteLength(content),
          under5s: elapsedMs < 5000,
          includesFileSave: false,
          processRssMiB: Math.round(process.memoryUsage().rss / 1024 ** 2),
        };
        console.log(JSON.stringify(fullExport));
      }
      const result = {
        ...scenario,
        queries: scenario.observations / 25,
        fileMiB: Math.round(fileBytes / 1024 ** 2),
        seedMs: Math.round(seedMs),
        timings,
        fullExport,
      };
      (report.scenarios as unknown[]).push(result);
      await writeFile(
        join(output, "result.json"),
        JSON.stringify(report, null, 2),
      );
    } finally {
      db.close();
    }
    await rm(path, { force: true });
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });
  }
} finally {
  await rm(workspace, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    result: join(output, "result.json"),
    allPagedReadsUnder5s: (
      report.scenarios as Array<{ timings: Timing[] }>
    ).every((scenario) => scenario.timings.every((timing) => timing.under5s)),
  }),
);

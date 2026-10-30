import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  discoveryInputSchema,
  discoveryRunSchema,
  discoveryWordKey,
  normalizeDiscoveryWord,
  discoverySourceLabels,
  type DiscoveryInput,
  type DiscoveryRun,
  type DiscoverySummary,
} from "../shared/baidu-discovery";
import type { Database } from "./database";
import { id, now } from "./database";
import type { AppPorts } from "./ports";
import { AppError, safeMessage } from "./errors";
import { csv } from "./csv";

const prefix = "baidu-discovery:";
const wireWords = z.array(z.string().max(200)).max(100);

/** Durable, explicitly started browser reads. There is one active task per workspace. */
export class BaiduDiscovery {
  private active?: {
    id: string;
    controller: AbortController;
    done: Promise<void>;
  };
  private closed = false;
  constructor(
    private db: Database,
    private ports: Pick<AppPorts, "baiduDiscovery">,
    private changed: () => void,
  ) {
    // A restart never resumes external searches on its own.
    for (const row of this.db.all<{ value: string }>(
      "SELECT value FROM api_cache WHERE key LIKE ? AND json_valid(value) AND json_extract(value,'$.status')='running'",
      `${prefix}%`,
    )) {
      const parsed = discoveryRunSchema.safeParse(JSON.parse(row.value));
      if (!parsed.success) continue;
      const run = parsed.data;
      run.status = "paused";
      run.message = "上次采集已中断，已保留结果与断点，请手动继续。";
      this.save(run, false);
    }
  }
  get isBusy() {
    return !!this.active;
  }
  private browser() {
    if (!this.ports.baiduDiscovery)
      throw new AppError(
        "BAIDU_BROWSER_UNAVAILABLE",
        "请在客户端源码开发窗口使用百度批量扩词。",
      );
    return this.ports.baiduDiscovery;
  }
  list(): DiscoverySummary[] {
    return this.db
      .all<{
        metadata: string;
        queryCount: number;
        completedCount: number;
        wordCount: number;
      }>(
        `SELECT json_remove(value,'$.queries','$.words') AS metadata,
      json_array_length(value,'$.queries') AS queryCount,json_array_length(value,'$.words') AS wordCount,
      (SELECT count(*) FROM json_each(c.value,'$.queries') WHERE json_extract(value,'$.status')!='pending') AS completedCount
      FROM api_cache c WHERE key LIKE ? ORDER BY json_extract(value,'$.createdAt') DESC`,
        `${prefix}%`,
      )
      .map(({ metadata, ...counts }) => ({
        ...discoveryRunSchema
          .omit({ queries: true, words: true })
          .parse(JSON.parse(metadata)),
        ...counts,
      }));
  }
  get(runId: string): DiscoveryRun {
    const row = this.db.get<{ value: string }>(
      "SELECT value FROM api_cache WHERE key=?",
      prefix + runId,
    );
    if (!row)
      throw new AppError(
        "BAIDU_DISCOVERY_MISSING",
        "未找到采词任务，请刷新任务列表。",
      );
    return discoveryRunSchema.parse(JSON.parse(row.value));
  }
  private save(run: DiscoveryRun, notify = true) {
    if (this.closed) return;
    run.updatedAt = now();
    this.db.run(
      "INSERT INTO api_cache(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at",
      prefix + run.id,
      JSON.stringify(run),
      "9999-12-31T00:00:00.000Z",
    );
    if (notify) this.changed();
  }
  private assertIdle() {
    if (this.active)
      throw new AppError(
        "BAIDU_DISCOVERY_BUSY",
        "已有百度采词任务运行中，请先暂停该任务。",
      );
  }
  start(raw: DiscoveryInput) {
    this.assertIdle();
    this.browser();
    const input = discoveryInputSchema.parse(raw);
    input.seeds = [
      ...new Map(
        input.seeds.map((word) => [
          discoveryWordKey(word),
          normalizeDiscoveryWord(word),
        ]),
      ).values(),
    ];
    input.sources = [...new Set(input.sources)];
    const run: DiscoveryRun = {
      id: id("baidu_discovery"),
      createdAt: now(),
      updatedAt: now(),
      status: "running",
      input,
      queries: input.seeds.map((word) => ({
        word,
        seed: word,
        depth: 0,
        completedSources: [],
        status: "pending",
        message: "",
      })),
      words: [],
      message: "准备打开百度采集窗口…",
      currentWord: "",
      limited: false,
    };
    this.launch(run);
    return this.get(run.id);
  }
  private launch(run: DiscoveryRun) {
    const controller = new AbortController();
    run.status = "running";
    this.save(run);
    // Defer work until the active lease is assigned and the start reply can be delivered.
    const done = Promise.resolve()
      .then(() => this.work(run, controller.signal))
      .finally(() => {
        if (this.active?.controller === controller) this.active = undefined;
        if (!this.closed) this.changed();
      });
    this.active = { id: run.id, controller, done };
  }
  private async work(run: DiscoveryRun, signal: AbortSignal) {
    try {
      const results = new Map(run.words.map((word) => [word.key, word]));
      const queued = new Set(
        run.queries.map((query) => discoveryWordKey(query.word)),
      );
      let first = true;
      for (const query of run.queries) {
        if (query.status !== "pending") continue;
        signal.throwIfAborted();
        if (!first) await delay(run.input.intervalMs, undefined, { signal });
        first = false;
        run.currentWord = query.word;
        for (const source of run.input.sources) {
          if (query.completedSources.includes(source)) continue;
          signal.throwIfAborted();
          run.message = `正在采集「${query.word}」的${discoverySourceLabels[source]}…`;
          this.save(run);
          const words = wireWords.parse(
            await this.browser().read(source, query.word, signal),
          );
          signal.throwIfAborted();
          for (const raw of words) {
            const word = normalizeDiscoveryWord(raw),
              key = discoveryWordKey(word);
            if (
              !word ||
              word.length > 100 ||
              key === discoveryWordKey(query.word)
            )
              continue;
            let result = results.get(key);
            if (!result) {
              if (run.words.length >= 10000) {
                run.limited = true;
                break;
              }
              result = { key, word, origins: [] };
              results.set(key, result);
              run.words.push(result);
            }
            if (
              !result.origins.some(
                (origin) =>
                  origin.source === source &&
                  discoveryWordKey(origin.query) ===
                    discoveryWordKey(query.word),
              )
            ) {
              result.origins.push({
                source,
                query: query.word,
                seed: query.seed,
                depth: query.depth + 1,
                url: `https://www.baidu.com/s?wd=${encodeURIComponent(query.word)}`,
                at: now(),
              });
            }
            if (query.depth + 1 < run.input.maxDepth && !queued.has(key)) {
              if (run.queries.length < run.input.maxQueries) {
                run.queries.push({
                  word,
                  seed: query.seed,
                  depth: query.depth + 1,
                  completedSources: [],
                  status: "pending",
                  message: "",
                });
                queued.add(key);
              } else run.limited = true;
            }
          }
          query.completedSources.push(source);
          this.save(run); // Preserve the first source even if the second source needs verification.
        }
        query.status = "completed";
        query.message = "采集完成";
        this.save(run);
        if (run.words.length >= 10000) break;
      }
      run.status = "completed";
      run.currentWord = "";
      run.message = run.limited
        ? "本轮已完成，扩词达到查询或结果上限；已保留去重结果。"
        : "本轮采集完成，可勾选尚未查询的词继续扩词，或导出去重结果。";
    } catch (error) {
      if (this.closed) return;
      run.status =
        error instanceof AppError && error.code === "BAIDU_VERIFICATION"
          ? "waiting"
          : "paused";
      run.message = signal.aborted
        ? "已暂停，采集结果与断点已保存。"
        : safeMessage(error);
    }
    this.save(run);
  }
  async pause(runId: string) {
    if (this.active?.id !== runId) return this.get(runId);
    const active = this.active;
    active.controller.abort();
    await active.done;
    return this.get(runId);
  }
  resume(runId: string) {
    this.assertIdle();
    this.browser();
    const run = this.get(runId);
    if (run.status === "completed")
      throw new AppError(
        "BAIDU_DISCOVERY_COMPLETED",
        "此轮已完成，请勾选新词继续扩词。",
      );
    this.launch(run);
    return this.get(run.id);
  }
  skip(runId: string) {
    this.assertIdle();
    const run = this.get(runId),
      query = run.queries.find((q) => q.status === "pending");
    if (!query)
      throw new AppError("BAIDU_DISCOVERY_COMPLETED", "没有待处理的关键词。");
    query.status = "skipped";
    query.message = "手动跳过，已采集的来源保留";
    this.launch(run);
    return this.get(run.id);
  }
  expand(runId: string, selected: string[]) {
    this.assertIdle();
    this.browser();
    const run = this.get(runId);
    if (run.status !== "completed")
      throw new AppError(
        "BAIDU_DISCOVERY_PENDING",
        "请先继续或跳过未完成的关键词。",
      );
    const known = new Map(run.words.map((word) => [word.key, word]));
    const queued = new Set(
      run.queries.map((query) => discoveryWordKey(query.word)),
    );
    const additions = [...new Set(selected.map(discoveryWordKey))].filter(
      (key) => !queued.has(key),
    );
    if (!additions.length)
      throw new AppError(
        "BAIDU_DISCOVERY_REPEATED",
        "所选词均已查询，请选择尚未查询的结果。",
      );
    if (run.queries.length + additions.length > run.input.maxQueries)
      throw new AppError(
        "BAIDU_DISCOVERY_LIMIT",
        "所选词超出本任务的查询上限，请减少选择或新建任务。",
      );
    for (const key of additions) {
      const word = known.get(key);
      if (!word)
        throw new AppError(
          "BAIDU_DISCOVERY_WORD_MISSING",
          "所选词不属于此任务，请刷新结果。",
        );
      const origin = word.origins[0];
      if (origin.depth >= 3)
        throw new AppError(
          "BAIDU_DISCOVERY_DEPTH",
          "最多继续扩词到第3层，请将需要的词另建任务。",
        );
      run.queries.push({
        word: word.word,
        seed: origin.seed,
        depth: origin.depth,
        completedSources: [],
        status: "pending",
        message: "",
      });
    }
    this.launch(run);
    return this.get(run.id);
  }
  async open(runId?: string) {
    await this.browser().open(
      runId ? this.get(runId).currentWord || undefined : undefined,
    );
  }
  closeBrowser() {
    this.assertIdle();
    this.browser().close();
  }
  exportBytes(runId: string, format: "csv" | "txt", selected?: string[]) {
    const run = this.get(runId),
      keys = selected ? new Set(selected.map(discoveryWordKey)) : null;
    const words = keys
      ? run.words.filter((word) => keys.has(word.key))
      : run.words;
    if (!words.length)
      throw new AppError("BAIDU_DISCOVERY_EMPTY", "尚无可导出的关键词。");
    return Buffer.from(
      format === "txt"
        ? "\uFEFF" + words.map((word) => word.word).join("\r\n") + "\r\n"
        : csv([
            [
              "关键词",
              "采集来源",
              "来源查询词",
              "初始关键词",
              "扩词层级",
              "来源页面",
              "采集时间",
            ],
            ...words.map((word) => [
              word.word,
              ...[
                word.origins.map(
                  (origin) => discoverySourceLabels[origin.source],
                ),
                word.origins.map((origin) => origin.query),
                word.origins.map((origin) => origin.seed),
                word.origins.map((origin) => String(origin.depth)),
                word.origins.map((origin) => origin.url),
                word.origins.map((origin) => origin.at),
              ].map((values) => [...new Set(values)].join("；")),
            ]),
          ]),
    );
  }
  close() {
    if (this.closed) return;
    if (this.active) {
      const run = this.get(this.active.id);
      run.status = "paused";
      run.message = "采集已中断，请手动继续。";
      this.save(run, false);
      this.active.controller.abort();
    }
    this.closed = true;
    this.ports.baiduDiscovery?.close();
  }
}

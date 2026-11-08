import { createHash } from "node:crypto";
import { Database, id, now, parseJson } from "./database";
import { cleanKnowledge } from "./knowledge-response";
import {
  packTrafficArchive,
  unpackTrafficArchive,
  normalizeTrafficWord as normalize,
} from "./traffic-knowledge-store";
export { cleanKnowledge } from "./knowledge-response";
import {
  baiduKeywordResultSchema,
  baiduKeywordSource,
} from "../shared/baidu-keywords";
import type { Endpoint } from "../shared/types";
import {
  discoveryDefaultMonthlySearches,
  discoveryKnowledgeSource,
  discoverySourceLabels,
  discoveryWordKey,
  type DiscoveryRun,
  type DiscoverySource,
} from "../shared/baidu-discovery";
import { TrafficKnowledgeReader } from "./traffic-knowledge-read";

const sources = {
  longtail: "5118 长尾词 v2",
  suggest: "5118 下拉联想词",
  metrics: "5118 搜索量 v2",
  radar: "5118 热点雷达",
};
const scalarText = (v: unknown) =>
  typeof v === "string" || typeof v === "number" ? String(v) : null;
export class TrafficKnowledge {
  private readonly reader: TrafficKnowledgeReader;
  constructor(private db: Database) {
    this.reader = new TrafficKnowledgeReader(db);
  }
  ingestBaidu(raw: unknown) {
    const result = baiduKeywordResultSchema.parse(raw);
    const origin = `baidu-keywords:${result.id}`;
    const prior = this.db.get<{ response: string }>(
      "SELECT response FROM traffic_queries WHERE origin=?",
      origin,
    );
    if (prior) {
      const archived = parseJson<{
        indexed: number;
        refreshedBelowThreshold?: number;
      }>(unpackTrafficArchive(prior.response), { indexed: 0 });
      return {
        indexed: archived.indexed,
        refreshedBelowThreshold: archived.refreshedBelowThreshold ?? 0,
        minimumMonthlySearches: 10,
      };
    }
    const existing = new Set(
      this.db
        .all<{ normalized_word: string }>(
          "SELECT normalized_word FROM traffic_entries WHERE kind='word' AND source_key=?",
          "baidu-keywords",
        )
        .map((row) => row.normalized_word),
    );
    let indexed = 0,
      refreshedBelowThreshold = 0;
    const keywords = [
      ...new Map(
        result.keywords.map((keyword) => [normalize(keyword.word), keyword]),
      ).values(),
    ].filter((keyword) => {
      const value = keyword.metrics.averageMonthPv;
      const monthly =
        typeof value === "number"
          ? value
          : typeof value === "string" && value.trim()
            ? Number(value.replace(/,/g, ""))
            : NaN;
      const boundedLow =
        typeof value === "string" && /^<\s*(?:[1-9]|10)$/.test(value.trim());
      if (!Number.isFinite(monthly) && !boundedLow) return false;
      if (monthly >= 10) {
        indexed++;
        return true;
      }
      if (existing.has(normalize(keyword.word))) {
        refreshedBelowThreshold++;
        return true;
      }
      return false;
    });
    const summary = {
      indexed,
      refreshedBelowThreshold,
      minimumMonthlySearches: 10,
    };
    this.db.transaction(() => {
      const queryId = id("traffic");
      this.db.run(
        "INSERT INTO traffic_queries(id,origin,endpoint,phase,request,seeds,platform,status,started_at,received_at,http_status,response,message) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        queryId,
        origin,
        "baidu-keywords",
        "query",
        JSON.stringify(result.input),
        JSON.stringify(result.input.seeds),
        "baidu",
        "success",
        result.fetchedAt,
        result.fetchedAt,
        200,
        packTrafficArchive(
          JSON.stringify({
            keywords,
            fetchedAt: result.fetchedAt,
            received: result.keywords.length,
            ...summary,
            rule: "新词 averageMonthPv >= 10；已有词更新有效指标",
          }),
        ),
        `月均搜索量至少10：收录或更新${indexed}词，另更新${refreshedBelowThreshold}个已收录的低搜索量词；同来源同词展示最新指标，历史采集保留。`,
      );
      for (const keyword of keywords) {
        this.db.run(
          "INSERT INTO traffic_items(id,query_id,kind,word,normalized_word,platform,source,source_key,metrics,observed_at,source_updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          id("observation"),
          queryId,
          "word",
          keyword.word,
          normalize(keyword.word),
          "baidu",
          baiduKeywordSource,
          "baidu-keywords",
          JSON.stringify(cleanKnowledge(keyword.metrics)),
          result.fetchedAt,
          keyword.sourceUpdatedAt,
        );
      }
    });
    return summary;
  }
  ingestDiscovery(
    run: DiscoveryRun,
    query: DiscoveryRun["queries"][number],
    source: DiscoverySource,
  ) {
    const origin = `baidu-discovery:${run.id}:${discoveryWordKey(query.word)}:${source}`;
    if (this.db.get("SELECT id FROM traffic_queries WHERE origin=?", origin))
      return;
    const removed = new Set(run.removedKeys);
    const words = run.words.flatMap((word) => {
      if (removed.has(word.key)) return [];
      const origins = word.origins.filter(
        (entry) =>
          entry.source === source &&
          discoveryWordKey(entry.query) === discoveryWordKey(query.word),
      );
      if (!origins.length) return [];
      return [{ ...word, origins }];
    });
    const receivedAt =
      words
        .flatMap((word) => word.origins.map((entry) => entry.at))
        .sort()
        .at(-1) ?? run.updatedAt;
    const metrics = {
      averageMonthPv: discoveryDefaultMonthlySearches,
      averageMonthPvSource: "默认值（非实测）",
    };
    this.db.transaction(() => {
      const queryId = id("traffic");
      this.db.run(
        "INSERT INTO traffic_queries(id,origin,endpoint,phase,request,seeds,platform,status,started_at,received_at,response,message) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        queryId,
        origin,
        "baidu-discovery",
        "query",
        JSON.stringify({
          runId: run.id,
          query: query.word,
          seed: query.seed,
          depth: query.depth,
          source,
          sourceLabel: discoverySourceLabels[source],
        }),
        JSON.stringify([query.seed]),
        "baidu",
        "success",
        receivedAt,
        receivedAt,
        packTrafficArchive(
          JSON.stringify({ words, metrics, indexed: words.length }),
        ),
        `${discoverySourceLabels[source]}：收录${words.length}词；月均搜索量默认${discoveryDefaultMonthlySearches}，不是百度实测数据。`,
      );
      for (const word of words) {
        this.db.run(
          "INSERT INTO traffic_items(id,query_id,kind,word,normalized_word,platform,source,source_key,metrics,observed_at,source_updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          id("observation"),
          queryId,
          "word",
          word.word,
          normalize(word.word),
          "baidu",
          discoveryKnowledgeSource,
          "baidu-discovery",
          JSON.stringify(metrics),
          word.origins
            .map((entry) => entry.at)
            .sort()
            .at(-1) ?? receivedAt,
          null,
        );
      }
    });
  }
  archiveDiscovery(run: DiscoveryRun) {
    for (const query of run.queries)
      for (const source of query.completedSources)
        this.ingestDiscovery(run, query, source);
  }
  recoverBaidu() {
    for (const row of this.db.all<{ value: string }>(
      "SELECT value FROM api_cache WHERE key LIKE 'baidu-keywords:latest:%'",
    )) {
      const result = baiduKeywordResultSchema.safeParse(
        parseJson(row.value, null),
      );
      if (result.success) {
        try {
          this.ingestBaidu(result.data);
        } catch {
          /* Local result reads expose a retryable archive warning. */
        }
      }
    }
  }
  begin(
    callId: string,
    endpoint: Endpoint,
    phase: string,
    body: Record<string, string>,
    secret: string,
  ) {
    const seeds = body.taskid
      ? parseJson<string[]>(
          this.db.get<{ seeds: string }>(
            "SELECT seeds FROM async_queries WHERE task_id=?",
            body.taskid,
          )?.seeds,
          [],
        )
      : (body.keywords
          ? body.keywords.split("|")
          : [body.word ?? body.keyword ?? ""]
        ).filter(Boolean);
    const queryId = id("traffic");
    this.db.run(
      "INSERT INTO traffic_queries(id,call_id,endpoint,phase,request,seeds,platform,status,started_at) VALUES(?,?,?,?,?,?,?,?,?)",
      queryId,
      callId,
      endpoint,
      phase,
      JSON.stringify(cleanKnowledge(body, secret)),
      JSON.stringify(cleanKnowledge(seeds, secret)),
      body.platform ?? null,
      "requested",
      now(),
    );
    return queryId;
  }
  receive(
    queryId: string,
    raw: unknown,
    httpStatus: number | null,
    secret: string,
  ) {
    const row = this.db.get<any>(
      "SELECT * FROM traffic_queries WHERE id=?",
      queryId,
    );
    if (!row || row.response != null) return; // one immutable response per external attempt
    const parsed = typeof raw === "string" ? parseJson<unknown>(raw, raw) : raw;
    const clean = cleanKnowledge(parsed, secret),
      value: any = typeof clean === "string" ? null : clean;
    const received = now();
    this.db.run(
      "UPDATE traffic_queries SET response=?,received_at=?,http_status=?,status='received' WHERE id=?",
      packTrafficArchive(
        typeof clean === "string" ? clean : JSON.stringify(clean),
      ),
      received,
      httpStatus,
      queryId,
    );
    // Commit the envelope before indexing so a new/malformed row cannot lose a paid response.
    if (
      value &&
      typeof value === "object" &&
      String(value.errcode ?? value.error_code ?? "") === "0" &&
      (httpStatus == null || httpStatus < 400)
    ) {
      this.db.transaction(() =>
        this.extract(queryId, row.endpoint, value, row.platform, received),
      );
    }
  }

  finish(queryId: string, status: string, message = "") {
    this.db.run(
      "UPDATE traffic_queries SET status=?,message=? WHERE id=?",
      status,
      String(cleanKnowledge(message)),
      queryId,
    );
  }
  private extract(
    queryId: string,
    endpoint: Endpoint | "unknown",
    value: any,
    platform: string | null,
    observedAt: string | null,
    normalized = false,
  ) {
    const sourceName =
      endpoint === "unknown" ? "5118 旧记录（接口未知）" : sources[endpoint];
    const data = value?.data;
    const words = normalized
      ? value?.keywords
      : endpoint === "longtail"
        ? data?.word
        : endpoint === "suggest"
          ? data
          : endpoint === "metrics"
            ? data?.keyword_param
            : [];
    const hotspots = normalized
      ? value?.hotspots
      : endpoint === "radar"
        ? Array.isArray(data)
          ? data
          : (data?.list ?? data?.hot_list ?? data?.radar)
        : [];
    for (const [kind, rows] of [
      ["word", words],
      ["hotspot", hotspots],
    ] as const) {
      if (!Array.isArray(rows)) continue;
      for (const r of rows) {
        if (!r || typeof r !== "object") continue;
        const title =
          kind === "word"
            ? (r.word ?? r.promote_word ?? r.keyword)
            : (r.title ?? r.hot_name);
        if (typeof title !== "string" && typeof title !== "number") continue;
        const word = String(title).trim();
        if (!word) continue;
        const metrics =
          normalized && r.metrics && typeof r.metrics === "object"
            ? Object.fromEntries(
                Object.entries(r.metrics).filter(
                  ([, v]) =>
                    v == null || ["number", "string"].includes(typeof v),
                ),
              )
            : Object.fromEntries(
                Object.entries(r).filter(
                  ([key, v]) =>
                    /index|_exp$|pv$|count|price/.test(key) &&
                    ["string", "number"].includes(typeof v),
                ),
              );
        this.db.run(
          "INSERT INTO traffic_items(id,query_id,kind,word,normalized_word,platform,source,source_key,metrics,observed_at,source_updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          id("observation"),
          queryId,
          kind,
          word,
          normalize(word),
          typeof r.platform === "string" ? r.platform : platform,
          normalized && typeof r.source === "string" ? r.source : sourceName,
          normalized ? null : endpoint,
          JSON.stringify(metrics),
          normalized && typeof r.fetchedAt === "string"
            ? r.fetchedAt
            : observedAt,
          scalarText(r.sourceUpdatedAt ?? r.add_time ?? r.update_date),
        );
      }
    }
  }
  recoverLegacy() {
    if (
      this.db.get(
        "SELECT key FROM traffic_knowledge_meta WHERE key='legacyRecovered:v1'",
      )
    )
      return;
    // Only records still present locally can be recovered. Unknown dates/queries stay unknown.
    const recover = (
      origin: string,
      raw: string,
      endpoint: Endpoint | "unknown",
      seeds: string[] = [],
      platform: string | null = null,
      received: string | null = null,
      normalized = true,
    ) => {
      const value = parseJson<any>(raw, null);
      if (!value || typeof value !== "object") return;
      const key = origin + ":" + createHash("sha256").update(raw).digest("hex");
      if (this.db.get("SELECT id FROM traffic_queries WHERE origin=?", key))
        return;
      const queryId = id("legacy");
      const acquired = received ?? scalarText(value._panxuFetchedAt);
      this.db.transaction(() => {
        this.db.run(
          "INSERT INTO traffic_queries(id,origin,endpoint,phase,request,seeds,platform,status,received_at,response,message,legacy) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)",
          queryId,
          key,
          endpoint,
          "legacy",
          "{}",
          JSON.stringify(cleanKnowledge(seeds)),
          platform,
          "recovered",
          acquired,
          packTrafficArchive(JSON.stringify(cleanKnowledge(value))),
          "旧记录恢复，仅包含仍存缓存或整理结果；可能缺少原始响应字段、查询参数和采集时间，同一结果可能来自多个旧缓存。",
        );
        this.extract(
          queryId,
          endpoint,
          cleanKnowledge(value),
          platform,
          acquired,
          normalized,
        );
      });
    };
    for (const row of this.db.all<any>("SELECT * FROM api_cache")) {
      if (row.key.startsWith("baidu-keywords:latest:")) continue;
      const v = parseJson<any>(row.value, {});
      if (Array.isArray(v?.data?.word))
        recover(
          `cache:${row.key}`,
          row.value,
          "longtail",
          [],
          null,
          null,
          false,
        );
      else if (Array.isArray(v?.keywords) || Array.isArray(v?.hotspots)) {
        const source = v.keywords?.[0]?.source ?? "";
        const endpoint: Endpoint | "unknown" = v.hotspots?.length
          ? "radar"
          : /下拉/.test(source)
            ? "suggest"
            : /搜索量/.test(source)
              ? "metrics"
              : /长尾/.test(source)
                ? "longtail"
                : "unknown";
        recover(`cache:${row.key}`, row.value, endpoint);
      }
    }
    for (const row of this.db.all<any>(
      "SELECT * FROM suggestion_queries WHERE result IS NOT NULL",
    ))
      recover(
        `suggestion:${row.id}`,
        row.result,
        "suggest",
        [row.seed],
        row.platform,
      );
    for (const row of this.db.all<any>(
      "SELECT * FROM async_queries WHERE result IS NOT NULL",
    ))
      recover(
        `task:${row.task_id}`,
        row.result,
        "metrics",
        parseJson(row.seeds, []),
      );
    this.db.run(
      "INSERT OR REPLACE INTO traffic_knowledge_meta(key,value) VALUES('legacyRecovered:v1',?)",
      now(),
    );
  }
  list(raw: unknown) {
    return this.reader.list(raw);
  }
  overview() {
    return this.reader.overview();
  }
  resolve(raw: unknown) {
    return this.reader.resolve(raw);
  }
  history(raw: unknown) {
    return this.reader.history(raw);
  }
  detail(queryId: string) {
    return this.reader.detail(queryId);
  }
  export(raw: unknown) {
    return this.reader.export(raw);
  }
}

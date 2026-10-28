import { createHash } from "node:crypto";
import { Database, id, now, parseJson } from "./database";
import { AppError } from "./errors";
import { csv } from "./csv";
import { cleanKnowledge } from "./knowledge-response";
export { cleanKnowledge } from "./knowledge-response";
import {
  baiduKeywordResultSchema,
  baiduKeywordSource,
} from "../shared/baidu-keywords";
import type { Endpoint } from "../shared/types";
import {
  knowledgeFilter,
  type KnowledgeFilter,
  type KnowledgeItem,
  type KnowledgeQuery,
  type KnowledgePage,
} from "../shared/traffic-knowledge";

const sources = {
  longtail: "5118 长尾词 v2",
  suggest: "5118 下拉联想词",
  metrics: "5118 搜索量 v2",
  radar: "5118 热点雷达",
};
const scalarText = (v: unknown) =>
  typeof v === "string" || typeof v === "number" ? String(v) : null;
const normalize = (s: string) => s.normalize("NFKC").trim().toLowerCase();
const decode = (row: any): KnowledgeQuery => ({
  id: row.id,
  endpoint: row.endpoint,
  phase: row.phase,
  request: parseJson(row.request, {}),
  seeds: parseJson(row.seeds, []),
  platform: row.platform,
  status: row.status,
  startedAt: row.started_at,
  receivedAt: row.received_at,
  httpStatus: row.http_status,
  message: row.message,
  legacy: Boolean(row.legacy),
  count: Number(row.count ?? 0),
});
export class TrafficKnowledge {
  constructor(private db: Database) {}
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
      }>(prior.response, { indexed: 0 });
      return {
        indexed: archived.indexed,
        refreshedBelowThreshold: archived.refreshedBelowThreshold ?? 0,
        minimumMonthlySearches: 10,
      };
    }
    const existing = new Set(
      this.db
        .all<{ normalized_word: string }>(
          "SELECT DISTINCT normalized_word FROM traffic_items WHERE kind='word' AND source=?",
          baiduKeywordSource,
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
      const boundedLow=typeof value==="string"&&/^<\s*[1-9]$/.test(value.trim());
      if (!Number.isFinite(monthly)&&!boundedLow) return false;
      if (monthly > 10) {
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
        JSON.stringify({
          keywords,
          fetchedAt: result.fetchedAt,
          received: result.keywords.length,
          ...summary,
          rule: "新词 averageMonthPv > 10；已有词更新有效指标",
        }),
        `月均搜索量大于10：收录或更新${indexed}词，另更新${refreshedBelowThreshold}个已收录的低搜索量词；同来源同词展示最新指标，历史采集保留。`,
      );
      for (const keyword of keywords) {
        this.db.run(
          "INSERT INTO traffic_items(id,query_id,kind,word,normalized_word,platform,source,metrics,data,observed_at,source_updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          id("observation"),
          queryId,
          "word",
          keyword.word,
          normalize(keyword.word),
          "baidu",
          baiduKeywordSource,
          JSON.stringify(cleanKnowledge(keyword.metrics)),
          JSON.stringify(cleanKnowledge(keyword)),
          result.fetchedAt,
          keyword.sourceUpdatedAt,
        );
      }
    });
    return summary;
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
      typeof clean === "string" ? clean : JSON.stringify(clean),
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
          "INSERT INTO traffic_items(id,query_id,kind,word,normalized_word,platform,source,metrics,data,observed_at,source_updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          id("observation"),
          queryId,
          kind,
          word,
          normalize(word),
          typeof r.platform === "string" ? r.platform : platform,
          normalized && typeof r.source === "string" ? r.source : sourceName,
          JSON.stringify(metrics),
          JSON.stringify(r),
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
          JSON.stringify(cleanKnowledge(value)),
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
  private conditions(f: KnowledgeFilter, items: boolean) {
    const args: string[] = [],
      clauses = [];
    if (f.endpoint) {
      clauses.push("q.endpoint=?");
      args.push(f.endpoint);
    }
    if (f.platform) {
      clauses.push(
        items ? "coalesce(i.platform,'')=?" : "coalesce(q.platform,'')=?",
      );
      args.push(f.platform);
    }
    if (f.search) {
      clauses.push(
        items
          ? "instr(lower(i.word),lower(?))>0"
          : "(instr(lower(q.seeds),lower(?))>0 OR EXISTS(SELECT 1 FROM traffic_items x WHERE x.query_id=q.id AND instr(lower(x.word),lower(?))>0))",
      );
      args.push(f.search);
      if (!items) args.push(f.search);
    }
    return {
      where: clauses.length ? "WHERE " + clauses.join(" AND ") : "",
      args,
    };
  }
  list(raw: unknown): KnowledgePage {
    const f = knowledgeFilter.parse(raw),
      { where, args } = this.conditions(f, f.view === "items"),
      pageSize = f.view === "items" ? 50 : 20;
    const partition =
      "i.kind,i.normalized_word,coalesce(i.platform,''),i.source";
    const cte = `WITH ranked AS (SELECT i.*,q.endpoint,COUNT(*) OVER(PARTITION BY ${partition}) observations,MIN(i.observed_at) OVER(PARTITION BY ${partition}) first_observed_at,ROW_NUMBER() OVER(PARTITION BY ${partition} ORDER BY coalesce(i.observed_at,'') DESC,i.rowid DESC) rn FROM traffic_items i JOIN traffic_queries q ON q.id=i.query_id ${where})`;
    const total = Number(
      this.db.get<any>(
        f.view === "items"
          ? cte + " SELECT COUNT(*) n FROM ranked WHERE rn=1"
          : `SELECT COUNT(*) n FROM traffic_queries q ${where}`,
        ...args,
      )?.n ?? 0,
    );
    const items =
      f.view === "items"
        ? this.db
            .all<any>(
              cte +
                " SELECT * FROM ranked WHERE rn=1 ORDER BY coalesce(observed_at,'') DESC,word LIMIT ? OFFSET ?",
              ...args,
              pageSize,
              (f.page - 1) * pageSize,
            )
            .map((r): KnowledgeItem => ({
              id: r.id,
              queryId: r.query_id,
              kind: r.kind,
              word: r.word,
              platform: r.platform,
              source: r.source,
              metrics: parseJson(r.metrics, {}),
              observedAt: r.observed_at,
              firstObservedAt: r.first_observed_at,
              sourceUpdatedAt: r.source_updated_at,
              observations: r.observations,
            }))
        : [];
    const queries =
      f.view === "queries"
        ? this.db
            .all<any>(
              `SELECT q.*,(SELECT COUNT(*) FROM traffic_items i WHERE i.query_id=q.id) count FROM traffic_queries q ${where} ORDER BY coalesce(q.received_at,q.started_at,'') DESC,q.rowid DESC LIMIT ? OFFSET ?`,
              ...args,
              pageSize,
              (f.page - 1) * pageSize,
            )
            .map(decode)
        : [];
    const summary = this.db.get<any>(
      `SELECT (SELECT COUNT(*) FROM traffic_queries) queries,(SELECT COUNT(*) FROM traffic_queries WHERE response IS NOT NULL) responses,(SELECT COUNT(DISTINCT normalized_word) FROM traffic_items WHERE kind='word') words,(SELECT COUNT(DISTINCT normalized_word) FROM traffic_items WHERE kind='hotspot') hotspots,(SELECT COUNT(*) FROM traffic_items) observations,(SELECT COUNT(*) FROM traffic_queries WHERE legacy=1) legacy`,
    )!;
    const seeds = this.db.all<any>(
      `SELECT j.value word,COUNT(DISTINCT CASE WHEN q.phase IN ('query','submit') THEN q.id END) queries,COUNT(DISTINCT i.id) results FROM traffic_queries q JOIN json_each(q.seeds) j LEFT JOIN traffic_items i ON i.query_id=q.id WHERE q.legacy=0 AND q.response IS NOT NULL GROUP BY j.value HAVING queries>0 ORDER BY queries DESC,word LIMIT 10`,
    );
    const patterns = [
      ["教程 / 操作步骤", ["教程", "怎么", "如何", "步骤"]],
      ["问题 / 排错", ["失败", "错误", "无法", "怎么办"]],
      ["选择 / 对比", ["区别", "对比", "哪个好", "推荐"]],
      ["价格 / 获取", ["价格", "费用", "免费", "下载"]],
    ] as [string, string[]][];
    return {
      total,
      page: f.page,
      pageSize,
      items,
      queries,
      summary,
      seeds,
      patterns: patterns.map(([name, terms]) => ({
        name,
        count: Number(
          this.db.get<any>(
            `SELECT COUNT(DISTINCT normalized_word) n FROM traffic_items WHERE kind='word' AND (${terms.map(() => "instr(word,?)>0").join(" OR ")})`,
            ...terms,
          )?.n ?? 0,
        ),
      })),
    };
  }
  detail(queryId: string) {
    const r = this.db.get<any>(
      "SELECT q.*,(SELECT COUNT(*) FROM traffic_items i WHERE i.query_id=q.id) count FROM traffic_queries q WHERE q.id=?",
      queryId,
    );
    if (!r) throw new AppError("NOT_FOUND", "查询档案不存在。");
    return { query: decode(r), response: r.response as string | null };
  }
  export(raw: unknown) {
    const f = knowledgeFilter.parse(raw),
      { where, args } = this.conditions(f, f.view === "items");
    const rows = this.db.all<any>(
      `SELECT i.*,q.endpoint,q.seeds,q.legacy FROM traffic_items i JOIN traffic_queries q ON q.id=i.query_id ${where} ORDER BY i.rowid`,
      ...args,
    );
    return csv([
      [
        "词语/热点",
        "类别",
        "平台",
        "来源",
        "种子词",
        "采集时间",
        "源更新时间",
        "指标",
        "查询档案ID",
        "旧记录恢复",
      ],
      ...rows.map((r) => [
        r.word,
        r.kind,
        r.platform,
        r.source,
        parseJson<string[]>(r.seeds, []).join(" | "),
        r.observed_at,
        r.source_updated_at,
        r.metrics,
        r.query_id,
        r.legacy ? "是" : "否",
      ]),
    ]);
  }
}

import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "./database";
import { parseJson } from "./database";
import { AppError } from "./errors";
import { csv } from "./csv";
import {
  metricVolume,
  metricMonthly,
  unpackTrafficArchive,
  normalizeTrafficWord as normalize,
} from "./traffic-knowledge-store";
import {
  knowledgeFilter,
  knowledgeHistoryInput,
  longtailKnowledgeEndpoints,
  type KnowledgeFilter,
  type KnowledgeItem,
  type KnowledgeQuery,
  type KnowledgePage,
  type KnowledgeHistory,
  type KnowledgeOverview,
} from "../shared/traffic-knowledge";

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
/** Null means the current entry pointer; an empty intersection matches nothing. */
function observationEndpoints(
  filter: KnowledgeFilter,
): readonly string[] | null {
  if (filter.kind === "longtail") {
    if (!filter.endpoint) return longtailKnowledgeEndpoints;
    return longtailKnowledgeEndpoints.some(
      (endpoint) => endpoint === filter.endpoint,
    )
      ? [filter.endpoint]
      : [];
  }
  return filter.endpoint ? [filter.endpoint] : null;
}
const endpointPredicate = (column: string, endpoints: readonly string[]) =>
  endpoints.length
    ? `${column} IN (${endpoints.map(() => "?").join(",")})`
    : "0";
/** Indexed current entries and explicit cold-history reads. */
export class TrafficKnowledgeReader {
  constructor(private db: Database) {}
  private conditions(f: KnowledgeFilter, items: boolean) {
    const args: string[] = [],
      clauses = [];
    const endpoints = observationEndpoints(f);
    if (endpoints) {
      clauses.push(endpointPredicate("q.endpoint", endpoints));
      args.push(...endpoints);
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
    if (f.kind) {
      clauses.push(
        items
          ? "i.kind=?"
          : "EXISTS(SELECT 1 FROM traffic_items x WHERE x.query_id=q.id AND x.kind=?)",
      );
      args.push(f.kind === "longtail" ? "word" : f.kind);
    }
    if (f.volume) {
      clauses.push(
        items
          ? `${metricVolume("i.metrics")}=?`
          : `EXISTS(SELECT 1 FROM traffic_items x WHERE x.query_id=q.id ${f.kind === "longtail" ? "AND x.kind='word'" : ""} AND ${metricVolume("x.metrics")}=?)`,
      );
      args.push(f.volume);
    }
    return {
      where: clauses.length ? "WHERE " + clauses.join(" AND ") : "",
      args,
    };
  }
  private summaryCache?: {
    revision: number;
    value: KnowledgeOverview;
  };
  overview(): KnowledgeOverview {
    const revision = this.db.get<{ revision: number }>(
      "SELECT revision FROM traffic_knowledge_state WHERE id=1",
    )!.revision;
    if (this.summaryCache?.revision === revision)
      return this.summaryCache.value;
    const summary = this.db.get<any>(
      `SELECT (SELECT COUNT(*) FROM traffic_queries) queries,
      (SELECT COUNT(*) FROM traffic_queries WHERE response IS NOT NULL) responses,
      (SELECT COUNT(DISTINCT normalized_word) FROM traffic_entries WHERE kind='word') words,
      (SELECT COUNT(DISTINCT normalized_word) FROM traffic_entries WHERE kind='hotspot') hotspots,
      (SELECT coalesce(sum(observation_count),0) FROM traffic_entries) observations,
      (SELECT COUNT(*) FROM traffic_queries WHERE legacy=1) legacy`,
    )!;
    const seeds = this.db.all<any>(
      `WITH seed_queries AS (SELECT DISTINCT q.id,j.value word,q.phase,q.item_count
        FROM traffic_queries q JOIN json_each(q.seeds) j WHERE q.legacy=0 AND q.response IS NOT NULL)
      SELECT word,sum(CASE WHEN phase IN ('query','submit') THEN 1 ELSE 0 END) queries,
        sum(item_count) results FROM seed_queries GROUP BY word HAVING queries>0 ORDER BY queries DESC,word LIMIT 10`,
    );
    const definitions: [string, string[]][] = [
      ["教程 / 操作步骤", ["教程", "怎么", "如何", "步骤"]],
      ["问题 / 排错", ["失败", "错误", "无法", "怎么办"]],
      ["选择 / 对比", ["区别", "对比", "哪个好", "推荐"]],
      ["价格 / 获取", ["价格", "费用", "免费", "下载"]],
    ];
    const patterns = definitions.map(([name, terms]) => ({
      name,
      count: Number(
        this.db.get<any>(
          `SELECT COUNT(DISTINCT normalized_word) n FROM traffic_entries WHERE kind='word' AND (${terms.map(() => "instr(word,?)>0").join(" OR ")})`,
          ...terms,
        )?.n ?? 0,
      ),
    }));
    const value = { revision, summary, seeds, patterns };
    this.summaryCache = { revision, value };
    return value;
  }
  private item(row: any): KnowledgeItem {
    return {
      id: row.id,
      entryId: row.entry_id,
      queryId: row.query_id,
      kind: row.kind,
      word: row.word,
      platform: row.platform || null,
      source: row.source,
      metrics: parseJson(row.metrics, {}),
      observedAt: row.observed_at,
      firstObservedAt: row.first_observed_at,
      sourceUpdatedAt: row.source_updated_at,
      observations: Number(row.observations),
      sourceKey: row.source_key,
      endpoint: row.endpoint,
    };
  }
  list(raw: unknown): KnowledgePage {
    const f = knowledgeFilter.parse(raw);
    const pageSize = f.view === "items" ? 50 : 20;
    let total: number;
    let items: KnowledgeItem[] = [];
    let queries: KnowledgeQuery[] = [];
    let nextCursor: string | null = null;
    if (f.view === "items") {
      const args: (string | number)[] = [];
      const clauses: string[] = [];
      if (f.endpoint) {
        clauses.push("e.endpoint=?");
        args.push(f.endpoint);
      }
      if (f.search) {
        clauses.push("instr(e.normalized_word,?)>0");
        args.push(normalize(f.search));
      }
      if (f.platform) {
        clauses.push("e.platform=?");
        args.push(f.platform);
      }
      if (f.kind === "longtail") clauses.push("e.is_longtail=1");
      else if (f.kind) {
        clauses.push("e.kind=?");
        args.push(f.kind);
      }
      if (f.volume) {
        clauses.push("e.volume_kind=?");
        args.push(f.volume);
      }
      const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
      // A page counts the compact current records, never joins or ranks history.
      total = Number(
        this.db.get<{ n: number }>(
          `SELECT count(*) n FROM traffic_entries e${where}`,
          ...args,
        )?.n ?? 0,
      );
      const sortColumn =
        f.sort === "word"
          ? "e.word"
          : f.sort === "monthly"
            ? "e.monthly_searches"
            : "e.last_observed_at";
      const direction = f.sort === "word" ? "ASC" : "DESC";
      const signature = createHash("sha256")
        .update(
          JSON.stringify([
            f.search,
            f.endpoint,
            f.platform,
            f.kind,
            f.volume,
            f.sort,
          ]),
        )
        .digest("hex")
        .slice(0, 24);
      const pageArgs: (string | number | null)[] = [...args];
      const pageClauses = [...clauses];
      if (f.cursor) {
        let cursor: {
          version: 1;
          signature: string;
          value: string | number | null;
          seq: number;
        };
        try {
          cursor = z
            .object({
              version: z.literal(1),
              signature: z.string(),
              value: z.union([z.string(), z.number().finite(), z.null()]),
              seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            })
            .parse(
              JSON.parse(Buffer.from(f.cursor, "base64url").toString("utf8")),
            );
          if (cursor.signature !== signature) throw new Error("filter changed");
          if (
            (f.sort === "monthly" &&
              cursor.value !== null &&
              typeof cursor.value !== "number") ||
            (f.sort !== "monthly" && typeof cursor.value !== "string")
          )
            throw new Error("invalid sort value");
        } catch {
          throw new AppError(
            "INVALID_CURSOR",
            "词库分页位置已失效，请从第一页重新读取。",
          );
        }
        if (f.sort === "monthly") {
          if (cursor.value === null) {
            pageClauses.push("e.monthly_searches IS NULL AND e.seq<?");
            pageArgs.push(cursor.seq);
          } else {
            pageClauses.push(
              "(e.monthly_searches<? OR e.monthly_searches IS NULL OR (e.monthly_searches=? AND e.seq<?))",
            );
            pageArgs.push(cursor.value, cursor.value, cursor.seq);
          }
        } else {
          pageClauses.push(
            `(${sortColumn},e.seq) ${f.sort === "word" ? ">" : "<"} (?,?)`,
          );
          pageArgs.push(cursor.value, cursor.seq);
        }
      }
      const pageWhere = pageClauses.length
        ? " WHERE " + pageClauses.join(" AND ")
        : "";
      const rows = this.db.all<any>(
        `SELECT i.*,e.id entry_id,e.seq cursor_seq,e.source_key,e.endpoint,e.kind,e.source,nullif(e.platform,'') platform,
        e.observation_count observations,e.first_observed_at,${sortColumn} cursor_value
        FROM traffic_entries e JOIN traffic_observations i ON i.seq=e.latest_observation_seq
        ${pageWhere} ORDER BY ${sortColumn} ${direction},e.seq ${direction} LIMIT ? OFFSET ?`,
        ...pageArgs,
        pageSize + 1,
        f.cursor === undefined ? (f.page - 1) * pageSize : 0,
      );
      const pageRows = rows.slice(0, pageSize);
      items = pageRows.map((row) => this.item(row));
      if (rows.length > pageSize) {
        const last = pageRows.at(-1)!;
        nextCursor = Buffer.from(
          JSON.stringify({
            version: 1,
            signature,
            value: last.cursor_value,
            seq: last.cursor_seq,
          }),
        ).toString("base64url");
      }
    } else {
      const { where, args } = this.conditions(f, false);
      total = Number(
        this.db.get<{ n: number }>(
          `SELECT count(*) n FROM traffic_queries q ${where}`,
          ...args,
        )?.n ?? 0,
      );
      const queryCount =
        f.kind === "longtail"
          ? "(SELECT count(*) FROM traffic_items x WHERE x.query_id=q.id AND x.kind='word')"
          : "q.item_count";
      queries = this.db
        .all<any>(
          `SELECT q.id,q.endpoint,q.phase,q.request,q.seeds,q.platform,q.status,q.started_at,q.received_at,q.http_status,q.message,q.legacy,
        ${queryCount} count FROM traffic_queries q ${where} ORDER BY coalesce(q.received_at,q.started_at,'') DESC,q.rowid DESC LIMIT ? OFFSET ?`,
          ...args,
          pageSize,
          (f.page - 1) * pageSize,
        )
        .map(decode);
    }
    return { total, page: f.page, pageSize, items, queries, nextCursor };
  }
  resolve(raw: unknown): { items: KnowledgeItem[]; missingIds: string[] } {
    const { observationIds } = z
      .object({ observationIds: z.array(z.string().min(1).max(200)).max(1000) })
      .parse(raw);
    const ids = [...new Set(observationIds)];
    if (!ids.length) return { items: [], missingIds: [] };
    const rows = this.db.all<any>(
      `SELECT o.*,e.id entry_id,e.kind,e.source,e.source_key,e.endpoint,nullif(e.platform,'') platform,
      e.first_observed_at,e.observation_count observations FROM traffic_observations o JOIN traffic_entries e ON e.id=o.entry_id
      WHERE o.id IN (${ids.map(() => "?").join(",")})`,
      ...ids,
    );
    const snapshots = new Map(
      rows.map((row) => [String(row.id), this.item(row)]),
    );
    return {
      items: ids
        .filter((id) => snapshots.has(id))
        .map((id) => snapshots.get(id)!),
      missingIds: ids.filter((id) => !snapshots.has(id)),
    };
  }
  history(raw: unknown): KnowledgeHistory {
    const { entryId, page } = knowledgeHistoryInput.parse(raw);
    const entry = this.db.get<any>(
      "SELECT * FROM traffic_entries WHERE id=?",
      entryId,
    );
    if (!entry) throw new AppError("NOT_FOUND", "词条不存在。");
    const pageSize = 20;
    const items = this.db
      .all<any>(
        `SELECT o.*,e.id entry_id,e.kind,e.source,e.source_key,e.endpoint,nullif(e.platform,'') platform,
      e.first_observed_at,e.observation_count observations FROM traffic_observations o
      JOIN traffic_entries e ON e.id=o.entry_id WHERE o.entry_id=?
      ORDER BY coalesce(o.observed_at,'') DESC,o.seq DESC LIMIT ? OFFSET ?`,
        entryId,
        pageSize,
        (page - 1) * pageSize,
      )
      .map((row) => this.item(row));
    return {
      entry: {
        entryId,
        word: entry.word,
        kind: entry.kind,
        platform: entry.platform || null,
        source: entry.source,
      },
      total: Number(entry.observation_count),
      page,
      pageSize,
      items,
    };
  }
  detail(queryId: string) {
    const r = this.db.get<any>(
      "SELECT q.*,q.item_count count FROM traffic_queries q WHERE q.id=?",
      queryId,
    );
    if (!r) throw new AppError("NOT_FOUND", "查询档案不存在。");
    return {
      query: decode(r),
      response: unpackTrafficArchive(r.response as string | null),
      ...(r.legacy_items
        ? { recoveredObservations: unpackTrafficArchive(r.legacy_items)! }
        : {}),
    };
  }
  export(raw: unknown) {
    const f = knowledgeFilter.parse(raw),
      { where, args } = this.conditions(f, f.view === "items");
    // Query views filter query archives. A long-tail export still contains only
    // keyword observations, even if an old archive also contains other kinds.
    let exportWhere =
      f.kind === "longtail" && f.view === "queries"
        ? `${where} AND i.kind='word'`
        : where;
    if (f.kind === "longtail" && f.view === "queries" && f.volume) {
      exportWhere += ` AND ${metricVolume("i.metrics")}=?`;
      args.push(f.volume);
    }
    const rows = this.db.all<any>(
      `SELECT i.*,q.endpoint,q.seeds,q.legacy FROM traffic_items i JOIN traffic_queries q ON q.id=i.query_id ${exportWhere} ORDER BY i.rowid`,
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

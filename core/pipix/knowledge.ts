import { createHash } from "node:crypto";
import { id, now, type Database } from "../database";
import { AppError, safeMessage } from "../errors";
import { cleanKnowledge } from "../knowledge-response";
import {
  pipixDiscoverInput,
  pipixKnowledgeInput,
  type PipixCandidate,
  type PipixDiscoveryPage,
  type PipixKnowledgePage,
} from "../../shared/pipix";
import {
  parsePipixDiscovery,
  pipixDiscoveryEntries,
  pipixDiscoveryId,
} from "./discovery";

type Request = ReturnType<typeof pipixDiscoverInput.parse>;
interface ResponseRow {
  id: string;
  query_key: string;
  generation: string;
  cursor: string;
  page: number;
  request: string;
  response: string | null;
  parsed: string | null;
  http_status: number | null;
  status: string;
  message: string;
  fetched_at: string;
}
const queryKey = (v: {
  mode: string;
  keyword: string;
  targetId: string;
  probe?: { parameter: string; value: number };
}) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        "pipix-tikhub:v1",
        v.mode,
        v.mode === "search" ? v.keyword.trim() : "",
        v.mode === "user" || v.mode === "topic" ? v.targetId : "",
        ...(v.probe ? [v.probe] : []),
      ]),
    )
    .digest("hex");

/** Complete response archive and a channel-independent, locally searchable post index. */
export class PipixKnowledge {
  constructor(private db: Database) {}
  private root(key: string) {
    return this.db.get<ResponseRow>(
      "SELECT * FROM content_source_responses WHERE provider='pipix' AND query_key=? AND page=0 ORDER BY rowid DESC LIMIT 1",
      key,
    );
  }
  cached(input: Request) {
    const key = queryKey(input),
      root = this.root(key);
    if (!root) return undefined;
    return this.db.get<ResponseRow>(
      "SELECT * FROM content_source_responses WHERE provider='pipix' AND query_key=? AND generation=? AND cursor=? AND page=? ORDER BY rowid DESC LIMIT 1",
      key,
      root.id,
      input.cursor,
      input.page,
    );
  }
  begin(input: Request) {
    const key = queryKey(input),
      root = this.root(key),
      responseId = id("source-response");
    if (input.page > 0) {
      const last =
        root &&
        this.db.get<ResponseRow>(
          "SELECT * FROM content_source_responses WHERE generation=? AND status='indexed' ORDER BY page DESC,rowid DESC LIMIT 1",
          root.id,
        );
      const next = last?.parsed && JSON.parse(last.parsed).nextCursor;
      if (
        !last ||
        last.status !== "indexed" ||
        next !== input.cursor ||
        input.page !== last.page + 1
      )
        throw new AppError(
          "PIPIX_CURSOR",
          "分页进度已变化，请先刷新本地知识库，再获取下一页。",
        );
    }
    this.db.run(
      "INSERT INTO content_source_responses(id,provider,query_key,cursor,page,generation,request,status,fetched_at) VALUES(?,'pipix',?,?,?,?,?,'requested',?)",
      responseId,
      key,
      input.cursor,
      input.page,
      input.page === 0 ? responseId : root!.id,
      JSON.stringify({ ...input, force: false }),
      now(),
    );
    return responseId;
  }
  receive(responseId: string, body: string, httpStatus: number, key: string) {
    this.db.run(
      "UPDATE content_source_responses SET response=?,http_status=?,status='received',fetched_at=? WHERE id=?",
      String(cleanKnowledge(body, key)),
      httpStatus,
      now(),
      responseId,
    );
  }
  fail(responseId: string, error: unknown) {
    this.db.run(
      "UPDATE content_source_responses SET status='error',message=? WHERE id=?",
      safeMessage(error),
      responseId,
    );
  }
  private row(responseId: string) {
    const row = this.db.get<ResponseRow>(
      "SELECT * FROM content_source_responses WHERE id=?",
      responseId,
    );
    if (!row) throw new AppError("NOT_FOUND", "本地响应记录不存在。");
    return row;
  }
  reuse(row: ResponseRow): PipixDiscoveryPage {
    if (row.parsed)
      return {
        ...JSON.parse(row.parsed),
        cached: true,
        responseId: row.id,
        fetchedAt: row.fetched_at,
      };
    if (row.http_status === 200 && row.response !== null)
      return { ...this.index(row.id), cached: true };
    throw new AppError(
      "PIPIX_RESPONSE_SAVED",
      row.response !== null
        ? "上次响应已保存，但未返回可用数据。可检查服务状态后明确重新请求；不会自动重复计费。"
        : "上次请求结果未确认，为避免重复计费未再次发送。需要重试时请使用“重新请求第一页”。",
    );
  }
  index(responseId: string): PipixDiscoveryPage {
    const row = this.row(responseId),
      request = pipixDiscoverInput.parse(JSON.parse(row.request));
    if (row.http_status !== 200 || row.response === null)
      throw new AppError(
        "PIPIX_RESPONSE_SAVED",
        "该记录没有可重新解析的成功响应。",
      );
    const raw: unknown = JSON.parse(row.response),
      parsed = parsePipixDiscovery(raw, request);
    const originals = new Map(
      pipixDiscoveryEntries(raw).items.map((item) => [
        pipixDiscoveryId(item),
        item,
      ]),
    );
    if (
      parsed.nextCursor &&
      this.db.get(
        "SELECT id FROM content_source_responses WHERE generation=? AND cursor=? AND page<=? LIMIT 1",
        row.generation,
        parsed.nextCursor,
        row.page,
      )
    ) {
      parsed.nextCursor = null;
      parsed.warnings.push("上游返回了已获取的分页游标，已停止继续请求。");
    }
    this.db.transaction(() => {
      for (const item of parsed.items) {
        this.db.run(
          "INSERT INTO content_knowledge_items(provider,source_id,text,author,kind,data,raw,first_seen,last_seen) VALUES('pipix',?,?,?,?,?,?,?,?) ON CONFLICT(provider,source_id) DO UPDATE SET text=excluded.text,author=excluded.author,kind=excluded.kind,data=excluded.data,raw=excluded.raw,last_seen=excluded.last_seen",
          item.id,
          item.text,
          item.author,
          item.kind,
          JSON.stringify(item),
          JSON.stringify(originals.get(item.id)),
          row.fetched_at,
          row.fetched_at,
        );
        this.db.run(
          "INSERT OR IGNORE INTO content_knowledge_hits(response_id,provider,source_id) VALUES(?,'pipix',?)",
          responseId,
          item.id,
        );
      }
      this.db.run(
        "UPDATE content_source_responses SET parsed=?,status='indexed',message='' WHERE id=?",
        JSON.stringify(parsed),
        responseId,
      );
    });
    return { ...parsed, responseId, fetchedAt: row.fetched_at };
  }
  reindex() {
    let indexed = 0,
      failed = 0;
    for (const row of this.db.all<{ id: string }>(
      "SELECT id FROM content_source_responses WHERE provider='pipix' AND http_status=200 AND response IS NOT NULL ORDER BY rowid",
    )) {
      try {
        this.index(row.id);
        indexed++;
      } catch (e) {
        this.fail(row.id, e);
        failed++;
      }
    }
    return { indexed, failed };
  }
  source(sourceId: string): Record<string, any> | null {
    const row = this.db.get<{ raw: string }>(
      "SELECT raw FROM content_knowledge_items WHERE provider='pipix' AND source_id=?",
      sourceId,
    );
    return row ? JSON.parse(row.raw) : null;
  }
  reflected(responseId: string, parameter: string, value: number) {
    const response = this.row(responseId).response;
    if (!response) return false;
    const data = JSON.parse(response);
    return String(data.params?.[parameter]) === String(value);
  }
  read(raw: unknown): PipixKnowledgePage {
    const input = pipixKnowledgeInput.parse(raw),
      key = input.mode === "local" ? null : queryKey(input);
    const scope = key
      ? "EXISTS (SELECT 1 FROM content_knowledge_hits hit JOIN content_source_responses response ON response.id=hit.response_id WHERE hit.provider=item.provider AND hit.source_id=item.source_id AND response.query_key=?)"
      : "1=1";
    const clauses = ["item.provider='pipix'", scope],
      values: (string | number)[] = key ? [key] : [];
    if (input.onlyImages) clauses.push("item.kind IN ('images','text')");
    if (input.mode === "local" && input.keyword) {
      clauses.push(
        "(instr(lower(item.text),lower(?))>0 OR instr(lower(item.author),lower(?))>0 OR item.source_id=?)",
      );
      values.push(input.keyword, input.keyword, input.keyword);
    }
    const where = clauses.join(" AND ");
    const total = this.db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM content_knowledge_items item WHERE ${where}`,
      ...values,
    )!.n;
    const pageSize = 6,
      page = Math.min(input.page, Math.max(1, Math.ceil(total / pageSize)));
    const items = this.db
      .all<{ data: string }>(
        `SELECT item.data FROM content_knowledge_items item WHERE ${where} ORDER BY item.last_seen DESC,item.source_id DESC LIMIT ? OFFSET ?`,
        ...values,
        pageSize,
        (page - 1) * pageSize,
      )
      .map((row) => JSON.parse(row.data) as PipixCandidate);
    const root = key ? this.root(key) : undefined;
    const last = root
      ? this.db.get<ResponseRow>(
          "SELECT * FROM content_source_responses WHERE generation=? ORDER BY page DESC,rowid DESC LIMIT 1",
          root.id,
        )
      : undefined;
    const cursor = last?.parsed ? JSON.parse(last.parsed).nextCursor : null;
    return {
      items,
      total,
      page,
      pageSize,
      allPosts: this.db.get<{ n: number }>(
        "SELECT COUNT(*) n FROM content_knowledge_items WHERE provider='pipix'",
      )!.n,
      responses: this.db.get<{ n: number }>(
        "SELECT COUNT(*) n FROM content_source_responses WHERE provider='pipix' AND response IS NOT NULL",
      )!.n,
      unparsed: this.db.get<{ n: number }>(
        "SELECT COUNT(*) n FROM content_source_responses WHERE provider='pipix' AND http_status=200 AND response IS NOT NULL AND status<>'indexed'",
      )!.n,
      latestAt: last?.fetched_at ?? null,
      next:
        last?.status === "indexed" && cursor
          ? { cursor, page: last.page + 1 }
          : last && last.status !== "indexed" && last.http_status !== 200
            ? { cursor: last.cursor, page: last.page, retry: true }
            : null,
      hasQuery: !!root,
      warnings: last?.parsed
        ? JSON.parse(last.parsed).warnings
        : last?.message
          ? [last.message]
          : [],
    };
  }
}

import { createHash } from "node:crypto";
import { id, now, type Database } from "../database";
import { AppError, safeMessage } from "../errors";
import { cleanKnowledge } from "../knowledge-response";
import { readLimited } from "../http";
import {
  pipixCommentsRead,
  type PipixCommentResponse,
} from "../../shared/pipix-acquisition";
import type { PipixComment } from "../../shared/pipix";
import { parsePipixJson } from "./json";
import { parsePipixComments } from "./comments-parser";
import { readPipixPolicy } from "./request-budget";
import { pipixCommentExclusions } from "../../shared/pipix-acquisition";

interface Row {
  id: string;
  generation: string;
  cursor: string;
  page: number;
  request: string;
  response: string | null;
  http_status: number | null;
  parsed: string | null;
  status: string;
  message: string;
  fetched_at: string;
}
const keyFor = (sourceId: string) =>
  createHash("sha256").update(`pipix-comments:v1:${sourceId}`).digest("hex");
export class PipixComments {
  constructor(
    private db: Database,
    private request: typeof fetch = fetch,
  ) {}
  private root(sourceId: string) {
    return this.db.get<Row>(
      "SELECT * FROM content_source_responses WHERE provider='pipix-comments' AND query_key=? AND page=0 ORDER BY rowid DESC LIMIT 1",
      keyFor(sourceId),
    );
  }
  private rows(sourceId: string, generation: string) {
    return this.db.all<Row>(
      "SELECT * FROM content_source_responses WHERE provider='pipix-comments' AND query_key=? AND generation=? ORDER BY page,rowid",
      keyFor(sourceId),
      generation,
    );
  }
  next(
    sourceId: string,
    refresh = false,
  ):
    | { cached: PipixCommentResponse }
    | { cursor: string; page: number; generation: string | null } {
    const root = this.root(sourceId);
    if (!root || refresh) return { cursor: "0", page: 0, generation: null };
    const rows = this.rows(sourceId, root.id),
      last = rows.at(-1)!;
    const cached = this.reuse(last);
    if (!cached.nextCursor) return { cached };
    return {
      cursor: cached.nextCursor,
      page: last.page + 1,
      generation: root.id,
    };
  }
  begin(
    sourceId: string,
    cursor: string,
    page: number,
    generation: string | null,
  ) {
    const requestId = id("pipixcomments");
    this.db.run(
      "INSERT INTO content_source_responses(id,provider,query_key,cursor,page,generation,request,status,fetched_at) VALUES(?,'pipix-comments',?,?,?,?,?,'requested',?)",
      requestId,
      keyFor(sourceId),
      cursor,
      page,
      generation ?? requestId,
      JSON.stringify({ sourceId, cursor, page }),
      now(),
    );
    return requestId;
  }
  receive(requestId: string, body: string, status: number, key: string) {
    this.db.run(
      "UPDATE content_source_responses SET response=?,http_status=?,status='received',fetched_at=? WHERE id=?",
      String(cleanKnowledge(body, key)),
      status,
      now(),
      requestId,
    );
  }
  fail(requestId: string, error: unknown) {
    this.db.run(
      "UPDATE content_source_responses SET status='error',message=? WHERE id=?",
      safeMessage(error),
      requestId,
    );
  }
  private reuse(row: Row): PipixCommentResponse {
    if (row.parsed)
      return { ...JSON.parse(row.parsed), responseId: row.id, cached: true };
    if (row.http_status === 200 && row.response !== null)
      return { ...this.index(row.id), cached: true };
    throw new AppError(
      "PIPIX_COMMENTS_SAVED",
      row.response
        ? "上次评论响应已保存但不可用；先重建评论索引，或明确重新请求第一页。"
        : "上次评论请求结果未确认，未再次发送；如需重试，请明确重新请求第一页。",
    );
  }
  index(requestId: string): PipixCommentResponse {
    const row = this.db.get<Row>(
      "SELECT * FROM content_source_responses WHERE id=? AND provider='pipix-comments'",
      requestId,
    );
    if (!row || row.http_status !== 200 || row.response === null)
      throw new AppError(
        "PIPIX_COMMENTS_SAVED",
        "本地没有可解析的成功评论响应。",
      );
    const { sourceId } = JSON.parse(row.request),
      parsed = parsePipixComments(
        parsePipixJson(row.response),
        sourceId,
        row.cursor,
      );
    if (
      parsed.nextCursor &&
      this.db.get(
        "SELECT id FROM content_source_responses WHERE generation=? AND cursor=? AND page<=?",
        row.generation,
        parsed.nextCursor,
        row.page,
      )
    ) {
      parsed.nextCursor = null;
      parsed.hasMore = false;
      parsed.warnings.push("评论游标已出现过，已停止重复翻页。");
    }
    const saved = {
      items: parsed.items,
      nextCursor: parsed.nextCursor,
      hasMore: parsed.hasMore,
      warnings: parsed.warnings,
      returned: parsed.returned,
    };
    this.db.transaction(() => {
      for (const comment of parsed.items) {
        const itemKey = `${sourceId}:${comment.id}`;
        this.db.run(
          "INSERT INTO content_knowledge_items(provider,source_id,text,author,kind,data,raw,first_seen,last_seen) VALUES('pipix-comments',?,?,?,'comment',?,?,?,?) ON CONFLICT(provider,source_id) DO UPDATE SET text=excluded.text,author=excluded.author,data=excluded.data,raw=excluded.raw,last_seen=excluded.last_seen",
          itemKey,
          comment.text,
          comment.author,
          JSON.stringify({ ...comment, sourceId }),
          JSON.stringify(parsed.originals.get(comment.id)),
          row.fetched_at,
          row.fetched_at,
        );
        this.db.run(
          "INSERT OR IGNORE INTO content_knowledge_hits(response_id,provider,source_id) VALUES(?,'pipix-comments',?)",
          requestId,
          itemKey,
        );
      }
      this.db.run(
        "UPDATE content_source_responses SET parsed=?,status='indexed',message='' WHERE id=?",
        JSON.stringify(saved),
        requestId,
      );
    });
    return { ...saved, responseId: requestId, cached: false };
  }
  all(sourceId: string): PipixComment[] {
    const root = this.db.get<Row>(
      "SELECT * FROM content_source_responses WHERE provider='pipix-comments' AND query_key=? AND page=0 AND parsed IS NOT NULL ORDER BY rowid DESC LIMIT 1",
      keyFor(sourceId),
    );
    if (!root) return [];
    return this.db
      .all<{ data: string }>(
        "SELECT DISTINCT i.data FROM content_knowledge_items i JOIN content_knowledge_hits h ON h.provider=i.provider AND h.source_id=i.source_id JOIN content_source_responses r ON r.id=h.response_id WHERE i.provider='pipix-comments' AND r.generation=? ORDER BY i.last_seen DESC,i.source_id",
        root.id,
      )
      .map((row) => JSON.parse(row.data));
  }
  hasIndexed(sourceId: string) {
    return !!this.db.get(
      "SELECT id FROM content_source_responses WHERE provider='pipix-comments' AND query_key=? AND parsed IS NOT NULL LIMIT 1",
      keyFor(sourceId),
    );
  }
  usable(sourceId: string) {
    const terms = readPipixPolicy(this.db).excludedCommentTerms;
    return this.all(sourceId).filter(
      (comment) => !pipixCommentExclusions(comment, terms).length,
    );
  }
  read(raw: unknown) {
    const input = pipixCommentsRead.parse(raw),
      all = this.all(input.sourceId),
      root = this.root(input.sourceId),
      rows = root ? this.rows(input.sourceId, root.id) : [],
      last = rows.at(-1);
    const parsed = last?.parsed ? JSON.parse(last.parsed) : null,
      usable = this.usable(input.sourceId),
      labeled = usable.filter((comment) => /神评/.test(comment.label)).length,
      items = input.labeledOnly
        ? usable.filter((comment) => /神评/.test(comment.label))
        : usable,
      pageSize = 20,
      page = Math.min(
        input.page,
        Math.max(1, Math.ceil(items.length / pageSize)),
      );
    const issue =
      last && !last.parsed
        ? last.message || "评论响应等待本地解析或核对，未将失败当作空评论"
        : (parsed?.warnings ?? []).join(" ");
    return {
      sourceId: input.sourceId,
      items: items.slice((page - 1) * pageSize, page * pageSize),
      total: all.length,
      usableTotal: usable.length,
      excluded: all.length - usable.length,
      labeled,
      page,
      pageSize,
      responses: rows.length,
      latestAt: last?.fetched_at ?? null,
      hasMore: !!parsed?.nextCursor,
      nextCursor: parsed?.nextCursor ?? null,
      issue,
      needsAttention: !!last && !last.parsed,
    };
  }
  reindex(sourceId: string) {
    for (const row of this.db.all<{ id: string }>(
      "SELECT id FROM content_source_responses WHERE provider='pipix-comments' AND query_key=? AND http_status=200 AND response IS NOT NULL ORDER BY rowid",
      keyFor(sourceId),
    )) {
      try {
        this.index(row.id);
      } catch (error) {
        this.fail(row.id, error);
      }
    }
    return this.read({ sourceId });
  }
  async fetchPage(
    sourceId: string,
    cursor: string,
    key: string,
    signal: AbortSignal,
    received: (body: string, status: number) => void,
  ) {
    const url = new URL(
      "https://api.tikhub.io/api/v1/pipixia/app/fetch_post_comment_list",
    );
    url.searchParams.set("cell_id", sourceId);
    url.searchParams.set("cell_type", "1");
    url.searchParams.set("offset", cursor);
    let response: Response;
    try {
      response = await this.request(url.href, {
        headers: { Authorization: `Bearer ${key}` },
        redirect: "error",
        signal,
      });
    } catch {
      throw new AppError(
        "PIPIX_COMMENTS_NETWORK",
        "评论请求结果未确认；可能已被服务商处理并计费，不自动重试。",
      );
    }
    const body = await readLimited(response, 32 * 1024 * 1024);
    received(body, response.status);
    if (!response.ok)
      throw new AppError(
        "PIPIX_COMMENTS_HTTP",
        `评论接口返回HTTP ${response.status}；响应已保存，请核对Key、服务商余额或限制后再决定是否重试。`,
      );
  }
}

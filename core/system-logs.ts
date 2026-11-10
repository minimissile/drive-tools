import { queryMethods } from "../shared/ipc";
import {
  systemLogQuery,
  type SystemLogEntry,
  type SystemLogPage,
} from "../shared/system-logs";
import type { Database } from "./database";
import { AppError, safeMessage } from "./errors";
import { cleanKnowledge } from "./knowledge-response";
import { RuntimeLog } from "./runtime-log";

const reads = new Set<string>(queryMethods);
const domainAliases: Record<string, string> = {
  websiteAccounts: "website-accounts",
  contentSupply: "content-supply",
  intelligentOps: "intelligent-operations",
  resourceLanding: "resource-landing",
  resourceCatalog: "resource-catalog",
  resourceLinks: "resource",
};
// Historical billed-but-invalid AI results are exceptions too. Billing success
// must not make an interrupted generation disappear from this view.
const entries = `WITH entries AS (
  SELECT 'runtime:'||id id,domain,level,event,message,account_id,task_id,details,created_at
  FROM runtime_logs WHERE level IN ('warning','error')
  UNION ALL
  SELECT 'api:'||a.id,CASE WHEN a.endpoint='openrouter' THEN 'ai' ELSE 'api' END,
    CASE WHEN a.status='uncertain' THEN 'warning' ELSE 'error' END,
    a.phase,COALESCE(a.message,'调用失败'),NULL,NULL,
    json_object('apiCallId',a.id,'endpoint',a.endpoint,'billingStatus',a.status,
      'confirmedMicros',a.confirmed_micros,
      'model',CASE WHEN json_valid(d.value) THEN json_extract(d.value,'$.model')
        WHEN json_valid(c.value) THEN json_extract(c.value,'$.model') END,
      'finishReason',CASE WHEN json_valid(d.value) THEN json_extract(d.value,'$.finishReason')
        WHEN json_valid(c.value) THEN json_extract(c.value,'$.finishReason') END),a.created_at
  FROM api_calls a
  LEFT JOIN api_cache d ON d.key='ai-diagnostic:'||a.id
  LEFT JOIN api_cache c ON c.key='ai-response:'||a.id
  WHERE (a.status IN ('failed','uncertain') OR
    (a.status='success' AND a.message LIKE '%返回内容校验未通过%'))
    AND NOT EXISTS (SELECT 1 FROM runtime_logs r WHERE
      r.level IN ('warning','error') AND json_valid(r.details)
      AND json_extract(r.details,'$.apiCallId')=a.id)
)`;

/** Unified local exception view; never stores command inputs or article content. */
export class SystemLogs {
  private recentReads = new Map<string, number>();
  constructor(
    private db: Database,
    private dataPath: string,
  ) {}

  capture(method: string, error: unknown, raw: unknown) {
    if (method.startsWith("systemLogs.")) return;
    try {
      const input =
        raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const identifier = (key: string) =>
        typeof input[key] === "string" &&
        /^[\w:-]{1,150}$/.test(input[key] as string)
          ? (input[key] as string)
          : undefined;
      const message = safeMessage(error);
      const code = error instanceof AppError ? error.code : "UNEXPECTED_ERROR";
      const taskId =
        identifier("id") ?? identifier("taskId") ?? identifier("runId");
      const accountId = identifier("accountId");
      const key = JSON.stringify([method, code, message, taskId, accountId]);
      if (reads.has(method)) {
        const last = this.recentReads.get(key) ?? 0;
        if (Date.now() - last < 60000) return;
        this.recentReads.set(key, Date.now());
        if (this.recentReads.size > 500)
          this.recentReads.delete(this.recentReads.keys().next().value!);
      }
      const prefix = method.split(".")[0];
      const domain =
        domainAliases[prefix] ??
        (/^[a-z][a-z-]{0,40}$/.test(prefix) ? prefix : "system");
      new RuntimeLog(this.db, this.dataPath, domain).record({
        level: "error",
        event: "operation.failed",
        message,
        taskId,
        accountId,
        details: {
          ...(error instanceof AppError ? error.details : {}),
          method: method.slice(0, 100),
          code,
        },
      });
    } catch {
      // A logging failure must never replace the original business error.
      console.warn("[system-logs] 无法写入异常日志，原始操作错误已保留。");
    }
  }

  read(raw: unknown = {}): SystemLogPage {
    const query = systemLogQuery.parse(raw),
      clauses: string[] = [],
      values: (string | number)[] = [];
    if (query.domain) {
      clauses.push("domain=?");
      values.push(query.domain);
    }
    if (query.level !== "issues") {
      clauses.push("level=?");
      values.push(query.level);
    }
    if (query.range !== "all") {
      const days = query.range === "24h" ? 1 : query.range === "7d" ? 7 : 30;
      clauses.push("created_at>=?");
      values.push(new Date(Date.now() - days * 86400000).toISOString());
    }
    if (query.search) {
      const term = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`;
      clauses.push(
        "(message LIKE ? ESCAPE '\\' OR event LIKE ? ESCAPE '\\' OR task_id LIKE ? ESCAPE '\\' OR details LIKE ? ESCAPE '\\')",
      );
      values.push(term, term, term, term);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = this.db.get<{ n: number }>(
      `${entries} SELECT COUNT(*) n FROM entries ${where}`,
      ...values,
    )!.n;
    const pageSize = 50,
      page = Math.min(query.page, Math.max(1, Math.ceil(total / pageSize)));
    const rows = this.db.all<{
      id: string;
      domain: string;
      level: SystemLogEntry["level"];
      event: string;
      message: string;
      account_id: string | null;
      task_id: string | null;
      details: string;
      created_at: string;
    }>(
      `${entries} SELECT * FROM entries ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
      ...values,
      pageSize,
      (page - 1) * pageSize,
    );
    return {
      total,
      page,
      pageSize,
      domains: this.db
        .all<{ domain: string }>(
          `${entries} SELECT DISTINCT domain FROM entries ORDER BY domain`,
        )
        .map((r) => r.domain),
      items: rows.map((row) => {
        let details: Record<string, unknown> = {};
        try {
          details = JSON.parse(row.details);
        } catch {}
        if (typeof details.apiCallId === "string") {
          const cached = this.db.get<{ value: string }>(
            "SELECT value FROM api_cache WHERE key IN (?,?) ORDER BY CASE WHEN key LIKE 'ai-diagnostic:%' THEN 0 ELSE 1 END LIMIT 1",
            `ai-diagnostic:${details.apiCallId}`,
            `ai-response:${details.apiCallId}`,
          );
          if (cached)
            try {
              const data = JSON.parse(cached.value);
              for (const key of [
                "model",
                "finishReason",
                "nativeFinishReason",
                "responseId",
                "provider",
                "outputTokens",
                "inputTokens",
                "rawLength",
                "elapsedMs",
                "kind",
                "mode",
                "rejectionReason",
                "providerReason",
                "httpStatus",
                "outputMode",
                "failureKind",
              ])
                if (
                  typeof data[key] === "string" ||
                  typeof data[key] === "number"
                )
                  details[key] = data[key];
            } catch {}
        }
        return cleanKnowledge({
          id: row.id,
          domain: row.domain,
          level: row.level,
          event: row.event,
          message: row.message,
          accountId: row.account_id,
          taskId: row.task_id,
          details,
          createdAt: row.created_at,
        }) as SystemLogEntry;
      }),
    };
  }
}

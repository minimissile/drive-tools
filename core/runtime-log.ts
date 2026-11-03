import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { now, type Database } from "./database";
import { cleanKnowledge } from "./knowledge-response";
import {
  runtimeLogQuery,
  type RuntimeLogEntry,
  type RuntimeLogPage,
} from "../shared/runtime-logs";

type Input = Omit<
  RuntimeLogEntry,
  "id" | "domain" | "createdAt" | "accountId" | "taskId" | "details"
> & {
  accountId?: string;
  taskId?: string;
  details?: Record<string, unknown>;
};
/** Durable, credential-cleaned events. JSONL is a local mirror; SQLite is authoritative. */
export class RuntimeLog {
  readonly folder: string;
  private mirrorFailed = false;
  constructor(
    private db: Database,
    dataPath: string,
    private domain: string,
  ) {
    if (!/^[a-z][a-z-]{0,40}$/.test(domain)) throw new Error("日志领域无效");
    this.folder = join(dataPath, "logs", domain);
  }
  record(input: Input) {
    const clean = cleanKnowledge(input) as Input;
    const createdAt = now();
    const saved = this.db.run(
      "INSERT INTO runtime_logs(domain,level,event,message,account_id,task_id,details,created_at) VALUES(?,?,?,?,?,?,?,?)",
      this.domain,
      clean.level,
      clean.event,
      clean.message.slice(0, 4000),
      clean.accountId ?? null,
      clean.taskId ?? null,
      JSON.stringify(clean.details ?? {}),
      createdAt,
    );
    const entry = {
      ...clean,
      id: Number(saved.lastInsertRowid),
      domain: this.domain,
      createdAt,
    };
    try {
      mkdirSync(this.folder, { recursive: true, mode: 0o700 });
      const day = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(createdAt));
      appendFileSync(
        join(this.folder, `${day}.jsonl`),
        JSON.stringify(entry) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
      this.mirrorFailed = false;
    } catch {
      if (!this.mirrorFailed)
        this.db.run(
          "INSERT INTO runtime_logs(domain,level,event,message,details,created_at) VALUES(?,?,?,?,?,?)",
          this.domain,
          "warning",
          "log.mirror_failed",
          "运行日志已保存在数据库，文本日志写入失败，请检查目录权限。",
          "{}",
          createdAt,
        );
      this.mirrorFailed = true;
    }
  }
  read(raw: unknown = {}): RuntimeLogPage {
    const input = runtimeLogQuery.parse(raw),
      clauses = ["domain=?"],
      values: (string | number)[] = [this.domain];
    if (input.accountId) {
      clauses.push("account_id=?");
      values.push(input.accountId);
    }
    if (input.level !== "all") {
      clauses.push("level=?");
      values.push(input.level);
    }
    if (input.search) {
      const term = `%${input.search.replace(/[\\%_]/g, "\\$&")}%`;
      clauses.push(
        "(message LIKE ? ESCAPE '\\' OR event LIKE ? ESCAPE '\\' OR task_id LIKE ? ESCAPE '\\')",
      );
      values.push(term, term, term);
    }
    if (input.excludeHeartbeats) clauses.push("event<>'scheduler.heartbeat'");
    const where = clauses.join(" AND "),
      pageSize = 50;
    const total = this.db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM runtime_logs WHERE ${where}`,
      ...values,
    )!.n;
    const page = Math.min(input.page, Math.max(1, Math.ceil(total / pageSize)));
    const rows = this.db.all<{
      id: number;
      domain: string;
      level: RuntimeLogEntry["level"];
      event: string;
      message: string;
      account_id: string | null;
      task_id: string | null;
      details: string;
      created_at: string;
    }>(
      `SELECT * FROM runtime_logs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...values,
      pageSize,
      (page - 1) * pageSize,
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        domain: r.domain,
        level: r.level,
        event: r.event,
        message: r.message,
        accountId: r.account_id,
        taskId: r.task_id,
        details: JSON.parse(r.details),
        createdAt: r.created_at,
      })),
      total,
      page,
      pageSize,
      folder: this.folder,
    };
  }
}

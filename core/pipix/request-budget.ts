import { createHash } from "node:crypto";
import { id, now, type Database } from "../database";
import { AppError } from "../errors";
import {
  pipixRequestPolicy,
  type PipixRequestPolicy,
} from "../../shared/pipix-acquisition";

export const pipixPolicyKey = "pipix:request-policy:v1";
export const readPipixPolicy = (db: Database) =>
  pipixRequestPolicy.parse(db.setting(pipixPolicyKey, {}));
const policyHash = (value: PipixRequestPolicy) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const dayStart = () =>
  new Date(
    `${new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)}T00:00:00+08:00`,
  ).toISOString();
export function pipixUsage(db: Database) {
  const policy = readPipixPolicy(db),
    start = dayStart();
  const usedToday =
    db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM api_calls WHERE endpoint='tikhub:pipix' AND created_at>=?",
      start,
    )!.n +
    db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM content_source_responses r WHERE r.provider IN ('pipix','pipix-comments') AND r.fetched_at>=? AND NOT EXISTS(SELECT 1 FROM api_calls a WHERE a.id=r.id)",
      start,
    )!.n;
  return {
    policy,
    usedToday,
    remainingToday: Math.max(0, policy.dailyRequests - usedToday),
  };
}
export function pipixRunRequests(db: Database, runId: string) {
  return db.get<{ n: number }>(
    "SELECT COUNT(*) n FROM api_calls WHERE endpoint='tikhub:pipix' AND phase IN (?,?)",
    `list:${runId}`,
    `comments:${runId}`,
  )!.n;
}
/** An in-memory grant. Saving/restoring a run never restores permission to spend. */
export class PipixRequestBudget {
  private active = true;
  private fingerprint: string;
  constructor(
    private db: Database,
    readonly runId = id("pipixrequest"),
    readonly limit = readPipixPolicy(db).requestsPerRun,
  ) {
    this.fingerprint = policyHash(readPipixPolicy(db));
  }
  stop() {
    this.active = false;
  }
  get used() {
    return pipixRunRequests(this.db, this.runId);
  }
  reserve(kind: "list" | "comments", begin: () => string) {
    return this.db.transaction(() => {
      if (!this.active)
        throw new AppError("PIPIX_STOPPED", "本轮已暂停，未继续发出请求。");
      const usage = pipixUsage(this.db);
      if (policyHash(usage.policy) !== this.fingerprint)
        throw new AppError(
          "PIPIX_POLICY_CHANGED",
          "请求设置已修改，本轮授权已停止，请核对后再继续。",
        );
      if (this.used >= this.limit)
        throw new AppError(
          "PIPIX_RUN_LIMIT",
          "已到本轮新请求上限，缓存与已采集内容保留。",
        );
      if (!usage.remainingToday)
        throw new AppError(
          "PIPIX_DAILY_LIMIT",
          "已到今日TikHub请求上限；本地读取仍可使用。",
        );
      const requestId = begin();
      this.db.run(
        "INSERT INTO api_calls(id,endpoint,phase,units,status,created_at) VALUES(?,'tikhub:pipix',?,1,'reserved',?)",
        requestId,
        `${kind}:${this.runId}`,
        now(),
      );
      return requestId;
    });
  }
  received(requestId: string, status: number) {
    this.db.run(
      "UPDATE api_calls SET status=?,message=? WHERE id=? AND endpoint='tikhub:pipix'",
      status >= 200 && status < 300 ? "success" : "error",
      `HTTP ${status}，响应已归档；金额以服务商记录为准`,
      requestId,
    );
  }
  uncertain(requestId: string) {
    this.db.run(
      "UPDATE api_calls SET status='uncertain',message='请求结果或响应保存未完成，保留额度，不自动重试' WHERE id=? AND endpoint='tikhub:pipix' AND status='reserved'",
      requestId,
    );
  }
}

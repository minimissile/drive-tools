import type { Database } from "../database";
import type { EnvironmentStamp } from "../../shared/browser-environments";
import type {
  TiebaTopicDraft,
  TiebaTopicRule,
} from "../../shared/tieba-topics";
export interface TopicRecord extends TiebaTopicDraft {
  lastMutationAt?: string;
  stamp: EnvironmentStamp;
  payloadHash: string;
  contentHash: string;
  ruleVersion: number;
  history: { version: number; title: string; body: string; at: string }[];
}
export interface TopicGeneration {
  id: string;
  draftId: string;
  status: "reserved" | "success" | "failed" | "uncertain";
  createdAt: string;
  message: string;
}
export class TiebaTopicStore {
  constructor(private db: Database) {}
  drafts() {
    return this.db
      .all<{ data: string }>(
        "SELECT data FROM tieba_topic_drafts ORDER BY rowid DESC",
      )
      .map((r) => JSON.parse(r.data) as TopicRecord);
  }
  draft(id: string) {
    const r = this.db.get<{ data: string }>(
      "SELECT data FROM tieba_topic_drafts WHERE id=?",
      id,
    );
    return r ? (JSON.parse(r.data) as TopicRecord) : undefined;
  }
  save(d: TopicRecord) {
    // The indexed column is the latest remote mutation intent (upload/click),
    // while JSON submittedAt retains the original no-replay checkpoint.
    this.db.run(
      "INSERT INTO tieba_topic_drafts(id,target_id,uid,forum_id,status,version,submitted_at,body_hash,data) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,version=excluded.version,submitted_at=excluded.submitted_at,body_hash=excluded.body_hash,data=excluded.data",
      d.id,
      d.targetId,
      d.uid,
      d.forumId,
      d.status,
      d.version,
      d.lastMutationAt ?? d.submittedAt,
      d.contentHash,
      JSON.stringify(d),
    );
  }
  claim(d: TopicRecord, previous: number) {
    return (
      this.db.run(
        "UPDATE tieba_topic_drafts SET status=?,version=?,data=? WHERE id=? AND status='ready' AND version=? AND submitted_at IS NULL",
        d.status,
        d.version,
        JSON.stringify(d),
        d.id,
        previous,
      ).changes === 1
    );
  }
  rules() {
    return this.db
      .all<{ data: string }>("SELECT data FROM tieba_topic_rules")
      .map((r) => JSON.parse(r.data) as TiebaTopicRule);
  }
  rule(id: string) {
    return this.rules().find((r) => r.targetId === id);
  }
  saveRule(r: TiebaTopicRule) {
    this.db.run(
      "INSERT INTO tieba_topic_rules(target_id,data) VALUES(?,?) ON CONFLICT(target_id) DO UPDATE SET data=excluded.data",
      r.targetId,
      JSON.stringify(r),
    );
  }
  generations() {
    return this.db
      .all<{ data: string }>(
        "SELECT data FROM tieba_topic_generations ORDER BY rowid DESC",
      )
      .map((r) => JSON.parse(r.data) as TopicGeneration);
  }
  saveGeneration(g: TopicGeneration) {
    this.db.run(
      "INSERT INTO tieba_topic_generations(id,draft_id,status,created_at,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data",
      g.id,
      g.draftId,
      g.status,
      g.createdAt,
      JSON.stringify(g),
    );
  }
}
export function stopTiebaTopicsForBackup(db: Database) {
  if (!db.get("SELECT name FROM sqlite_master WHERE name='tieba_topic_drafts'"))
    return;
  const store = new TiebaTopicStore(db);
  for (const d of store.drafts()) {
    if (d.status === "generating") {
      d.status = "attention";
      d.message = "生成因备份或恢复中断，费用与结果保留，不自动重试。";
    } else if (d.status === "submitting") {
      d.status = d.submittedAt ? "uncertain" : "draft";
      d.message = d.submittedAt
        ? "原图文可能已提交，仅可核对原结果。"
        : "发布准备在提交前中断，请重新检查。";
    } else if (d.status === "ready") {
      d.status = "draft";
      d.message = "备份不继承发布确认，请核实原账号、吧规与资料后保存。";
    } else continue;
    d.version++;
    d.updatedAt = new Date().toISOString();
    store.save(d);
  }
  for (const g of store.generations())
    if (g.status === "reserved") {
      g.status = "uncertain";
      g.message = "原生成可能已计费，不自动再次调用。";
      store.saveGeneration(g);
    }
}

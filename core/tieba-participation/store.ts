import type { Database } from "../database";
import type { EnvironmentStamp } from "../../shared/browser-environments";
import type {
  TiebaParticipationCandidate,
  TiebaReplyDraft,
} from "../../shared/tieba-participation";

export interface CandidateRecord extends TiebaParticipationCandidate {
  stamp: EnvironmentStamp;
}
export interface DraftRecord extends TiebaReplyDraft {
  aiGenerated?: boolean;
  stamp: EnvironmentStamp;
  contextHash: string;
  bodyHash: string;
  history: { version: number; body: string; at: string }[];
}
export interface GenerationRecord {
  id: string;
  draftId: string;
  status: "reserved" | "success" | "failed" | "uncertain";
  createdAt: string;
  message: string;
}
export class TiebaParticipationStore {
  constructor(private db: Database) {}
  candidates() {
    return this.db
      .all<{ data: string }>(
        "SELECT data FROM tieba_thread_candidates ORDER BY rowid DESC",
      )
      .map((r) => JSON.parse(r.data) as CandidateRecord);
  }
  candidate(id: string) {
    const r = this.db.get<{ data: string }>(
      "SELECT data FROM tieba_thread_candidates WHERE id=?",
      id,
    );
    return r ? (JSON.parse(r.data) as CandidateRecord) : undefined;
  }
  saveCandidate(value: CandidateRecord) {
    this.db.run(
      "INSERT INTO tieba_thread_candidates(id,account_id,uid,thread_id,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      value.id,
      value.accountId,
      value.uid,
      value.threadId,
      JSON.stringify(value),
    );
  }
  drafts() {
    return this.db
      .all<{ data: string }>(
        "SELECT data FROM tieba_reply_drafts ORDER BY rowid DESC",
      )
      .map((r) => JSON.parse(r.data) as DraftRecord);
  }
  draft(id: string) {
    const r = this.db.get<{ data: string }>(
      "SELECT data FROM tieba_reply_drafts WHERE id=?",
      id,
    );
    return r ? (JSON.parse(r.data) as DraftRecord) : undefined;
  }
  saveDraft(value: DraftRecord) {
    this.db.run(
      "INSERT INTO tieba_reply_drafts(id,candidate_id,uid,thread_id,status,version,submitted_at,data) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,version=excluded.version,submitted_at=excluded.submitted_at,data=excluded.data",
      value.id,
      value.candidateId,
      value.uid,
      value.threadId,
      value.status,
      value.version,
      value.submittedAt,
      JSON.stringify(value),
    );
  }
  claimSubmit(value: DraftRecord, version: number) {
    return (
      this.db.run(
        "UPDATE tieba_reply_drafts SET status=?,version=?,submitted_at=?,data=? WHERE id=? AND version=? AND status='ready' AND submitted_at IS NULL",
        value.status,
        value.version,
        value.submittedAt,
        JSON.stringify(value),
        value.id,
        version,
      ).changes === 1
    );
  }
  generations() {
    return this.db
      .all<{ data: string }>(
        "SELECT data FROM tieba_reply_generations ORDER BY rowid DESC",
      )
      .map((r) => JSON.parse(r.data) as GenerationRecord);
  }
  saveGeneration(value: GenerationRecord) {
    this.db.run(
      "INSERT INTO tieba_reply_generations(id,draft_id,status,created_at,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data",
      value.id,
      value.draftId,
      value.status,
      value.createdAt,
      JSON.stringify(value),
    );
  }
}

/** A backup contains content and history, never authority to resume a paid call or submission. */
export function stopTiebaParticipationForBackup(db: Database) {
  if (
    !db.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tieba_reply_drafts'",
    )
  )
    return;
  const store = new TiebaParticipationStore(db);
  for (const draft of store.drafts()) {
    if (draft.status === "generating") {
      draft.status = "attention";
      draft.message =
        "生成因备份或恢复中断，正文及费用记录保留，不自动再次调用。";
    } else if (draft.status === "submitting") {
      draft.status = draft.submittedAt ? "uncertain" : "draft";
      draft.message = draft.submittedAt
        ? "原回帖可能已提交，仅可核对官网结果。"
        : "提交前已中断，请重新检查并明确提交。";
    } else if (draft.status === "ready") {
      draft.status = "draft";
      draft.message = "从备份恢复，需在原账号重新读取上下文、检查正文后提交。";
    } else continue;
    draft.version++;
    draft.updatedAt = new Date().toISOString();
    store.saveDraft(draft);
  }
  for (const generation of store.generations())
    if (generation.status === "reserved") {
      generation.status = "uncertain";
      generation.message =
        "备份中的生成请求可能已发出，请先核对费用；不自动重试。";
      store.saveGeneration(generation);
    }
}

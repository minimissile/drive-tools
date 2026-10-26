import type { Database } from "../database";

export const questionFingerprint = (question: string) =>
  question
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\s]/gu, "");

/** Workspace-wide history survives account removal and re-binding. Unknown sends also block. */
export function answerHistory(db: Database) {
  const ids = new Set<string>(),
    questions = new Set<string>();
  for (const row of db.all<{ qid: string | null; question: string | null }>(
    "SELECT json_extract(i.data,'$.questionId') qid,json_extract(i.data,'$.question') question FROM operation_items i JOIN operation_runs r ON r.id=i.run_id WHERE r.kind IN ('answer','publish') AND i.status IN ('submitted','uncertain','submitting')",
  )) {
    if (row.qid) ids.add(String(row.qid));
    if (row.question) questions.add(questionFingerprint(row.question));
  }
  return {
    has(qid: string, question: string) {
      const fingerprint = questionFingerprint(question);
      return ids.has(qid) || (!!fingerprint && questions.has(fingerprint));
    },
    add(qid: string, question: string) {
      ids.add(qid);
      if (question) questions.add(questionFingerprint(question));
    },
  };
}

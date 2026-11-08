import type {
  TiebaParticipationCandidate,
  TiebaReplyDraft,
  TiebaReplyDraftStatus,
} from "../../shared/tieba-participation";

export const tiebaReplyStatusLabels: Record<TiebaReplyDraftStatus, string> = {
  generating: "正在生成",
  draft: "待保存检查",
  ready: "待提交",
  submitting: "正在提交",
  verified: "官网已核实",
  uncertain: "结果待核对",
  failed: "未完成",
  skipped: "已跳过",
  attention: "需要处理",
};

export function tiebaReplyStatusKind(status: TiebaReplyDraftStatus) {
  if (status === "verified") return "good";
  if (status === "failed") return "danger";
  if (["uncertain", "attention", "skipped"].includes(status)) return "warning";
  return "normal";
}

export function tiebaReplyContextIssue(candidate: TiebaParticipationCandidate) {
  const context = candidate.context;
  if (!context) return "先读取原帖正文和已有回复，再准备有依据的回复。";
  if (
    context.threadId !== candidate.threadId ||
    context.forumId !== candidate.forumId
  )
    return "上下文与所选帖子不匹配，请重新读取原帖。";
  if (!context.body.trim()) return "尚未取得原帖正文，暂不能生成或提交回复。";
  if (context.truncated) return "原帖内容未完整读取，暂不能生成或提交回复。";
  if (context.closed === true) return "官网显示该帖已关闭回复。";
  if (context.canReply !== true)
    return "尚未核实本账号可以回复该帖，请重新读取上下文。";
  if (candidate.status === "skipped")
    return candidate.message || "该帖当前不适合参与。";
  return "";
}

/** Preserve local text across reads; a remote revision never overwrites edits. */
export function tiebaReplyEditorView(
  local: { body: string; baseBody: string; version: number },
  current: Pick<TiebaReplyDraft, "body" | "version">,
) {
  const edited = local.body !== local.baseBody;
  const changed = edited && local.body !== current.body;
  return {
    body: changed ? local.body : current.body,
    changed,
    stale: changed && local.version !== current.version,
  };
}

export function tiebaReplyEditable(draft: TiebaReplyDraft) {
  return (
    !draft.submittedAt && ["draft", "ready", "failed"].includes(draft.status)
  );
}

export function tiebaReplyCanRegenerate(draft: TiebaReplyDraft) {
  return (
    !draft.submittedAt &&
    ["failed", "skipped"].includes(draft.status) &&
    draft.generationAttempts < 2
  );
}

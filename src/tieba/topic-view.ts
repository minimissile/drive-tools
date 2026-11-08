import type {
  TiebaTopicDraft,
  TiebaTopicRule,
  TiebaTopicSource,
  TiebaTopicStatus,
} from "../../shared/tieba-topics";

export interface TiebaTopicForm {
  title: string;
  body: string;
  source: TiebaTopicSource;
}
export function tiebaTopicRuleView(
  local: {
    note: string;
    allowImages: boolean;
    base: string;
    baseAllowImages: boolean;
    version: number;
  },
  current: TiebaTopicRule | undefined,
) {
  const locallyEdited =
    local.note !== local.base || local.allowImages !== local.baseAllowImages;
  const changed =
    locallyEdited &&
    (local.note !== (current?.note ?? "") ||
      local.allowImages !== (current?.allowImages ?? false));
  return {
    note: changed ? local.note : (current?.note ?? ""),
    allowImages: changed ? local.allowImages : (current?.allowImages ?? false),
    changed,
    stale: changed && local.version !== (current?.version ?? 0),
  };
}
export const emptyTiebaTopicSource: TiebaTopicSource = {
  kind: "owned",
  title: "",
  body: "",
  sourceUrl: "",
  rightsNote: "",
};
export const tiebaTopicFormHash = (form: TiebaTopicForm) =>
  JSON.stringify([
    form.title,
    form.body,
    form.source.kind,
    form.source.title,
    form.source.body,
    form.source.sourceUrl,
    form.source.rightsNote,
  ]);
export const tiebaTopicEditable = (draft: TiebaTopicDraft | undefined) =>
  !draft ||
  (!draft.submittedAt && ["draft", "ready", "failed"].includes(draft.status));
export function tiebaTopicEditorView(
  local: TiebaTopicForm & { base: string; version: number },
  current: TiebaTopicDraft | undefined,
) {
  const locallyEdited = tiebaTopicFormHash(local) !== local.base;
  const changed =
    locallyEdited &&
    (!current || tiebaTopicFormHash(local) !== tiebaTopicFormHash(current));
  return {
    form:
      changed || !current
        ? { title: local.title, body: local.body, source: local.source }
        : { title: current.title, body: current.body, source: current.source },
    changed,
    stale: changed && !!current && local.version !== current.version,
  };
}
export const tiebaTopicStatusLabels: Record<TiebaTopicStatus, string> = {
  draft: "草稿待检查",
  ready: "可审阅提交",
  generating: "正在生成",
  submitting: "正在提交",
  verified: "官网已核实",
  pending_review: "官网提示审核中",
  uncertain: "结果待核对",
  attention: "费用或中断待检查",
  failed: "未完成",
};
export const tiebaTopicStatusKind = (status: TiebaTopicStatus) =>
  status === "verified"
    ? ("good" as const)
    : status === "failed"
      ? ("danger" as const)
      : ["uncertain", "attention", "pending_review"].includes(status)
        ? ("warning" as const)
        : ("normal" as const);
export const tiebaTopicCanReconcile = (draft: TiebaTopicDraft) =>
  !!draft.submittedAt && ["uncertain", "pending_review"].includes(draft.status);

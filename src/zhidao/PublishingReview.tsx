import { useState } from "react";
import { ArrowUp, ArrowDown, Eye, Trash2 } from "lucide-react";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppData } from "../state";
import { Button, Field, Notice } from "../ui/primitives";
import { Pagination } from "../ui/Pagination";
import {
  publishingQuestionIssue,
  type PublishingQuestion,
  type PublishingRecord,
} from "../../shared/zhidao-workflow";
import { useOperationAction } from "./hooks";
import {
  publishingReviewDraftKey,
  publishingReviewDraftSchema,
} from "./publishing-draft";

export function PublishingReview({
  record,
  onSaved,
  onDirty,
  onTextChange,
  pending,
  onPreview,
  onOptimize,
  upgrading,
  editingVersion,
  conflict,
}: {
  record: PublishingRecord;
  onSaved(): void;
  onDirty(): void;
  onTextChange(rows: PublishingQuestion[]): void;
  pending: boolean;
  onPreview(): void;
  onOptimize(): void;
  upgrading: boolean;
  editingVersion: { generationId?: string; legacyUpgraded?: true };
  conflict: boolean;
}) {
  const { data } = useAppData();
  const action = useOperationAction();
  const [page, setPage] = useState(1);
  const [removed, setRemoved] = useState<{
    row: PublishingQuestion;
    index: number;
  } | null>(null);
  const draft = useLocalDraft(
    publishingReviewDraftKey(
      data!.dataPath,
      record.id,
      editingVersion.legacyUpgraded,
      editingVersion.generationId,
    ),
    { rows: record.rows },
    (raw) => publishingReviewDraftSchema.parse(raw),
  );
  // Review acknowledgements are persisted only by the explicit save command, never restored from an unsaved draft.
  const rows = draft.value.rows.map((row, i) => {
    const saved = record.contentFirst
      ? record.rows.find((saved) => saved.id === row.id)
      : record.rows[i];
    return {
      ...row,
      reviewed:
        !!saved?.reviewed &&
        row.question === saved.question &&
        row.answer === saved.answer,
    };
  });
  const currentPage = Math.min(page, Math.max(1, Math.ceil(rows.length / 5)));
  const effective = rows;
  const issues = effective.map((row) =>
    publishingQuestionIssue(row, record.linkedAnswerFormat),
  );
  const confirmed = effective.filter((row) => row.reviewed).length;
  const firstIssue = issues.findIndex(Boolean);
  const dirty = JSON.stringify(effective) !== JSON.stringify(record.rows);
  const changeRows = (next: PublishingQuestion[]) => {
    onDirty();
    draft.update({ rows: next });
    onTextChange(next);
  };
  const update = (index: number, patch: Partial<(typeof rows)[number]>) => {
    const next = draft.value.rows.map((row, i) =>
      i === index ? { ...row, ...patch, reviewed: false } : row,
    );
    changeRows(next);
  };
  return (
    <div className="publishing-review">
      <div className="publishing-review-tools">
        <div>
          <h2>检查问答 · {record.resource.title}</h2>
          <strong>
            {effective.length} 条问答
            <span className="muted"> · 已确认 {confirmed} 条</span>
          </strong>
          <p className="publishing-help">
            检查标题和介绍，可删减或调整顺序，确认后按实际条数准备独立链接。 AI
            优化只改写未确认的标题和简介，使用文案创作模型与现有预算。
          </p>
        </div>
        <div className="publishing-review-actions">
          <Button
            onClick={onOptimize}
            disabled={
              upgrading ||
              conflict ||
              dirty ||
              pending ||
              !!action.pending ||
              confirmed === effective.length
            }
          >
            {upgrading ? "正在 AI 优化…" : "AI 优化标题与简介"}
          </Button>
          <Button onClick={onPreview}>
            <Eye size={15} aria-hidden="true" />
            预览问答
          </Button>
          <Button
            primary
            disabled={
              !!action.pending ||
              upgrading ||
              conflict ||
              !!issues.find(Boolean) ||
              (!dirty && !pending && confirmed === effective.length)
            }
            onClick={() =>
              void action.run(
                "zhidao.workflow.saveRows",
                {
                  id: record.id,
                  generationId: editingVersion.generationId,
                  rows: effective.map((row) => ({ ...row, reviewed: true })),
                },
                () => {
                  setRemoved(null);
                  onSaved();
                },
                "问答与审核状态已保存",
              )
            }
          >
            {action.pending
              ? "正在保存…"
              : confirmed === effective.length && !dirty && !pending
                ? "本份问答已确认"
                : "确认并保存本份问答"}
          </Button>
        </div>
      </div>
      {draft.error ? <Notice danger>{draft.error}</Notice> : null}
      {firstIssue >= 0 && Math.floor(firstIssue / 5) + 1 !== currentPage ? (
        <Notice warning>
          第{firstIssue + 1}条问答需要修改：{issues[firstIssue]}
          <Button
            quiet
            size="compact"
            onClick={() => setPage(Math.floor(firstIssue / 5) + 1)}
          >
            查看问题
          </Button>
        </Notice>
      ) : null}
      {dirty ? (
        <p className="publishing-help" role="status">
          有修改尚未确认，请保存后继续准备链接。
        </p>
      ) : null}
      {removed ? (
        <p className="publishing-help" role="status">
          已移除一条问答。
          <Button
            quiet
            size="compact"
            onClick={() => {
              const next = [...rows];
              next.splice(Math.min(removed.index, next.length), 0, removed.row);
              changeRows(next);
              setRemoved(null);
            }}
            disabled={!!action.pending || upgrading}
          >
            撤销移除
          </Button>
        </p>
      ) : null}
      {effective
        .slice((currentPage - 1) * 5, currentPage * 5)
        .map((row, offset) => {
          const index = (currentPage - 1) * 5 + offset,
            issue = issues[index];
          return (
            <section
              key={row.id ?? index}
              className="publishing-review-row"
              aria-label={`问答第${index + 1}行`}
            >
              <div className="publishing-review-meta">
                <strong>第 {index + 1} 行</strong>
                <span>
                  关键词：
                  {[row.keyword, ...(row.relatedKeywords ?? [])].join("、")}
                </span>
                <span
                  className="publishing-review-state"
                  data-confirmed={row.reviewed}
                >
                  {row.reviewed ? "已确认" : "待确认"}
                </span>
                {record.contentFirst ? (
                  <div className="publishing-review-row-actions">
                    <Button
                      quiet
                      size="compact"
                      title="上移"
                      aria-label={`上移第${index + 1}条问答`}
                      disabled={upgrading || !!action.pending || index === 0}
                      onClick={() => {
                        const next = [...rows];
                        [next[index - 1], next[index]] = [
                          next[index],
                          next[index - 1],
                        ];
                        changeRows(next);
                        setPage(Math.floor((index - 1) / 5) + 1);
                      }}
                    >
                      <ArrowUp size={14} />
                    </Button>
                    <Button
                      quiet
                      size="compact"
                      title="下移"
                      aria-label={`下移第${index + 1}条问答`}
                      disabled={
                        upgrading ||
                        !!action.pending ||
                        index === rows.length - 1
                      }
                      onClick={() => {
                        const next = [...rows];
                        [next[index + 1], next[index]] = [
                          next[index],
                          next[index + 1],
                        ];
                        changeRows(next);
                        setPage(Math.floor((index + 1) / 5) + 1);
                      }}
                    >
                      <ArrowDown size={14} />
                    </Button>
                    <Button
                      quiet
                      size="compact"
                      title="移除"
                      aria-label={`移除第${index + 1}条问答`}
                      disabled={
                        upgrading || !!action.pending || rows.length === 1
                      }
                      onClick={() => {
                        setRemoved({ row, index });
                        changeRows(rows.filter((_, i) => i !== index));
                      }}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                ) : null}
              </div>
              <Field label="问题标题" hint={`${row.question.length} / 49 字`}>
                <textarea
                  rows={3}
                  aria-label={`第${index + 1}条问题标题`}
                  value={row.question}
                  readOnly={upgrading}
                  disabled={!!action.pending}
                  maxLength={500}
                  onChange={(e) => update(index, { question: e.target.value })}
                />
              </Field>
              <Field
                label={record.contentFirst ? "资源介绍" : "回答内容"}
                hint={
                  record.contentFirst
                    ? "链接将在下一步自动插入"
                    : "表格使用的 HTML 文本"
                }
              >
                <textarea
                  aria-label={`第${index + 1}条回答内容`}
                  rows={3}
                  maxLength={12000}
                  value={row.answer}
                  readOnly={upgrading}
                  disabled={!!action.pending}
                  onChange={(e) => update(index, { answer: e.target.value })}
                />
              </Field>
              {issue ? <Notice warning>{issue}</Notice> : null}
            </section>
          );
        })}
      <Pagination
        page={currentPage}
        pageSize={5}
        total={rows.length}
        onPageChange={setPage}
        label="问答检查分页"
      />
    </div>
  );
}

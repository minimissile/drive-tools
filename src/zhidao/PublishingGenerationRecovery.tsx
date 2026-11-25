import type { PublishingRecord } from "../../shared/zhidao-workflow";
import { Button, Notice } from "../ui/primitives";

export function PublishingGenerationRecovery({
  record,
  busy,
  onCorrect,
  onAdjust,
}: {
  record: PublishingRecord;
  busy: boolean;
  onCorrect(): void;
  onAdjust(): void;
}) {
  const generation = record.generation!;
  const issues = generation.validation!.issues;
  const indexes = [...new Set(issues.map((issue) => issue.index))];
  return (
    <>
      <Notice warning>
        {generation.message ||
          `${indexes.length}条问答需要修正。草稿已保留，未确认或建链。`}
      </Notice>
      <ol className="publishing-generation-issues" aria-label="需要修正的问答">
        {indexes.map((index) => {
          const draft =
            generation.drafts.find((row) => row.index === index) ??
            generation.rejectedDrafts?.find((row) => row.index === index);
          return (
            <li key={index} value={index + 1}>
              <strong>{draft?.question || record.rows[index]?.question}</strong>
              {draft ? <p>{draft.introduction}</p> : null}
              {issues
                .filter((issue) => issue.index === index)
                .map((issue, position) => (
                  <p className="publishing-generation-reason" key={position}>
                    上次检查：{issue.reason}
                  </p>
                ))}
            </li>
          );
        })}
      </ol>
      <div className="publishing-generation-actions">
        <Button primary disabled={busy} onClick={onCorrect}>
          修正问题并重新检查
        </Button>
        <Button quiet disabled={busy} onClick={onAdjust}>
          调整关键词或资源说明
        </Button>
        <small className="muted">
          将调用 AI，仅重写有问题的问答，保留其他草稿。
        </small>
      </div>
    </>
  );
}

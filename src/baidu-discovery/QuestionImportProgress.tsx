import { useState } from "react";
import type { DiscoveryQuestionImport } from "../../shared/baidu-discovery";
import { ipc } from "../api/client";
import { Button, Notice } from "../ui/primitives";

export function QuestionImportProgress({
  value,
  disabled,
  onChanged,
}: {
  value: DiscoveryQuestionImport;
  disabled: boolean;
  onChanged(): void;
}) {
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const resolve = async (
    operationId: string,
    outcome: "not_created" | "handled",
  ) => {
    setPending(true);
    setError("");
    setFeedback("");
    try {
      await ipc("share.resolveCreation", { operationId, outcome });
      setFeedback("已保存核对结果，点击“生成独立链接并入表”继续未完成项。");
      onChanged();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "核对结果未保存，请重试。",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="baidu-question-import" aria-label="独立分享生成进度">
      <p role="status">
        已就绪 {value.ready}/{value.total} 条 · 待生成 {value.pending} 条
        {value.failed ? ` · 失败 ${value.failed} 条` : ""}
        {value.uncertain ? ` · 待核对 ${value.uncertain} 条` : ""}
      </p>
      <small>{value.message}</small>
      {value.issues.length ? (
        <details open={!value.running}>
          <summary>
            查看未完成原因{value.issues.length === 20 ? "（最多显示20条）" : ""}
          </summary>
          {value.issues.map((issue) => (
            <div
              className="baidu-question-import-issue"
              key={issue.operationId}
            >
              <strong>{issue.question}</strong>
              <small>{issue.message}</small>
              {issue.uncertain ? (
                <div>
                  <small>在官方网盘核对后记录结果：</small>
                  <Button
                    quiet
                    size="compact"
                    disabled={disabled || pending || issue.hasReturnedShare}
                    onClick={() =>
                      void resolve(issue.operationId, "not_created")
                    }
                  >
                    已确认未创建
                  </Button>
                  <Button
                    quiet
                    size="compact"
                    disabled={disabled || pending}
                    onClick={() => void resolve(issue.operationId, "handled")}
                  >
                    已处理该分享
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </details>
      ) : null}
      {feedback ? <Notice>{feedback}</Notice> : null}
      {error ? <Notice danger>{error}</Notice> : null}
    </section>
  );
}

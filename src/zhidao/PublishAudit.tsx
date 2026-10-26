import type { OperationRun } from "../../shared/zhidao";
import type { ZhidaoPublishReceipt } from "../../shared/zhidao-publishing";
import { Button, Notice, Status } from "../ui/primitives";
import { formatTime } from "../lib/format";
import { useOperationAction } from "./hooks";
import { useState } from "react";
import { QueryError } from "../ui/QueryError";

export function PublishAudit({
  run,
  onChanged,
}: {
  run: OperationRun;
  onChanged(): void;
}) {
  const action = useOperationAction();
  const [failure, setFailure] = useState("");
  const sync = () => {
    setFailure("");
    void action.run(
      "zhidao.publish.sync",
      { id: run.id },
      onChanged,
      undefined,
      (error) => setFailure(error.message),
    );
  };
  const receipts = Array.isArray(run.config.platformTasks)
    ? (run.config.platformTasks as ZhidaoPublishReceipt[])
    : [];
  return (
    <section className="publish-audit" aria-label="平台审核记录">
      <div className="publish-audit-toolbar">
        <strong>平台审核</strong>
        <Button
          size="compact"
          disabled={!!action.pending || run.status === "running"}
          onClick={sync}
        >
          {action.pending === "zhidao.publish.sync"
            ? "正在查询…"
            : "查询平台审核"}
        </Button>
        <Button
          quiet
          size="compact"
          disabled={!!action.pending || run.status === "running"}
          onClick={() => void action.run("zhidao.publish.open", { id: run.id })}
        >
          打开答主工作台
        </Button>
      </div>
      <QueryError
        error={failure}
        loading={action.pending === "zhidao.publish.sync"}
        onRetry={sync}
        title="平台审核记录暂时无法读取"
      />
      {receipts.length ? (
        receipts.map((receipt) => (
          <div className="publish-audit-record" key={receipt.id}>
            <span>任务ID：{receipt.id}</span>
            <Status
              kind={
                receipt.status === "finished" && !receipt.failCount
                  ? "good"
                  : receipt.status === "finished" ||
                      receipt.status === "unknown"
                    ? "warning"
                    : "normal"
              }
            >
              {
                {
                  pending: "待执行",
                  running: "审核处理中",
                  finished: "审核完成",
                  unknown: "状态待核对",
                }[receipt.status]
              }
            </Status>
            <span>
              通过 {receipt.successCount ?? "待确认"} · 失败{" "}
              {receipt.failCount ?? "待确认"} · 使用额度{" "}
              {receipt.usedQuota ?? "待确认"}
            </span>
            <small>查询于 {formatTime(receipt.checkedAt)}</small>
          </div>
        ))
      ) : (
        <p>
          上传回执与平台审核分别记录。查询使用本任务绑定账号，不会重新上传。
        </p>
      )}
      {!failure &&
      Number(run.config.platformMissingCount) > 0 &&
      typeof run.config.platformCheckMessage === "string" ? (
        <Notice warning>{run.config.platformCheckMessage}</Notice>
      ) : null}
    </section>
  );
}

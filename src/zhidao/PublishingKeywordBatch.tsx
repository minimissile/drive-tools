import { Check, Search } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../ui/primitives";
import { Select } from "../ui/Select";
import { QueryError } from "../ui/QueryError";
import { useKeywordAccount } from "../resources/useKeywordAccount";
import type { usePublishingKeywordBatch } from "./usePublishingKeywordBatch";

export function PublishingKeywordBatch({
  model,
  count,
  disabled,
  children,
}: {
  model: ReturnType<typeof usePublishingKeywordBatch>;
  count: number;
  disabled: boolean;
  children?: ReactNode;
}) {
  const {
    accounts,
    choices,
    account,
    setAccountId,
    accountAvailable,
    checkingAccount,
  } = useKeywordAccount();
  const batch = model.batch;
  const done =
    batch?.items.filter((item) => ["completed", "failed"].includes(item.status))
      .length ?? 0;
  const issues =
    batch?.items.flatMap((item) => [
      ...(item.message ? [`${item.title}：${item.message}`] : []),
      ...(item.result?.issues.map(
        (issue) => `${item.title}：${issue.message}`,
      ) ?? []),
    ]) ?? [];
  return (
    <div className="publishing-keyword-batch">
      <div className="publishing-keyword-batch-tools">
        {children}
        {choices.length > 1 && (count > 0 || model.running) ? (
          <Select
            aria-label="批量拓词账号"
            value={account?.id ?? ""}
            onValueChange={setAccountId}
            disabled={model.running}
            items={choices.map((item) => ({
              value: item.id,
              label: item.alias,
            }))}
          />
        ) : null}
        {!count && !model.running ? (
          <span className="publishing-keyword-ready">
            <Check size={14} aria-hidden="true" />
            关键词已齐备
          </span>
        ) : (
          <Button
            primary
            disabled={
              disabled ||
              checkingAccount ||
              !!accounts.error ||
              model.running ||
              !count
            }
            onClick={() =>
              model.start(accountAvailable ? account.id : undefined)
            }
            title="并行检索待查资源，已有关键词跳过；结果按资源分别保存。"
          >
            <Search size={15} />
            {model.running
              ? `正在检索 ${done} / ${batch?.items.length ?? count} 份`
              : `批量检索待查资源（${count}）`}
          </Button>
        )}
      </div>
      {batch ? (
        <p className="publishing-help" role="status">
          {batch.status === "running"
            ? "检索中，可以先检查已返回资源的关键词。"
            : batch.status === "interrupted"
              ? "上次检索已中断，已返回结果保留；可点击批量检索继续待查资源。"
              : `已完成${done}份检索，请逐份检查候选词。`}
        </p>
      ) : null}
      {issues.length ? (
        <details>
          <summary>查看检索提示（{issues.length}）</summary>
          <ul>
            {issues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <QueryError
        error={accounts.error}
        loading={accounts.loading}
        onRetry={accounts.reload}
      />
      <QueryError
        error={model.query.error}
        loading={model.query.loading}
        onRetry={model.query.reload}
      />
    </div>
  );
}

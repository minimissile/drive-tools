import { z } from "zod";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useEffect, useId, useRef } from "react";
import {
  ChevronDown,
  ChevronUp,
  RefreshCw,
  ShieldCheck,
  Square,
} from "lucide-react";
import {
  accountBatchItemLabel,
  accountBatchPolicy,
} from "../../shared/account-batch";
import type { AccountBatchController } from "./useAccountBatch";
import { Button, Notice } from "../ui/primitives";
import "./account-batch.css";
export function AccountBatchToolbar({
  batch,
  providerName,
  allowRefresh = false,
  disabled = false,
  storageKey,
}: {
  batch: AccountBatchController;
  providerName: string | null;
  allowRefresh?: boolean;
  disabled?: boolean;
  storageKey: string;
}) {
  const disclosure = useLocalDraft(storageKey, { expanded: false }, (value) =>
    z.object({ expanded: z.boolean() }).parse(value),
  );
  const expanded = disclosure.value.expanded;
  const contentId = useId();
  const checkbox = useRef<HTMLInputElement>(null);
  const selected = batch.eligible.filter((id) =>
    batch.selected.includes(id),
  ).length;
  useEffect(() => {
    if (checkbox.current)
      checkbox.current.indeterminate =
        selected > 0 && selected < batch.eligible.length;
  }, [selected, batch.eligible.length]);
  const blocked = disabled || batch.active || batch.submitting || !batch.ready;
  const current = batch.batch;
  const done =
    current?.items.filter((i) => !["queued", "running"].includes(i.status))
      .length ?? 0;
  const failed =
    current?.items.filter((i) => i.status === "failed").length ?? 0;
  const incomplete = current?.items.some((i) =>
    ["failed", "warning", "cancelled"].includes(i.status),
  );
  return (
    <section className="account-batch-toolbar" aria-label="账号批量操作">
      <div className="account-batch-heading">
        <Button
          quiet
          size="compact"
          className="account-batch-toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => disclosure.update({ expanded: !expanded })}
        >
          {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          <strong>批量操作</strong>
          <span>{expanded ? "收起" : "展开"}</span>
        </Button>
        {!expanded ? (
          <span className="muted">已选 {batch.selected.length} 个</span>
        ) : null}
        {current ? (
          <div className="account-batch-summary">
            <p role="status">
              最近任务：
              {current.providerName} ·{" "}
              {current.action === "verify" ? "批量核验" : "批量刷新"}：{done}/
              {current.items.length}，{failed} 个失败
              {current.status === "stopping"
                ? "，正在等待已启动的账号结束"
                : current.status === "interrupted"
                  ? "，上次运行已中断"
                  : current.status === "cancelled"
                    ? "，已停止排队"
                    : ""}
            </p>
            {batch.active ? (
              <Button
                size="compact"
                disabled={batch.submitting || current.status === "stopping"}
                onClick={() => void batch.stop()}
              >
                <Square size={12} />
                {current.status === "stopping" ? "正在停止…" : "停止排队"}
              </Button>
            ) : incomplete ? (
              <Button
                size="compact"
                disabled={disabled || batch.submitting}
                onClick={() => {
                  disclosure.update({ expanded: true });
                  void batch.retry();
                }}
              >
                重试未完成项
              </Button>
            ) : null}
          </div>
        ) : (
          <span className="account-batch-heading-hint muted">
            选择同类型账号进行批量核验
          </span>
        )}
      </div>
      {batch.error || disclosure.error ? (
        <Notice warning>{batch.error || disclosure.error}</Notice>
      ) : null}
      <div id={contentId} hidden={!expanded} className="account-batch-content">
        <div className="account-batch-actions">
          <label className="checkbox">
            <input
              ref={checkbox}
              type="checkbox"
              aria-label="全选当前筛选账号"
              checked={
                !!batch.eligible.length && selected === batch.eligible.length
              }
              disabled={blocked || !providerName || !batch.eligible.length}
              onChange={(e) => batch.selectVisible(e.target.checked)}
            />
            全选筛选结果
          </label>
          <span className="muted">已选 {batch.selected.length} 个</span>
          <Button
            size="compact"
            disabled={blocked || !providerName || !batch.selected.length}
            onClick={() => void batch.start("verify")}
          >
            <ShieldCheck size={14} />
            批量核验登录
          </Button>
          {allowRefresh ? (
            <Button
              size="compact"
              disabled={blocked || !providerName || !batch.selected.length}
              onClick={() => void batch.start("refresh")}
            >
              <RefreshCw size={14} />
              批量刷新容量和会员
            </Button>
          ) : null}
        </div>
        <p className="account-batch-hint">
          {providerName
            ? `${providerName} · 最多 ${accountBatchPolicy.concurrency} 个并发，启动随机错开 0.4–1 秒；共用环境串行。单批最多 ${accountBatchPolicy.maxAccounts} 个账号。`
            : "先切换到一种网盘或平台，再选择同类型账号进行批量操作。"}
        </p>
        {current ? (
          <div className="account-batch-progress">
            <ul
              className="account-batch-results"
              aria-label="批量账号逐项结果"
              tabIndex={0}
            >
              {current.items.map((item) => (
                <li key={item.id}>
                  <strong>{item.alias}</strong>
                  <span data-state={item.status}>
                    {accountBatchItemLabel[item.status]}
                  </span>
                  <span>{item.message}</span>
                </li>
              ))}
            </ul>
            {batch.active ? (
              <p className="account-batch-hint">
                停止排队只取消尚未启动的账号，正在核验的账号会完成本次操作。
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

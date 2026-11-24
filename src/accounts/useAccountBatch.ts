import { useEffect, useRef, useState } from "react";
import {
  accountBatchActive,
  accountBatchPolicy,
  type AccountBatch,
  type AccountBatchInput,
} from "../../shared/account-batch";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { updateSelection } from "../lib/selection";
export interface BatchSelectableAccount {
  id: string;
  alias: string;
  provider: string;
  enabled?: boolean;
}
export function useAccountBatch({
  scope,
  provider,
  accounts,
  visible,
  onFinished,
}: {
  scope: AccountBatchInput["scope"];
  provider: string | null;
  accounts: BatchSelectableAccount[];
  visible: BatchSelectableAccount[];
  onFinished(): void;
}) {
  const query = useIpcQuery("accountBatch.current", undefined, {
    keepPrevious: true,
    refreshInterval: 1000,
  });
  const [selected, setSelected] = useState<string[]>([]),
    [submitting, setSubmitting] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false),
    finished = useRef(""),
    callback = useRef(onFinished);
  callback.current = onFinished;
  const batch = query.data ?? null;
  const active = accountBatchActive(batch),
    eligible = visible.filter((a) => a.enabled !== false).map((a) => a.id);
  useEffect(() => {
    const valid = new Set(
      accounts
        .filter((a) => a.provider === provider && a.enabled !== false)
        .map((a) => a.id),
    );
    setSelected((old) => {
      const next = old.filter((id) => valid.has(id));
      return next.length === old.length ? old : next;
    });
  }, [accounts, provider]);
  useEffect(() => {
    if (batch && !accountBatchActive(batch) && finished.current !== batch.id) {
      finished.current = batch.id;
      callback.current();
    }
  }, [batch]);
  const command = async (action: () => Promise<AccountBatch>) => {
    if (lock.current) return;
    lock.current = true;
    setSubmitting(true);
    setError("");
    try {
      const result = await action();
      query.setData(result);
      query.reload();
    } catch (cause) {
      const text =
        cause instanceof Error ? cause.message : "批量操作未完成，请重试。";
      setError(
        /UNKNOWN_METHOD|未知.*(?:方法|请求)|不支持.*accountBatch/i.test(text)
          ? "请应用更新并重启后使用批量账号操作。"
          : text,
      );
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  };
  const start = (action: AccountBatchInput["action"], ids = selected) => {
    if (!provider || !ids.length) return Promise.resolve();
    return command(() =>
      ipc("accountBatch.start", { scope, provider, action, accountIds: ids }),
    );
  };
  return {
    batch,
    active,
    submitting,
    selected,
    eligible,
    error:
      error ||
      (query.error ? "批量功能暂未就绪，请应用更新并重启或稍后重试。" : ""),
    ready: query.data !== undefined && !query.error,
    select: (id: string, checked: boolean) => {
      if (
        checked &&
        !selected.includes(id) &&
        selected.length >= accountBatchPolicy.maxAccounts
      ) {
        setError(
          `单批最多选择 ${accountBatchPolicy.maxAccounts} 个账号，请先取消部分选择。`,
        );
        return;
      }
      setError("");
      setSelected((old) =>
        updateSelection(old, [id], checked, accountBatchPolicy.maxAccounts),
      );
    },
    selectVisible: (checked: boolean) => {
      setError(
        checked &&
          new Set([...selected, ...eligible]).size >
            accountBatchPolicy.maxAccounts
          ? `单批最多选择 ${accountBatchPolicy.maxAccounts} 个账号，本次已选入前 ${accountBatchPolicy.maxAccounts} 个。`
          : "",
      );
      setSelected((old) =>
        updateSelection(old, eligible, checked, accountBatchPolicy.maxAccounts),
      );
    },
    start,
    stop: () =>
      batch
        ? command(() => ipc("accountBatch.stop", { id: batch.id }))
        : Promise.resolve(),
    retry: () => {
      if (!batch) return Promise.resolve();
      const ids = batch.items
        .filter((i) => ["failed", "warning", "cancelled"].includes(i.status))
        .map((i) => i.id);
      if (!ids.length) return Promise.resolve();
      return command(() =>
        ipc("accountBatch.start", {
          scope: batch.scope,
          provider: batch.provider,
          action: batch.action,
          accountIds: ids,
        }),
      );
    },
    status: (id: string) =>
      batch?.scope === scope
        ? batch.items.find((i) => i.id === id)?.status
        : undefined,
  };
}
export type AccountBatchController = ReturnType<typeof useAccountBatch>;

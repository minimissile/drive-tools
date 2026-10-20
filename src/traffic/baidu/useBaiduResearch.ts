import { useEffect, useRef, useState } from "react";
import {
  baiduResearchInputSchema,
  type BaiduResearchInput,
  type BaiduResearchResult,
} from "../../../shared/baidu-research";
import { ipc } from "../../api/client";
import { useIpcQuery } from "../../api/useIpcQuery";
export function useBaiduResearch(
  accountId: string,
  operation: BaiduResearchInput["operation"],
  uid: string | null | undefined,
) {
  const latest = useIpcQuery(
    "baiduResearch.latest",
    { accountId, operation },
    { enabled: !!accountId, revision: uid },
  );
  const [completed, setCompleted] = useState<BaiduResearchResult | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const current = useRef({ accountId, uid, operation }),
    alive = useRef(true),
    lock = useRef(false);
  current.current = { accountId, uid, operation };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const result =
    [completed, latest.data]
      .filter(
        (r): r is BaiduResearchResult =>
          !!r &&
          r.input.accountId === accountId &&
          r.accountUid === uid &&
          r.input.operation === operation,
      )
      .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))[0] ?? null;
  const run = async (input: Partial<BaiduResearchInput>, show = true) => {
    if (lock.current) return null;
    const parsed = baiduResearchInputSchema.safeParse({
      accountId,
      operation,
      ...input,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "请检查查询条件。");
      return null;
    }
    lock.current = true;
    setPending(true);
    setError("");
    try {
      const next = await ipc("baiduResearch.run", parsed.data);
      if (
        alive.current &&
        current.current.accountId === accountId &&
        current.current.uid === uid &&
        show &&
        next.input.operation === current.current.operation
      )
        setCompleted(next);
      return next;
    } catch (cause) {
      if (alive.current && current.current.accountId === accountId)
        setError(cause instanceof Error ? cause.message : "百度操作失败。");
      return null;
    } finally {
      lock.current = false;
      if (alive.current) setPending(false);
    }
  };
  return {
    latest,
    result,
    pending,
    error,
    run,
    clearError: () => setError(""),
  };
}

import { useEffect, useState } from "react";
import {
  parseResourceKeywordSeeds,
  parseResourceKeywordText,
  keywordBatchSchema,
} from "../../shared/resource-keywords";
import { useAppActions } from "../state";
import { useIpcQuery } from "../api/useIpcQuery";
import { useOperationAction } from "./hooks";
import type { PublishingDraft, PublishingDraftRow } from "./publishing-draft";

export function usePublishingKeywordBatch(
  value: PublishingDraft,
  update: (patch: Partial<PublishingDraft>) => void,
  onRows: (rows: PublishingDraftRow[]) => void,
) {
  const action = useOperationAction();
  const { notify } = useAppActions();
  const [polling, setPolling] = useState(true);
  const query = useIpcQuery(
    "resource.keywordBatchStatus",
    { id: value.keywordBatchId },
    { enabled: !!value.keywordBatchId, refreshInterval: polling ? 1500 : 0 },
  );
  const batch = query.data?.id === value.keywordBatchId ? query.data : null;
  useEffect(() => {
    if (batch && batch.status !== "running") setPolling(false);
  }, [batch]);
  useEffect(() => {
    if (!batch) return;
    const ready = batch.items.filter(
      (item) =>
        item.status === "completed" &&
        !value.keywordBatchApplied.includes(item.id),
    );
    if (!ready.length) return;
    const rows = value.rows.map((row) => {
      const item = ready.find((item) => item.id === row.key);
      const seeds = parseResourceKeywordSeeds(
        row.keywords.seeds || row.title.slice(0, 100),
      );
      // Do not overwrite a resource renamed, edited or already confirmed while the read was running.
      if (
        !item?.result ||
        row.checked ||
        item.title !== row.title ||
        JSON.stringify(item.seeds) !== JSON.stringify(seeds)
      )
        return row;
      const text = parseResourceKeywordText(
        [
          row.keywords.text,
          ...item.result.candidates.map((word) => word.word),
        ].join("\n"),
      ).join("\n");
      return { ...row, keywords: { ...row.keywords, text } };
    });
    onRows(rows);
    update({
      keywordBatchApplied: [
        ...value.keywordBatchApplied,
        ...ready.map((item) => item.id),
      ].slice(-50),
    });
  }, [batch, value.rows, value.keywordBatchApplied, onRows, update]);
  return {
    query,
    batch,
    running: !!action.pending || batch?.status === "running",
    start(accountId?: string) {
      const id = crypto.randomUUID();
      const items = value.rows
        .filter((row) => !row.checked)
        .map((row) => ({
          id: row.key,
          title: row.title,
          seeds: parseResourceKeywordSeeds(
            row.keywords.seeds || row.title.slice(0, 100),
          ),
        }));
      if (!items.length) return;
      const parsed = keywordBatchSchema.safeParse({
        id,
        items,
        ...(accountId ? { baiduAccountId: accountId } : {}),
      });
      if (!parsed.success) {
        notify(
          "部分资源的搜索词无效，请逐份检查；每份最多5个搜索词。",
          "error",
        );
        return;
      }
      setPolling(true);
      update({ keywordBatchId: id, keywordBatchApplied: [] });
      void action.run("resource.keywordBatch", parsed.data, () =>
        query.reload(),
      );
    },
  };
}

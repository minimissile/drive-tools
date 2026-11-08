import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  knowledgeFilter,
  type KnowledgeFilter,
  type KnowledgeItem,
} from "../../shared/traffic-knowledge";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { updateSelection } from "../lib/selection";
import { useAppActions, useAppData } from "../state";
import { keywordMetrics } from "./knowledge";

const selectedItem = z.object({
  id: z.string(),
  entryId: z.string().optional(),
  queryId: z.string(),
  kind: z.string(),
  word: z.string(),
  platform: z.string().nullable(),
  source: z.string(),
  metrics: z.record(z.string(), z.unknown()),
  observedAt: z.string().nullable(),
  firstObservedAt: z.string().nullable(),
  sourceUpdatedAt: z.string().nullable(),
  observations: z.number(),
});
const draftSchema = z.object({
  input: z.string().max(200),
  filter: knowledgeFilter,
  poolName: z.string().max(100),
  selected: z.array(selectedItem).max(1000),
  cursors: z.record(z.string(), z.string().nullable()).default({ "1": null }),
});
export const libraryEntryKey = (item: KnowledgeItem) => item.entryId ?? item.id;
export function useTrafficLibrary() {
  const { data } = useAppData();
  const { command, notify } = useAppActions();
  const editor = useLocalDraft(
    `panxu-traffic-library-v1:${data!.dataPath}`,
    {
      input: "",
      filter: knowledgeFilter.parse({ cursor: null }),
      poolName: "",
      selected: [] as KnowledgeItem[],
      cursors: { "1": null } as Record<string, string | null>,
    },
    (value) =>
      draftSchema.parse(value) as {
        input: string;
        filter: KnowledgeFilter;
        poolName: string;
        selected: KnowledgeItem[];
        cursors: Record<string, string | null>;
      },
  );
  const { input, filter, poolName, selected, cursors } = editor.value;
  const revision = useRef(0);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const update: typeof editor.update = (patch) => {
    revision.current++;
    editor.update(patch);
  };
  const query = useIpcQuery("traffic.knowledge.list", filter, {
    keepPrevious: true,
  });
  const selectedIds = selected.map((item) => item.id);
  const resolved = useIpcQuery(
    "traffic.knowledge.resolve",
    { observationIds: selectedIds },
    {
      enabled: selectedIds.length > 0,
    },
  );
  useEffect(() => {
    if (!resolved.data) return;
    const identities = new Map(
      resolved.data.items.map((item) => [item.id, item.entryId]),
    );
    const keys = new Set<string>();
    const repaired = selected.flatMap((item) => {
      const entryId = identities.get(item.id);
      const snapshot =
        entryId && entryId !== item.entryId ? { ...item, entryId } : item;
      const key = libraryEntryKey(snapshot);
      if (keys.has(key)) return [];
      keys.add(key);
      return [snapshot];
    });
    if (
      repaired.length !== selected.length ||
      repaired.some((item, index) => item !== selected[index])
    ) {
      // Repair identity only: selected metrics remain the frozen observation.
      revision.current++;
      editor.update({ selected: repaired });
    }
  }, [resolved.data, selected, editor.update]);
  const [detail, setDetail] = useState<KnowledgeItem | null>(null);
  const updateFilter = (patch: Partial<KnowledgeFilter>) => {
    const changesSet = Object.keys(patch).some(
      (key) =>
        !["page", "sort", "cursor"].includes(key) &&
        patch[key as keyof KnowledgeFilter] !==
          filter[key as keyof KnowledgeFilter],
    );
    update({
      filter: { ...filter, ...patch, page: 1, cursor: null },
      cursors: { "1": null },
      ...(changesSet ? { selected: [] } : {}),
    });
    setDetail(null);
  };
  const changePage = (page: number) => {
    const nextCursor =
      page === filter.page + 1 ? query.data?.nextCursor : cursors[String(page)];
    // Undefined preserves old-backend/page-number compatibility until applied.
    const cursor =
      nextCursor ?? (nextCursor === null && page === 1 ? null : undefined);
    update({
      filter: { ...filter, page, cursor },
      cursors:
        cursor !== undefined ? { ...cursors, [String(page)]: cursor } : cursors,
    });
    setDetail(null);
  };
  const select = (items: KnowledgeItem[], checked: boolean) => {
    const keys = updateSelection(
      selected.map(libraryEntryKey),
      items.map(libraryEntryKey),
      checked,
    );
    if (keys.length > 1000) {
      notify("每次最多选择1000项，请分批整理。", "warning");
      return;
    }
    const snapshots = new Map(
      [...items, ...selected].map((item) => [libraryEntryKey(item), item]),
    );
    update({ selected: keys.map((key) => snapshots.get(key)!) });
  };
  const savePool = async () => {
    const submittedRevision = revision.current;
    const saved = await command("pool.save", {
      name:
        poolName.trim() || `${selected[0]?.word.slice(0, 30) ?? "精选"}词池`,
      resourceId: null,
      keywords: selected.map((item) => ({
        id: item.id,
        word: item.word,
        platform: item.platform,
        source: item.source,
        metrics: keywordMetrics(item.metrics),
        sourceUpdatedAt: item.sourceUpdatedAt,
        fetchedAt: item.observedAt ?? "",
      })),
    });
    if (saved) {
      if (active.current && revision.current === submittedRevision)
        update({ selected: [], poolName: "" });
      notify("词池已保存，可在“我的词池”中复用。", "success");
    }
    return saved;
  };
  return {
    ...query,
    input,
    setInput: (input: string) => update({ input }),
    filter,
    updateFilter,
    changePage,
    selected,
    select,
    clear: () => update({ selected: [] }),
    poolName,
    setPoolName: (poolName: string) => update({ poolName }),
    savePool,
    detail,
    setDetail,
    draftError: editor.error,
    selectionError: resolved.error,
    selectionLoading: resolved.loading,
    retrySelection: resolved.reload,
    missingSelectionCount: resolved.data?.missingIds.length ?? 0,
  };
}

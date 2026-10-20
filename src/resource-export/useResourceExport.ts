import type { ExportFormat } from "../../shared/ipc-commands";
import { useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "../api/client";
import { useAppActions } from "../state";
import type {
  ExportRun,
  ExportColumn,
  ExportArticle,
} from "../../shared/resource-export";
import { useExportInput } from "./useExportInput";
export function useResourceExport(dataPath: string) {
  const { command, notify } = useAppActions();
  const input = useExportInput(dataPath);
  const {
    initialEditor,
    request,
    setRequest,
    images,
    setImages,
    setMissingImages,
    setPlanError,
    scope,
    setScope,
    category,
    setCategory,
    provider,
    setProvider,
    accountId,
    setAccountId,
    archivedOnly,
    setArchivedOnly,
  } = input;
  const [historyError, setHistoryError] = useState("");
  const [historyRevision, setHistoryRevision] = useState(0);
  const [history, setHistory] = useState<ExportRun[]>([]),
    [run, setRun] = useState<ExportRun | null>(null),
    [columns, setColumns] = useState<ExportColumn[]>([]),
    [criteria, setCriteria] = useState(""),
    [brief, setBrief] = useState("");
  const [selected, setSelected] = useState<string[]>([]),
    [format, setFormat] = useState<ExportFormat>("xlsx"),
    [article, setArticle] = useState<ExportArticle | null>(null),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(1);
  const [working, setWorking] = useState(false),
    [scanning, setScanning] = useState(false),
    [uploading, setUploading] = useState(false),
    [loading, setLoading] = useState(true);
  const [showExcluded, setShowExcluded] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null),
    continueScan = useRef(false),
    mounted = useRef(true);
  const adopt = (r: ExportRun, restoreInput = true) => {
    setHistoryError("");
    if (restoreInput) {
      setRequest(r.input.request);
      setScope(r.input.scope);
      setCategory(r.input.category);
      setProvider(r.input.provider);
      setAccountId(r.input.accountId);
      setArchivedOnly(r.input.archivedOnly);
      setImages([]);
      setMissingImages(r.input.imageCount);
      setPlanError("");
    }
    setRun(r);
    setColumns(r.plan.columns);
    setCriteria(r.plan.criteria);
    setBrief(r.plan.articleBrief);
    setSelected(r.article ? r.articleSelection : r.records.map((v) => v.id));
    setArticle(r.article);
    setPage(1);
    setQuery("");
    setShowExcluded(false);
  };
  useEffect(() => {
    mounted.current = true;
    setLoading(true);
    setHistoryError("");
    void ipc("resourceExport.history")
      .then(async (list) => {
        if (!mounted.current) return;
        setHistory(list);
        if (list[0]) {
          const latest = await ipc("resourceExport.get", { runId: list[0].id });
          if (mounted.current) adopt(latest, !initialEditor);
        }
      })
      .catch((e) => {
        if (mounted.current) {
          setHistoryError(e.message);
        }
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
      continueScan.current = false;
    };
  }, [historyRevision]);
  const locked = working || scanning || uploading || loading;
  const refreshHistory = async () => {
    const list = await ipc("resourceExport.history");
    if (mounted.current) setHistory(list);
  };
  const addImages = async (files: File[]) => {
    if (locked) return;
    setUploading(true);
    try {
      const additions: { name: string; data: string }[] = [];
      for (const file of files.slice(0, 3 - images.length)) {
        if (
          !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
          file.size > 8 * 1024 * 1024
        )
          throw new Error("请选择8MB以内的PNG、JPEG或WebP图片。");
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height)),
          canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法读取参考图片。");
        context.fillStyle = "white";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        additions.push({
          name: file.name || "粘贴的截图",
          data: canvas.toDataURL("image/jpeg", 0.9),
        });
      }
      setImages((old) => [...old, ...additions].slice(0, 3));
      if (additions.length) setMissingImages(0);
      if (files.length > 3 - images.length)
        notify("每次需求最多添加3张参考图片。", "warning");
    } catch (e) {
      notify(e instanceof Error ? e.message : "图片读取失败", "error");
    } finally {
      setUploading(false);
    }
  };
  const createPlan = async () => {
    setWorking(true);
    setPlanError("");
    try {
      const result = await command(
        "resourceExport.plan",
        {
          request,
          images: images.map((v) => v.data),
          scope,
          category,
          provider,
          accountId,
          archivedOnly,
        },
        undefined,
        true,
      );
      if (result && mounted.current) {
        adopt(result, false);
        await refreshHistory();
      }
    } catch (error) {
      if (mounted.current)
        setPlanError(
          error instanceof Error ? error.message : "需求解析失败，请重试。",
        );
    } finally {
      if (mounted.current) setWorking(false);
    }
  };
  const scan = async () => {
    if (!run) return;
    continueScan.current = true;
    setScanning(true);
    try {
      let current = run;
      if (!run.scanned) {
        current = await ipc("resourceExport.updatePlan", {
          runId: run.id,
          plan: { ...run.plan, columns, criteria, articleBrief: brief },
        });
      }
      while (continueScan.current && current.state !== "completed") {
        current = await ipc("resourceExport.step", {
          runId: run.id,
        });
        if (mounted.current) {
          setRun(current);
          setSelected(current.records.map((r) => r.id));
        }
        if (current.state === "failed") break;
      }
      await refreshHistory();
    } catch (e) {
      if (mounted.current)
        notify(e instanceof Error ? e.message : "筛选失败", "error");
    } finally {
      continueScan.current = false;
      if (mounted.current) setScanning(false);
    }
  };
  const filtered = useMemo(
    () =>
      (showExcluded ? (run?.excluded ?? []) : (run?.records ?? [])).filter(
        (r) =>
          `${r.title} ${r.category} ${r.tags} ${r.reason}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [run?.records, run?.excluded, showExcluded, query],
  );
  const rows = filtered.slice((page - 1) * 25, page * 25),
    selectedSet = useMemo(() => new Set(selected), [selected]);
  const articleStale =
    !!article &&
    (!run ||
      run.articleSelection.length !== selected.length ||
      run.articleSelection.some((id) => !selectedSet.has(id)));
  const changeColumn = (index: number, patch: Partial<ExportColumn>) =>
    setColumns((old) =>
      old.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    );
  const moveColumn = (index: number, delta: number) =>
    setColumns((old) => {
      const next = [...old];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      return next;
    });
  return {
    ...input,
    history,
    historyError,
    retryHistory: () => setHistoryRevision((n) => n + 1),
    setHistory,
    run,
    setRun,
    columns,
    setColumns,
    criteria,
    setCriteria,
    brief,
    setBrief,
    selected,
    setSelected,
    format,
    setFormat,
    article,
    setArticle,
    query,
    setQuery,
    page,
    setPage,
    working,
    setWorking,
    scanning,
    uploading,
    loading,
    showExcluded,
    setShowExcluded,
    imageInput,
    continueScan,
    mounted,
    adopt,
    locked,
    refreshHistory,
    addImages,
    createPlan,
    scan,
    filtered,
    rows,
    selectedSet,
    articleStale,
    changeColumn,
    moveColumn,
  };
}
export type ExportModel = ReturnType<typeof useResourceExport>;

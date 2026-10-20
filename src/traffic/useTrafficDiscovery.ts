import { z } from "zod";
import { useLocalDraft } from "../hooks/useLocalDraft";
import { useAppData } from "../state";
import { useRef, useState } from "react";

import { useAppActions, useAppSelection } from "../state";

import type { Endpoint, Keyword, TrafficResult } from "../../shared/types";
export function useTrafficDiscovery() {
  const queryInput = useRef<HTMLTextAreaElement>(null);
  const { resource } = useAppSelection(),
    { command, notify } = useAppActions();
  const { data } = useAppData();
  const editor = useLocalDraft(
    `panxu-traffic-input-v1:${data!.dataPath}`,
    { manualName: "", manualWords: "", seeds: "" },
    (value) =>
      z
        .object({
          manualName: z.string(),
          manualWords: z.string(),
          seeds: z.string(),
        })
        .parse(value),
  );
  const { manualName, manualWords, seeds } = editor.value;
  const setManualName = (manualName: string) => editor.update({ manualName });
  const setManualWords = (manualWords: string) =>
    editor.update({ manualWords });
  const setSeeds = (seeds: string) => editor.update({ seeds });
  const [manualBound, setManualBound] = useState(true);
  const [tab, setTab] = useState<"words" | "baidu" | "hotspots" | "costs" | "knowledge">(
      "words",
    ),
    [method, setMethod] = useState<Endpoint>("longtail"),
    [pages, setPages] = useState(1),
    [platform, setPlatform] = useState("xiaohongshu"),
    [useCache, setUseCache] = useState(true),
    [result, setResult] = useState<TrafficResult | null>(null),
    [queryFeedback, setQueryFeedback] = useState<string | null>(null),
    [allowSuggestionRequest, setAllowSuggestionRequest] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [poolName, setPoolName] = useState(""),
    [hotType, setHotType] = useState(""),
    [start, setStart] = useState(""),
    [end, setEnd] = useState("");
  const query = async (endpoint: Endpoint, taskId?: string) => {
    setQueryFeedback(null);
    setResult(null);
    const words = seeds
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const res = await command("traffic.query", {
      endpoint,
      seeds: words,
      pages,
      platform,
      useCache,
      type: hotType,
      startTime: start.replace("T", " ") + (start ? ":00" : ""),
      endTime: end.replace("T", " ") + (end ? ":00" : ""),
      taskId,
    });
    if (res) {
      setResult(res);
      setSelected([]);
      if (res.pending)
        notify(
          endpoint === "suggest"
            ? "下拉词分析记录已保存。已有未完成记录会直接复用，不会自动重发请求。"
            : "任务已提交。请至少等待60秒后获取结果，避免重复提交。",
          "info",
        );
      else if (!res.keywords.length && !res.hotspots.length)
        setQueryFeedback(
          "接口已返回，本次没有候选结果。可在调用与费用中核对请求记录。",
        );
    } else
      setQueryFeedback(
        "查询未完成。请先在“调用与费用”查看接口返回及待核费用，避免重复提交造成再次计费。",
      );
  };
  const extract = async () => {
    if (!resource) return;
    const res = await command("ai.keywords", { resourceId: resource.id });
    if (res) setSeeds(res.keywords.map((k) => k.word).join("，"));
  };
  const savePool = async (
    keywords: Keyword[] = result?.keywords.filter((k) =>
      selected.includes(k.id),
    ) ?? [],
  ) => {
    const p = await command(
      "pool.save",
      {
        name:
          poolName.trim() || `${resource?.title.slice(0, 20) ?? "新发现"}词池`,
        resourceId: resource?.id ?? null,
        keywords,
      },
      "词池已保存到本地，可用于生成内容。",
    );
    if (p) setPoolName("");
  };
  return {
    inputError: editor.error,
    queryInput,
    manualName,
    setManualName,
    manualWords,
    setManualWords,
    manualBound,
    setManualBound,
    tab,
    setTab,
    method,
    setMethod,
    seeds,
    setSeeds,
    pages,
    setPages,
    platform,
    setPlatform,
    useCache,
    setUseCache,
    result,
    setResult,
    queryFeedback,
    setQueryFeedback,
    allowSuggestionRequest,
    setAllowSuggestionRequest,
    selected,
    setSelected,
    poolName,
    setPoolName,
    hotType,
    setHotType,
    start,
    setStart,
    end,
    setEnd,
    query,
    extract,
    savePool,
  };
}
export type TrafficModel = ReturnType<typeof useTrafficDiscovery>;

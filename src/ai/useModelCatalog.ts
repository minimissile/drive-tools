import { useEffect, useRef, useState } from "react";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import type { AiCatalog } from "../../shared/ai-models";

const empty: AiCatalog = { text: [], media: [] };
export function useModelCatalog() {
  const query = useIpcQuery("ai.modelCatalog", undefined, {
    keepPrevious: true,
  });
  const [refreshed, setRefreshed] = useState<AiCatalog | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const active = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const catalog = refreshed ?? query.data ?? empty;
  const refresh = async () => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setRefreshing(true);
    const [text, media] = await Promise.allSettled([
      ipc("ai.models"),
      ipc("studio.models"),
    ]);
    inFlight.current = false;
    if (!active.current) return false;
    const next = {
      text: text.status === "fulfilled" ? text.value : catalog.text,
      media: media.status === "fulfilled" ? media.value : catalog.media,
    };
    setRefreshed(next);
    const failures = [
      text.status === "rejected" ? "文字模型" : "",
      media.status === "rejected" ? "图片与视频模型" : "",
    ].filter(Boolean);
    setRefreshError(
      failures.length
        ? `${failures.join("、")}刷新失败，已保留旧目录及当前选择。请检查网络后重试。`
        : "",
    );
    setRefreshing(false);
    return failures.length === 0
      ? {
          catalog: next,
          priceFailures:
            media.status === "fulfilled"
              ? media.value.filter((m) => m.pricingError).length
              : 0,
        }
      : false;
  };
  return {
    catalog,
    refresh,
    refreshing,
    loading: query.loading && !refreshed,
    error: refreshError || (!refreshed ? query.error : ""),
    retry: refreshError ? refresh : query.reload,
  };
}

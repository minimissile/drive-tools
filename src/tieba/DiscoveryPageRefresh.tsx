import { RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import type { TiebaDiscoveryRefresh } from "../../shared/tieba-resource-discovery";
import { ipc } from "../api/client";
import { useFeedbackActions } from "../state/feedback";
import { Button } from "../ui/primitives";

export function DiscoveryPageRefresh({
  request,
  disabled = false,
  onRefresh,
}: {
  request?: TiebaDiscoveryRefresh;
  disabled?: boolean;
  onRefresh: () => void;
}) {
  const { notify } = useFeedbackActions();
  const locked = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const count =
    request &&
    (request.kind === "sources" ? request.names.length : request.ids.length);

  async function refresh() {
    if (!request) {
      onRefresh();
      return;
    }
    if (locked.current || !count) return;
    locked.current = true;
    setRefreshing(true);
    try {
      const { updated, failed } = await ipc("tieba.discovery.refresh", request);
      onRefresh();
      if (failed)
        notify(`已刷新 ${updated} 项，${failed} 项暂未读全`, "warning");
      else notify(`已刷新 ${updated} 项`, "success");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "刷新失败，请重试。";
      notify(
        /UNKNOWN_METHOD|不支持此操作|未注册.*操作/.test(message)
          ? "请在顶部点击「应用更新并重启」，然后重试。"
          : message,
        "error",
      );
    } finally {
      setRefreshing(false);
      locked.current = false;
    }
  }

  return (
    <Button
      size="compact"
      disabled={disabled || refreshing || (request !== undefined && !count)}
      onClick={() => void refresh()}
    >
      <RefreshCw size={14} aria-hidden="true" />
      {refreshing ? "正在刷新…" : "刷新本页"}
    </Button>
  );
}
